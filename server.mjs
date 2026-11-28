import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const ALLOWED_LANGS = new Set(['te', 'hi', 'en']);

const VOICE_CATALOG = {
  te: {
    default: 'shruti',
    voices: {
      shruti: { neural: 'te-IN-ShrutiNeural', gemini: 'Kore', label: 'Shruti' },
      mohan: { neural: 'te-IN-MohanNeural', gemini: 'Charon', label: 'Mohan' },
    },
  },
  hi: {
    default: 'madhur',
    voices: {
      madhur: { neural: 'hi-IN-MadhurNeural', gemini: 'Charon', label: 'Madhur' },
      swara: { neural: 'hi-IN-SwaraNeural', gemini: 'Kore', label: 'Swara' },
    },
  },
  en: {
    default: 'neerja',
    voices: {
      neerja: { neural: 'en-IN-NeerjaNeural', gemini: 'Zephyr', label: 'Neerja' },
      prabhat: { neural: 'en-IN-PrabhatNeural', gemini: 'Fenrir', label: 'Prabhat' },
    },
  },
};

const FARMER_STYLES = {
  te: 'Warm, patient, crystal-clear Telugu agricultural advisor speaking naturally to a small chilli farmer in Andhra Pradesh and Telangana. Use natural Telugu pronunciation, gentle warmth, and clear pauses between sentences so every farming instruction is easy to follow.',
  hi: 'Warm, steady, trustworthy Hindi agricultural advisor speaking clearly to an Indian farmer. Use simple natural Hindi pronunciation, a calm reassuring tone, and clear pauses between sentences so every instruction is easy to understand.',
  en: 'Warm, friendly, articulate Indian English agricultural advisor speaking clearly to a farmer. Use a calm unhurried pace, crisp pronunciation, and reassuring everyday phrasing.',
};

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

const TTS_CACHE = new Map();
const TTS_CACHE_MAX = 100;
const MAX_BODY_BYTES = 8192;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const NO_CACHE_EXTS = new Set(['.html', '.js', '.mjs', '.json', '.css']);

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectBody(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        rejectBody(Object.assign(new Error('Invalid JSON payload'), { status: 400 }));
      }
    });
    req.on('error', (err) => rejectBody(err));
  });
}

function resolveVoiceSpec(lang, requestedVoice) {
  const entry = VOICE_CATALOG[lang] || VOICE_CATALOG.te;
  const key = typeof requestedVoice === 'string' ? requestedVoice.toLowerCase() : '';
  const chosenKey = entry.voices[key] ? key : entry.default;
  return { key: chosenKey, ...entry.voices[chosenKey] };
}

function cachePut(cacheKey, item) {
  TTS_CACHE.set(cacheKey, item);
  if (TTS_CACHE.size > TTS_CACHE_MAX) {
    const oldestKey = TTS_CACHE.keys().next().value;
    TTS_CACHE.delete(oldestKey);
  }
}

async function synthesizeGemini({ text, lang, slow, spec }) {
  const baseStyle = FARMER_STYLES[lang] || FARMER_STYLES.en;
  const style = slow
    ? `${baseStyle} Speak noticeably slower and extra clearly, pausing gently after each phrase.`
    : baseStyle;

  const response = await ai.models.generateContent({
    model: TTS_MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text,
            speechMetadata: { style },
          },
        ],
      },
    ],
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: spec.gemini },
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error('Gemini TTS returned no audio data');
  return {
    audio: Buffer.from(base64Audio, 'base64'),
    contentType: 'audio/wav',
    engine: 'gemini-tts',
    voiceName: spec.gemini,
  };
}

async function synthesizeNeural({ text, slow, spec }) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(spec.neural, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    // Slightly unhurried rate (-8% default, -22% slower) for farmer clarity
    const rate = slow ? '-22%' : '-8%';
    const { audioStream } = tts.toStream(text, { rate });
    const chunks = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const audio = Buffer.concat(chunks);
    if (!audio.length) throw new Error('Neural TTS returned empty audio');
    return {
      audio,
      contentType: 'audio/mpeg',
      engine: 'neural-tts',
      voiceName: spec.neural,
    };
  } finally {
    try {
      tts.close();
    } catch {}
  }
}

