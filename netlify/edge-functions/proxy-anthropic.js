// Proxies POST /api/proxy/anthropic/stream to Anthropic's API with SSE streaming.
// Ported from apps/daemon/src/chat-routes.ts for Netlify Edge Function deployment.

function validateBaseUrl(baseUrl) {
  let parsed;
  try { parsed = new URL(String(baseUrl).replace(/\/+$/, '')); } catch { return { error: 'Invalid baseUrl' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return { error: 'Only http/https allowed' };
  const h = parsed.hostname.toLowerCase();
  if (h === 'localhost' || h === '::1' || /^127\./.test(h) || /^10\./.test(h) ||
      /^192\.168\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) {
    return { error: 'Internal IPs blocked', forbidden: true };
  }
  return { parsed };
}

function appendVersionedApiPath(baseUrl, suffix) {
  const url = new URL(baseUrl);
  const trimmed = url.pathname.replace(/\/+$/, '');
  url.pathname = /\/v\d+(\/|$)/.test(trimmed) ? `${trimmed}${suffix}` : `${trimmed}/v1${suffix}`;
  return url.toString();
}

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = body ?? {};
  if (!baseUrl || !apiKey || !model) {
    return new Response(JSON.stringify({ error: { message: 'baseUrl, apiKey, and model are required' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const validated = validateBaseUrl(baseUrl);
  if (validated.error) {
    return new Response(JSON.stringify({ error: { message: validated.error } }), {
      status: validated.forbidden ? 403 : 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = appendVersionedApiPath(baseUrl, '/messages');
  const payload = {
    model,
    max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
    messages: Array.isArray(messages) ? messages : [],
    stream: true,
  };
  if (typeof systemPrompt === 'string' && systemPrompt) payload.system = systemPrompt;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      const error = (msg, code = 'UPSTREAM_UNAVAILABLE') => {
        enqueue('error', { message: msg, error: { code, message: msg } });
      };

      enqueue('start', { model });
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(payload),
          redirect: 'error',
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          error(`Upstream error: ${response.status}`, response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE');
          controller.close();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let ended = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          while (true) {
            const match = buf.match(/\r?\n\r?\n/);
            if (!match || match.index === undefined) break;
            const frame = buf.slice(0, match.index);
            buf = buf.slice(match.index + match[0].length);

            const lines = frame.replace(/\r/g, '').split('\n');
            let event = 'message';
            const dataLines = [];
            for (const line of lines) {
              if (line.startsWith('event:')) { event = line.slice(6).trim(); continue; }
              if (!line.startsWith('data:')) continue;
              let v = line.slice(5);
              if (v.startsWith(' ')) v = v.slice(1);
              dataLines.push(v);
            }
            const raw = dataLines.join('\n');
            if (!raw || raw === '[DONE]') continue;
            let data;
            try { data = JSON.parse(raw); } catch { continue; }

            if (event === 'error' || data?.type === 'error') {
              const msg = data?.error?.message ?? data?.message ?? 'Anthropic upstream error';
              error(msg);
              ended = true;
              break;
            }
            if (event === 'content_block_delta' && typeof data?.delta?.text === 'string') {
              enqueue('delta', { delta: data.delta.text });
            }
            if (event === 'message_stop') {
              enqueue('end', {});
              ended = true;
              break;
            }
          }
          if (ended) break;
        }

        if (!ended) enqueue('end', {});
      } catch (err) {
        error(err?.message ?? 'Internal error', 'INTERNAL_ERROR');
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
};
