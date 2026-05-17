// Proxies POST /api/proxy/google/stream to Google Gemini with SSE streaming.

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

const BENIGN_FINISH_REASONS = new Set(['', 'STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED']);

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

  const effectiveBaseUrl = baseUrl || 'https://generativelanguage.googleapis.com';
  const validated = validateBaseUrl(effectiveBaseUrl);
  if (validated.error) {
    return new Response(JSON.stringify({ error: { message: validated.error } }), {
      status: validated.forbidden ? 403 : 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const clean = effectiveBaseUrl.replace(/\/+$/, '');
  const url = `${clean}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const contents = (Array.isArray(messages) ? messages : []).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const payload = {
    contents,
    generationConfig: { maxOutputTokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : 8192 },
  };
  if (typeof systemPrompt === 'string' && systemPrompt) payload.systemInstruction = { parts: [{ text: systemPrompt }] };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (event, data) => controller.enqueue(encoder.encode(sseEvent(event, data)));
      const error = (msg, code = 'UPSTREAM_UNAVAILABLE') => enqueue('error', { message: msg, error: { code, message: msg } });

      enqueue('start', { model });
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
            if (!raw || raw === '[DONE]') continue;
            let data;
            try { data = JSON.parse(raw); } catch { continue; }

            const feedback = data?.promptFeedback;
            if (typeof feedback?.blockReason === 'string' && feedback.blockReason) {
              const tail = feedback.blockReasonMessage ? ` — ${feedback.blockReasonMessage}` : '';
              error(`Gemini blocked the prompt (${feedback.blockReason})${tail}.`);
              ended = true;
              break;
            }

            const candidates = data?.candidates;
            if (Array.isArray(candidates) && candidates.length > 0) {
              const reason = candidates[0]?.finishReason;
              if (typeof reason === 'string' && !BENIGN_FINISH_REASONS.has(reason)) {
                const tail = candidates[0]?.finishMessage ? ` — ${candidates[0].finishMessage}` : '';
                error(`Gemini stopped (${reason})${tail}.`);
                ended = true;
                break;
              }
              const parts = candidates[0]?.content?.parts;
              if (Array.isArray(parts)) {
                const delta = parts.map(p => typeof p?.text === 'string' ? p.text : '').join('');
                if (delta) enqueue('delta', { delta });
              }
            }

            const streamErr = data?.error;
            if (streamErr) {
              const msg = typeof streamErr === 'string' ? streamErr : (streamErr?.message ?? JSON.stringify(streamErr));
              error(`Gemini error: ${msg}`);
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
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' },
  });
};
