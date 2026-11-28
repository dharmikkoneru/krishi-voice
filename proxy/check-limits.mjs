// Exercises proxy/worker.mjs limit logic against a mock upstream.
import worker, { Limiter } from './worker.mjs';

const realFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{"entry":"thrips","tags":["curl"]}' } }] }), {
    headers: { 'content-type': 'application/json' },
  });

function storage() {
  const data = new Map();
  return {
    data,
    async get(k) {
      return data.get(k);
    },
    async put(k, v) {
      data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
    async list({ prefix = '' } = {}) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)));
    },
  };
}

// A binding over a fresh Limiter instance: a new instance per call is how a new
// isolate looks, while the storage keeps counters across them.
function binding(st, { restart = false } = {}) {
  let instance = null;
  return {
    idFromName: (n) => n,
    get: () => {
      if (!instance || restart) instance = new Limiter({ storage: st }, env);
      return { fetch: (url, init) => instance.fetch(new Request(url, init)) };
    },
  };
}

let env;
function makeEnv(limits, st, opts) {
  env = {
    LLM_API_KEY: 'test',
    LLM_BASE_URL: 'https://mock/v1',
    LLM_MODEL: 'mock',
    ALLOWED_ORIGINS: 'https://dharmikkoneru.github.io',
    ...limits,
    LIMITER: binding(st, opts),
  };
  return env;
}

const req = (device, ip = '203.0.113.7') =>
  new Request('https://worker/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://dharmikkoneru.github.io',
      'cf-connecting-ip': ip,
      ...(device ? { 'x-device-id': device } : {}),
    },
    body: JSON.stringify({ transcript: 'aaku curl avutunnayi' }),
  });

const call = async (device, ip) => {
  const r = await worker.fetch(req(device, ip), env);
  const body = await r.json();
  return { status: r.status, error: body.error, retry: r.headers.get('retry-after') };
};

let fails = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${got}${ok ? '' : ` (wanted ${want})`}`);
};

// 1. per-device budget
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '3', IP_HOURLY: '100', DAILY_CAP: '100' }, st);
  const got = [];
  for (let i = 0; i < 4; i++) got.push((await call('device-aaaa')).status);
  check('device: 3 allowed then 429', got.join(','), '200,200,200,429');
  const fifth = await call('device-aaaa');
  check('device reason', fifth.error, 'device_hourly');
  check('retry-after present', Number(fifth.retry) > 0, true);
}

// 2. village sharing: many phones on one IP are not locked out
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '2', IP_HOURLY: '100', DAILY_CAP: '100' }, st);
  let ok = 0;
  for (let d = 0; d < 6; d++) for (let i = 0; i < 2; i++) if ((await call(`village-${d}`)).status === 200) ok++;
  check('village: 6 phones x2 all allowed (one IP)', ok, 12);
}

// 3. IP ceiling still exists as a backstop
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '100', IP_HOURLY: '3', DAILY_CAP: '100' }, st);
  const got = [];
  for (let d = 0; d < 4; d++) got.push((await call(`phone-${d}`)).status);
  check('ip: 3 allowed then 429', got.join(','), '200,200,200,429');
  check('ip reason', (await call('phone-x')).error, 'ip_hourly');
}

// 4. daily cap is the hard ceiling
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '100', IP_HOURLY: '100', DAILY_CAP: '2' }, st);
  const got = [];
  for (let d = 0; d < 3; d++) got.push((await call(`phone-${d}`, `198.51.100.${d}`)).status);
  check('daily: 2 allowed then 429', got.join(','), '200,200,429');
  const last = await call('phone-z', '198.51.100.99');
  check('daily reason', last.error, 'daily_cap');
}

// 5. counters survive an isolate restart (new Limiter, same storage)
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '2', IP_HOURLY: '100', DAILY_CAP: '100' }, st);
  await call('restart-dev');
  await call('restart-dev');
  const before = await call('restart-dev');
  check('restart: still 429 before restart', before.status, 429);
  makeEnv({ DEVICE_HOURLY: '2', IP_HOURLY: '100', DAILY_CAP: '100' }, st, { restart: true });
  const after = await call('restart-dev');
  check('restart: counter survives new isolate', after.status, 429);
  check('restart: reason kept', after.error, 'device_hourly');
}

// 6. a malformed device header cannot dodge the per-device budget
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '2', IP_HOURLY: '100', DAILY_CAP: '100' }, st);
  const got = [];
  for (let i = 0; i < 3; i++) got.push((await call('bad id!')).status);
  check('malformed device falls back to ip bucket', got.join(','), '200,200,429');
}

// 7. missing limiter binding fails closed instead of spending the key
{
  env = {
    LLM_API_KEY: 'test',
    LLM_BASE_URL: 'https://mock/v1',
    LLM_MODEL: 'mock',
    ALLOWED_ORIGINS: 'https://dharmikkoneru.github.io',
  };
  const r = await worker.fetch(req('device-aaaa'), env);
  check('no binding: 503', r.status, 503);
  check('no binding: error', (await r.json()).error, 'limiter_unavailable');
}

// 8. a sharp burst is counted exactly, not under-counted by races
{
  const st = storage();
  makeEnv({ DEVICE_HOURLY: '1000', IP_HOURLY: '1000', DAILY_CAP: '5' }, st);
  const results = await Promise.all(Array.from({ length: 9 }, (_, i) => call(`burst-${i}`, '192.0.2.1')));
  const ok = results.filter((r) => r.status === 200).length;
  check('burst: exactly 5 allowed under the daily cap', ok, 5);
}

globalThis.fetch = realFetch;
console.log(fails ? `\n${fails} FAILED` : '\nall limit checks passed');
process.exit(fails ? 1 : 0);
