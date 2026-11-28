#!/usr/bin/env node
// Local/self-hosted adapter for worker.mjs. Binds to loopback only.
//   PORT=8798 LLM_API_KEY=... LLM_MODEL=... node proxy/server.mjs

import { createServer } from 'node:http';
import worker from './worker.mjs';

const port = Number(process.env.PORT || 8798);
const env = {
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  LLM_MODEL: process.env.LLM_MODEL || 'gpt-4o-mini',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '',
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
