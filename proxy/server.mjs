#!/usr/bin/env node
// Local/self-hosted adapter for worker.mjs. Binds to loopback only.
//   PORT=8798 LLM_API_KEY=... LLM_MODEL=... node proxy/server.mjs

import { createServer } from 'node:http';
import worker, { Limiter } from './worker.mjs';

const port = Number(process.env.PORT || 8798);

// Minimal stand-in for Durable Object storage, so the same Limiter class runs
// locally. It lives for the process, which is enough for a loopback test.
function localLimiter() {
  const data = new Map();
  const storage = {
    async get(key) {
      return data.get(key);
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return new Map([...data].filter(([key]) => key.startsWith(prefix)));
    },
  };
  const instance = new Limiter({ storage }, process.env);
  return {
    idFromName: (name) => name,
    get: () => ({ fetch: (url, init) => instance.fetch(new Request(url, init)) }),
  };
}

const env = {
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
  DEVICE_HOURLY: process.env.DEVICE_HOURLY || '20',
  IP_HOURLY: process.env.IP_HOURLY || '400',
  DAILY_CAP: process.env.DAILY_CAP || '400',
  LIMITER: localLimiter(),
};

const server = createServer(async (req, res) => {
  let body = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20000) {
      res.writeHead(413).end();
      return;
    }
    body += chunk;
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers[key] = value;
  }
  if (!headers['x-forwarded-for']) headers['x-forwarded-for'] = req.socket.remoteAddress || 'local';

  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });

  try {
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"proxy_failed"}');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`llm proxy on http://127.0.0.1:${port} (key ${env.LLM_API_KEY ? 'set' : 'missing'})`);
});
