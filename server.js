import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT) || 3000;

app.disable('x-powered-by');

app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/kb.json', (_req, res) => {
  res.sendFile(join(__dirname, 'kb.json'));
});

app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, 'sw.js'));
});

app.get('/favicon.ico', (_req, res) => {
  res.status(204).end();
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Krishi Voice listening on http://0.0.0.0:${port}`);
});
