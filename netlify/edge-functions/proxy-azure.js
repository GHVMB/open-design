// Proxies POST /api/proxy/azure/stream to Azure OpenAI with SSE streaming.

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

function sseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export default async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

  const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens, apiVersion } = body ?? {};
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

  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const versioned = /\/openai\/v\d+(?:$|\/)/.test(basePath);
  const ver = (typeof apiVersion === 'string' && apiVersion.trim()) ? apiVersion.trim() : (versioned ? '' : '2024-10-21');
  url.pathname = versioned
    ? `${basePath}/chat/completions`
    : `${basePath}/openai/deployments/${encodeURIComponent(model)}/chat/completions`;
  if (ver) url.searchParams.set('api-version', ver);

  const payloadMessages = Array.isArray(messages) ? [...messages] : [];
  if (typeof systemPrompt === 'string' && systemPrompt) payloadMessages.unshift({ role: 'system', content: systemPrompt });
  const payload = {
    ...(versioned ? { model } : {}),
    messages: payloadMessages,
    max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192,
    stream: true,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      const error = (msg, code = 'UPSTREAM_UNAVAILABLE') => enqueue('error', { message: msg, error: { code, message: msg } });

      enqueue('start', { model });
      try {
        const response = await fetch(url.toString(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
          body: JSON.stringify(payload),
          redirect: 'error',
        });

        if (!response.ok) {
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

            const dataLines = [];
            for (const line of frame.replace(/\r/g, '').split('\n')) {
              if (!line.startsWith('data:')) continue;
              let v = line.slice(5);
              if (v.startsWith(' ')) v = v.slice(1);
              dataLines.push(v);
            }
            const raw = dataLines.join('\n');
            if (!raw) continue;
            if (raw === '[DONE]') { enqueue('end', {}); ended = true; break; }
            let data;
            try { data = JSON.parse(raw); } catch { continue; }

            const streamErr = data?.error;
            if (streamErr) {
              const msg = typeof streamErr === 'string' ? streamErr : (streamErr?.message ?? JSON.stringify(streamErr));
              error(`Azure error: ${msg}`);
              ended = true;
              break;
            }

            const choices = data?.choices;
            if (Array.isArray(choices) && choices.length > 0) {
              const delta = choices[0]?.delta?.content ?? choices[0]?.text ?? '';
              if (typeof delta === 'string' && delta) enqueue('delta', { delta });
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
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
};
