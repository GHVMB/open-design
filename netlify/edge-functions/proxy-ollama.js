// Proxies POST /api/proxy/ollama/stream to Ollama Cloud with NDJSON streaming.

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

  const { baseUrl, apiKey, model, systemPrompt, messages, maxTokens } = body ?? {};
  if (!apiKey || !model) {
    return new Response(JSON.stringify({ error: { message: 'apiKey and model are required' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const effectiveBaseUrl = baseUrl || 'https://ollama.com';
  const validated = validateBaseUrl(effectiveBaseUrl);
  if (validated.error) {
    return new Response(JSON.stringify({ error: { message: validated.error } }), {
      status: validated.forbidden ? 403 : 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const clean = effectiveBaseUrl.replace(/\/+$/, '').replace(/\/api\/?$/, '');
  const url = `${clean}/api/chat`;
  const payloadMessages = Array.isArray(messages) ? [...messages] : [];
  if (typeof systemPrompt === 'string' && systemPrompt) payloadMessages.unshift({ role: 'system', content: systemPrompt });
  const payload = {
    model,
    messages: payloadMessages,
    stream: true,
    ...(typeof maxTokens === 'number' && maxTokens > 0 ? { options: { num_predict: maxTokens } } : {}),
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      const error = (msg, code = 'UPSTREAM_UNAVAILABLE') => enqueue('error', { message: msg, error: { code, message: msg } });

      enqueue('start', { model });
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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
          let newline = buf.indexOf('\n');
          while (newline !== -1) {
            const line = buf.slice(0, newline).trim();
            buf = buf.slice(newline + 1);
            newline = buf.indexOf('\n');
            if (!line) continue;
            let data;
            try { data = JSON.parse(line); } catch { continue; }
            const delta = data?.message?.content;
            if (typeof delta === 'string' && delta) enqueue('delta', { delta });
            if (data?.done === true) { enqueue('end', {}); ended = true; break; }
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
