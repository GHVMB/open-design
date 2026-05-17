// Implements POST /api/provider/models — lists available models from a BYOK provider.
// Ported from apps/daemon/src/providerModels.ts for Netlify serverless deployment.

function validateBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(baseUrl).replace(/\/+$/, ''));
  } catch {
    return { error: 'Invalid baseUrl' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only http/https allowed' };
  }
  const h = parsed.hostname.toLowerCase();
  if (
    h === 'localhost' || h === '::1' ||
    /^127\./.test(h) || /^10\./.test(h) ||
    /^192\.168\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)
  ) {
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

function modelsUrl(protocol, baseUrl, apiKey) {
  if (protocol === 'openai') return appendVersionedApiPath(baseUrl, '/models');
  if (protocol === 'anthropic') {
    const url = new URL(appendVersionedApiPath(baseUrl, '/models'));
    url.searchParams.set('limit', '1000');
    return url.toString();
  }
  if (protocol === 'google') {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/v1beta/models`);
    url.searchParams.set('key', apiKey);
    return url.toString();
  }
  throw new Error(`Unsupported protocol: ${protocol}`);
}

function modelsHeaders(protocol, apiKey) {
  if (protocol === 'openai') return { authorization: `Bearer ${apiKey}` };
  if (protocol === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  return {};
}

function dedup(models) {
  const seen = new Set();
  return models.filter(m => { if (seen.has(m.id)) return false; seen.add(m.id); return true; })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function extractModels(protocol, data) {
  if (protocol === 'openai') {
    if (!Array.isArray(data?.data)) return [];
    return dedup(data.data.map(i => typeof i?.id === 'string' ? { id: i.id, label: i.id } : null).filter(Boolean));
  }
  if (protocol === 'anthropic') {
    if (!Array.isArray(data?.data)) return [];
    return dedup(data.data.map(i => {
      const id = typeof i?.id === 'string' ? i.id : '';
      const label = typeof i?.display_name === 'string' ? i.display_name : id;
      return id ? { id, label } : null;
    }).filter(Boolean));
  }
  if (protocol === 'google') {
    if (!Array.isArray(data?.models)) return [];
    const supportsGenerate = item => {
      const m = item?.supportedGenerationMethods ?? item?.supported_actions;
      return Array.isArray(m) && m.includes('generateContent');
    };
    return dedup(data.models.filter(supportsGenerate).map(i => {
      const id = (typeof i?.baseModelId === 'string' && i.baseModelId.trim())
        ? i.baseModelId.trim()
        : (typeof i?.name === 'string' ? (i.name.startsWith('models/') ? i.name.slice(7) : i.name) : '');
      const label = typeof i?.displayName === 'string' && i.displayName.trim() ? i.displayName : id;
      return id ? { id, label } : null;
    }).filter(Boolean));
  }
  return [];
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: { message: 'Method not allowed' } }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }
  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { protocol, baseUrl, apiKey } = body ?? {};
  const start = Date.now();
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

  if (!['anthropic', 'openai', 'azure', 'google', 'ollama'].includes(protocol)) {
    return new Response(JSON.stringify({ error: { message: 'protocol must be one of anthropic|openai|azure|google|ollama' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || !baseUrl.trim() || !apiKey.trim()) {
    return new Response(JSON.stringify({ error: { message: 'baseUrl and apiKey are required' } }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (protocol === 'azure') {
    return json({ ok: false, kind: 'unsupported_protocol', latencyMs: Date.now() - start, detail: 'Azure deployment discovery is not supported from the inference endpoint.' });
  }
  if (protocol === 'ollama') {
    return json({ ok: false, kind: 'unsupported_protocol', latencyMs: Date.now() - start, detail: 'Ollama model discovery requires local daemon access.' });
  }

  const validated = validateBaseUrl(baseUrl);
  if (validated.error) {
    return json({ ok: false, kind: validated.forbidden ? 'forbidden' : 'invalid_base_url', latencyMs: Date.now() - start, detail: validated.error });
  }

  let url;
  try { url = modelsUrl(protocol, baseUrl, apiKey); } catch (err) {
    return json({ ok: false, kind: 'unsupported_protocol', latencyMs: Date.now() - start, detail: err.message });
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: modelsHeaders(protocol, apiKey),
      redirect: 'error',
      signal: AbortSignal.timeout(12000),
    });
    const latencyMs = Date.now() - start;
    const rawText = await response.text();
    let data = {};
    let parseError;
    try { data = rawText ? JSON.parse(rawText) : {}; } catch (e) { parseError = e.message; }

    if (!response.ok) {
      const detail = parseError
        ? rawText.trim().slice(0, 240) || parseError
        : (data?.error?.message ?? data?.message ?? rawText.trim().slice(0, 240));
      return json({ ok: false, kind: 'unknown', latencyMs, status: response.status, detail });
    }
    if (parseError) return json({ ok: false, kind: 'unknown', latencyMs, status: response.status, detail: parseError });

    const models = extractModels(protocol, data);
    if (models.length === 0) return json({ ok: false, kind: 'no_models', latencyMs, status: response.status, detail: 'Provider returned no usable models.' });
    return json({ ok: true, kind: 'success', latencyMs, status: response.status, models });
  } catch (err) {
    return json({ ok: false, kind: err?.name === 'TimeoutError' ? 'timeout' : 'unknown', latencyMs: Date.now() - start, detail: err?.message ?? 'Request failed' });
  }
};

export const config = { path: '/api/provider/models' };
