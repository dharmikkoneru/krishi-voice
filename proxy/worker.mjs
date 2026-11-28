// Chilli-advisory LLM proxy. Runs as a Cloudflare Worker (default export)
// and, through server.mjs, as a local Node process. The model may return only
// a kb.json entry id plus tags, never prose, so it cannot invent advice.

import { ENTRIES, TAGS } from './constraints.mjs';

const MAX_TRANSCRIPT = 600;
const HOUR_MS = 3600_000;
const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

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

// Counters live in one Durable Object, so they survive isolate restarts and are
// shared by every isolate. Keying is per device first, per IP second: a village
// behind one NAT address shares the (much larger) IP budget but each phone has
// its own, so one heavy user cannot lock out the neighbours.
const dayKey = (day) => `day:${day}`;

export class Limiter {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.chain = Promise.resolve();
  }

  // Serialise checks so a burst cannot read the same counters twice.
  fetch(request) {
    const body = request.json().catch(() => ({}));
    const run = this.chain.then(async () => this.check(await body));
    this.chain = run.catch(() => {});
    return run;
  }

  async check({ device, ip }) {
    const limits = {
      device: num(this.env.DEVICE_HOURLY, 20),
      ip: num(this.env.IP_HOURLY, 400),
      daily: num(this.env.DAILY_CAP, 400),
    };
    const now = Date.now();
    const bucket = Math.floor(now / HOUR_MS);
    const day = new Date(now).toISOString().slice(0, 10);

    // Drop finished hour buckets and old days on the first call of a new hour.
    if ((await this.storage.get('bucket')) !== bucket) {
      const stale = await this.storage.list({ prefix: 'h:' });
      for (const key of stale.keys()) {
        if (!key.startsWith(`h:${bucket}:`)) await this.storage.delete(key);
      }
      const days = await this.storage.list({ prefix: 'day:' });
      for (const key of days.keys()) {
        if (key !== dayKey(day)) await this.storage.delete(key);
      }
      await this.storage.put('bucket', bucket);
    }

    const deviceKey = `h:${bucket}:d:${device}`;
    const ipKey = `h:${bucket}:i:${ip}`;
    const [deviceCount, ipCount, dayCount] = await Promise.all([
      this.storage.get(deviceKey),
      this.storage.get(ipKey),
      this.storage.get(dayKey(day)),
    ]);

    const minute = 60_000;
    const untilNextHour = HOUR_MS - (now % HOUR_MS) + 1000;
    const untilTomorrow = new Date(`${day}T00:00:00Z`).getTime() + 86_400_000 - now + 1000;

    if ((dayCount || 0) >= limits.daily) {
      return deny('daily_cap', Math.ceil(untilTomorrow / 1000));
    }
    if ((ipCount || 0) >= limits.ip) {
      return deny('ip_hourly', Math.ceil(untilNextHour / 1000));
    }
    if ((deviceCount || 0) >= limits.device) {
      return deny('device_hourly', Math.ceil(Math.max(untilNextHour, minute) / 1000));
    }

    await Promise.all([
      this.storage.put(deviceKey, (deviceCount || 0) + 1),
      this.storage.put(ipKey, (ipCount || 0) + 1),
      this.storage.put(dayKey(day), (dayCount || 0) + 1),
    ]);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}

function deny(reason, retryAfter) {
  return new Response(JSON.stringify({ ok: false, reason, retryAfter }), {
    headers: { 'content-type': 'application/json' },
  });
}

async function checkLimits(env, device, ip) {
  if (!env.LIMITER) throw new Error('no limiter binding');
  const stub = env.LIMITER.get(env.LIMITER.idFromName('global'));
  const response = await stub.fetch('https://limiter/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device, ip }),
  });
  if (!response.ok) throw new Error(`limiter responded ${response.status}`);
  return response.json();
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
          'access-control-allow-headers': 'content-type, x-device-id',
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
    const claimed = (request.headers.get('x-device-id') || '').trim();
    // An unusable id counts as the IP itself, so clients cannot dodge the
    // per-device budget by sending a malformed header, and old clients still
    // hit a limit instead of running unmetered.
    const device = DEVICE_RE.test(claimed) ? claimed : `ip:${ip}`;

    let verdict;
    try {
      verdict = await checkLimits(env, device, ip);
    } catch {
      // Without the counter the daily cap cannot be enforced, so refuse rather
      // than spend the owner's key. The app falls back to the keyword engine.
      return json({ error: 'limiter_unavailable' }, 503, origin);
    }
    if (!verdict.ok) {
      return new Response(
        JSON.stringify({ error: verdict.reason, retry_after: verdict.retryAfter }),
        {
          status: 429,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'retry-after': String(verdict.retryAfter || 60),
            ...cors(origin),
          },
        }
      );
    }

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
          max_tokens: 2000,
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
