#!/usr/bin/env node
/**
 * Fill Arm B (hybrid: LLM maps transcript -> kb.json entry/tags) in the
 * evaluation score sheet. This is an offline evaluation tool, not the app.
 *
 * Usage:
 *   node evaluation/run-llm.mjs evaluation/score-sheet.csv
 *   node evaluation/run-llm.mjs --limit 10
 *   node evaluation/run-llm.mjs --dry-run    # print requests, no key/network
 *   node evaluation/run-llm.mjs --mock       # copy Arm A into B; plumbing only
 *
 * Environment:
 *   LLM_API_KEY   required unless --dry-run/--mock
 *   LLM_BASE_URL  default https://api.openai.com/v1
 *   LLM_MODEL     default gpt-4o-mini
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsv, toCsv } from './csv.mjs';
import { loadEngine, runArmA } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const kb = JSON.parse(readFileSync(join(here, '..', 'kb.json'), 'utf8'));
const ENTRIES = kb.entries.map((e) => e.id);
const TAGS = Object.keys(kb.lex);

const SYSTEM = `You map a chilli farmer's complaint to a fixed knowledge base.
Reply with JSON only, no prose: {"entry":"<id>","tags":["<tag>"]}.
Allowed entries:
${kb.entries.map((e) => `- ${e.id}: ${e.tags.join(', ')}`).join('\n')}
Allowed tags: ${TAGS.join(', ')}.
Rules:
- Pick exactly one entry id from the allowed list, or "unknown" if nothing fits.
- Include a tag only if the transcript states or clearly implies it.
- If the complaint is about a crop other than chilli, return {"entry":"unknown","tags":[]}.
- Never include advice, product names, doses or extra keys.`;

function normalizeReply(reply) {
  const match = String(reply).match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`reply was not JSON: ${String(reply).slice(0, 200) || '(empty)'}`);
  const data = JSON.parse(match[0]);
  let entry = String(data.entry ?? '').trim().toLowerCase();
  if (entry !== 'unknown' && !ENTRIES.includes(entry)) {
    throw new Error(`entry not in kb.json: ${entry || '(empty)'}`);
  }
  const tags = Array.isArray(data.tags)
    ? data.tags.map((t) => String(t).trim().toLowerCase()).filter((t) => TAGS.includes(t))
    : [];
  return {
    entry,
    tags: entry === 'unknown' ? [] : [...new Set(tags)].sort(),
    unknown: entry === 'unknown',
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(transcript, { base, model, key }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const started = Date.now();
      const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
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
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        const error = new Error(`LLM HTTP ${response.status}: ${detail}`);
        error.status = response.status;
        throw error;
      }
      const json = await response.json();
      const content = json?.choices?.[0]?.message?.content ?? '';
      return { ...normalizeReply(content), ms: Date.now() - started };
    } catch (error) {
      lastError = error;
      const retryable = !error.status || error.status === 429 || error.status >= 500;
      if (!retryable) throw error;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fill(file, opts) {
  const rows = parseCsv(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!rows.length) throw new Error(`${file} is empty.`);

  const header = rows[0].map((h) => h.trim());
  const at = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ['id', 'human', 'B_entry', 'B_tags', 'B_unknown', 'B_ms']) {
    if (at[need] === undefined) throw new Error(`${file} is missing the "${need}" column.`);
  }
  const asrAt = at.asr;

  let processed = 0;
  let changed = 0;
  let printedPrompt = false;

  for (const row of rows.slice(1)) {
    if (processed >= opts.limit) break;
    if (!row.some((c) => c.trim())) continue;
    while (row.length < header.length) row.push('');

    const text = ((asrAt === undefined ? '' : row[asrAt]) || row[at.human] || '').trim();
    if (!text) continue;

    let result;
    if (opts.dryRun) {
      if (!printedPrompt) {
        console.log(`--- system prompt ---\n${SYSTEM}\n--- requests ---`);
        printedPrompt = true;
      }
      console.log(`${row[at.id]}: Transcript: ${JSON.stringify(text)}`);
      processed++;
      continue;
    } else if (opts.mock) {
      const mock = runArmA(loadEngine(), text);
      result = { entry: mock.entry, tags: mock.tags, unknown: mock.unknown, ms: 0 };
    } else {
      result = await ask(text, opts);
    }

    const updates = {
      B_entry: result.entry,
      B_tags: result.tags.join(';'),
      B_unknown: result.unknown ? '1' : '0',
      B_ms: String(result.ms),
    };
    for (const [key, value] of Object.entries(updates)) {
      if (row[at[key]] !== value) {
        row[at[key]] = value;
        changed++;
      }
    }
    processed++;
    console.log(
      `${row[at.id]}: ${result.entry}${result.unknown ? ' (unknown)' : ''} ` +
        `[${result.tags.join(',')}] ${result.ms} ms${opts.mock ? ' (mock)' : ''}`
    );
  }

  if (!opts.dryRun && changed) writeFileSync(file, toCsv(rows), 'utf8');
  console.log(
    `\n${processed} row(s) processed, ${changed} field(s) written` +
      `${opts.dryRun ? ' (dry run, nothing written)' : ''}.`
  );
}

const args = process.argv.slice(2);
const opts = {
  dryRun: args.includes('--dry-run'),
  mock: args.includes('--mock'),
  limit: Infinity,
  base: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
  model: process.env.LLM_MODEL || 'gpt-4o-mini',
  key: process.env.LLM_API_KEY || '',
};
let file = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') {
    const n = Number(args[++i]);
    if (Number.isFinite(n) && n > 0) opts.limit = n;
    continue;
  }
  if (!args[i].startsWith('--')) file = args[i];
}
file = file || join(here, 'score-sheet.csv');

if (!opts.dryRun && !opts.mock && !opts.key) {
  console.error(
    'Set LLM_API_KEY (and optionally LLM_BASE_URL / LLM_MODEL), or use --dry-run or --mock. ' +
      'See EVALUATION.md.'
  );
  process.exit(2);
}

await fill(file, opts);
