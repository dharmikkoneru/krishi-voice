// Chilli-advisory LLM proxy. Runs as a Cloudflare Worker (default export)
// and, through server.mjs, as a local Node process. The model may return only
// a kb.json entry id plus tags, never prose, so it cannot invent advice.

import { ENTRIES, TAGS } from './constraints.mjs';

const MAX_TRANSCRIPT = 600;
const WINDOW_MS = 3600_000;
const LIMIT = 40;
const rate = new Map();

const SYSTEM = `You map a chilli farmer's complaint to a fixed knowledge base.
Reply with JSON only, no prose: {"entry":"<id>","tags":["<tag>"]}.
Allowed entries:
${Object.entries(ENTRIES)
  .map(([id, tags]) => `- ${id}: ${tags.join(', ')}`)
  .join('\n')}
Allowed tags: ${TAGS.join(', ')}.
Rules:
- Pick exactly one entry id from the list, or "unknown".
- Include a tag only if the transcript states or clearly implies it.
- For another crop, an unclear complaint, or no fit: {"entry":"unknown","tags":[]}.
- Never include advice, product names, doses or extra keys.`;

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function originAllowed(origin, env) {
  if (!origin) return true; // curl and server-to-server
  if (LOCAL_ORIGIN.test(origin)) return true;
  return (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(origin);
}

function cors(origin) {
  return {
    'access-control-allow-origin': origin || '*',
    vary: 'Origin',
    'cache-control': 'no-store',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) },
  });
}

function limited(ip) {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const recent = (rate.get(ip) || []).filter((t) => t > cutoff);
  recent.push(now);
  rate.set(ip, recent);
  if (rate.size > 2000) {
    for (const [key, times] of rate) {
      if (!times.some((t) => t > cutoff)) rate.delete(key);
    }
  }
  return recent.length > LIMIT;
}

function normalize(content) {
  const match = String(content || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data;
  try {
    data = JSON.parse(match[0]);
  } catch {
    return null;
  }
  let entry = String(data.entry || '').trim().toLowerCase();
  if (entry !== 'unknown' && !Object.hasOwn(ENTRIES, entry)) return null;
  const tags = [
    ...new Set(
      (Array.isArray(data.tags) ? data.tags : [])
        .map((t) => String(t).trim().toLowerCase())
        .filter((t) => TAGS.includes(t))
    ),
  ].slice(0, 6);
  if (entry === 'unknown') return { entry, tags: [] };
  // An entry with unrelated tags is not trustworthy; refuse instead.
  if (tags.length && !tags.some((t) => ENTRIES[entry].includes(t))) {
    return { entry: 'unknown', tags: [] };
  }
  return { entry, tags: tags.sort() };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    if (!originAllowed(origin, env)) return json({ error: 'origin_not_allowed' }, 403, origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors(origin),
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '600',
        },
      });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      return json({ error: 'json_required' }, 415, origin);
    }

    const raw = await request.text();
    if (raw.length > 4000) return json({ error: 'body_too_large' }, 413, origin);
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: 'bad_json' }, 400, origin);
    }
    const transcript = typeof data.transcript === 'string' ? data.transcript.trim() : '';
    if (!transcript) return json({ error: 'transcript_required' }, 400, origin);
    if (transcript.length > MAX_TRANSCRIPT) return json({ error: 'transcript_too_long' }, 413, origin);

    if (!env.LLM_API_KEY) return json({ error: 'not_configured' }, 503, origin);

    const ip =
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      'unknown';
    if (limited(ip)) return json({ error: 'rate_limited' }, 429, origin);

    const base = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = env.LLM_MODEL || 'gpt-4o-mini';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let upstream;
    try {
      upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${env.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 120,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: `Transcript: ${JSON.stringify(transcript)}` },
          ],
        }),
        signal: controller.signal,
      });
    } catch {
      return json({ error: 'upstream_unavailable' }, 502, origin);
    } finally {
      clearTimeout(timer);
    }

    if (!upstream.ok) {
      // Status only: never log the transcript or the key.
      console.error('llm upstream status', upstream.status);
      return json({ error: 'upstream_error' }, 502, origin);
    }

    let content = '';
    try {
      const payload = await upstream.json();
      content = payload?.choices?.[0]?.message?.content || '';
    } catch {
      return json({ error: 'upstream_bad_json' }, 502, origin);
    }

    const result = normalize(content);
    if (!result) return json({ error: 'bad_model_output' }, 502, origin);
    return json(result, 200, origin);
  },
};