function splitForFallback(text, maxLen = 170) {
  const parts = [];
  const sentences = text.split(/(?<=[.।?!,])\s+/).filter(Boolean);
  let cur = '';
  for (const s of sentences) {
    if ((cur + ' ' + s).trim().length <= maxLen) {
      cur = (cur + ' ' + s).trim();
    } else {
      if (cur) parts.push(cur);
      if (s.length <= maxLen) {
        cur = s;
      } else {
        for (let i = 0; i < s.length; i += maxLen) {
          parts.push(s.slice(i, i + maxLen));
        }
        cur = '';
      }
    }
  }
  if (cur) parts.push(cur);
  return parts.length ? parts : [text.slice(0, maxLen)];
}

async function synthesizeGoogleFallback({ text, lang, slow }) {
  const tl = lang === 'te' ? 'te' : lang === 'hi' ? 'hi' : 'en-IN';
  const chunks = splitForFallback(text);
  const buffers = [];
  for (const part of chunks) {
    const url =
      'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob' +
      `&tl=${encodeURIComponent(tl)}&ttsspeed=${slow ? '0.6' : '1'}&q=${encodeURIComponent(part)}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`Fallback TTS HTTP ${r.status}`);
    buffers.push(Buffer.from(await r.arrayBuffer()));
  }
  return {
    audio: Buffer.concat(buffers),
    contentType: 'audio/mpeg',
    engine: 'gtts-fallback',
    voiceName: tl,
  };
}

async function generateFarmerSpeech({ text, lang, slow, voice }) {
  const spec = resolveVoiceSpec(lang, voice);
  const cacheKey = `${lang}|${spec.key}|${slow ? '1' : '0'}|${text}`;
  if (TTS_CACHE.has(cacheKey)) {
    const hit = TTS_CACHE.get(cacheKey);
    TTS_CACHE.delete(cacheKey);
    TTS_CACHE.set(cacheKey, hit);
    return hit;
  }

  // Tier 1: Gemini 3.8 Flash Lite TTS when GEMINI_API_KEY is configured
  if (ai) {
    try {
      const out = await synthesizeGemini({ text, lang, slow, spec });
      cachePut(cacheKey, out);
      return out;
    } catch (err) {
      console.warn('Gemini TTS fallback triggered:', err?.message || err);
    }
  }

  // Tier 2: Studio-grade Indian Neural voices (Shruti/Mohan for Telugu, Madhur/Swara for Hindi, Neerja/Prabhat for English)
  try {
    const out = await synthesizeNeural({ text, slow, spec });
    cachePut(cacheKey, out);
    return out;
  } catch (err) {
    console.warn('Neural TTS fallback triggered:', err?.message || err);
  }

  // Tier 3: Multilingual HTTP TTS backup
  const out = await synthesizeGoogleFallback({ text, lang, slow });
  cachePut(cacheKey, out);
  return out;
}

async function handleTts(req, res) {
  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (err) {
    sendJson(res, err.status || 400, { error: err.message || 'Bad request' });
    return;
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    sendJson(res, 400, { error: 'Missing text to speak.' });
    return;
  }
  if (text.length > 650) {
    sendJson(res, 400, { error: 'Text exceeds maximum speech length.' });
    return;
  }

  const lang = ALLOWED_LANGS.has(payload.lang) ? payload.lang : 'te';
  const slow = Boolean(payload.slow);
  const voice = typeof payload.voice === 'string' ? payload.voice : '';

  try {
    const { audio, contentType, engine, voiceName } = await generateFarmerSpeech({
      text,
      lang,
      slow,
      voice,
    });
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': audio.length,
      'Cache-Control': 'private, max-age=3600',
      'X-TTS-Engine': engine,
      'X-Voice-Name': voiceName,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(audio);
  } catch (err) {
    console.error('TTS error:', err?.message || err);
    sendJson(res, 502, { error: err?.message || 'Speech synthesis failed.' });
  }
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : 'ok');
    return;
  }

  if (pathname === '/api/tts/status' && req.method === 'GET') {
    sendJson(res, 200, {
      available: true,
      primaryEngine: ai ? 'gemini-tts' : 'neural-tts',
      geminiConfigured: Boolean(ai),
      voices: {
        te: Object.keys(VOICE_CATALOG.te.voices),
        hi: Object.keys(VOICE_CATALOG.hi.voices),
        en: Object.keys(VOICE_CATALOG.en.voices),
      },
    });
    return;
  }

  if (pathname === '/api/tts' && req.method === 'POST') {
    await handleTts(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s.startsWith('.'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const filePath = resolve(ROOT, '.' + pathname);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const cacheControl = NO_CACHE_EXTS.has(ext) ? 'no-cache' : 'public, max-age=3600';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': info.size,
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const data = await readFile(filePath);
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  }
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
