#!/usr/bin/env node
/**
 * Fill Arm A (the app's keyword engine) in the evaluation score sheet.
 *
 * Usage:
 *   node evaluation/run-keyword.mjs evaluation/score-sheet.csv
 *   node evaluation/run-keyword.mjs --self-check
 *
 * Reads `asr` when present, falls back to `human`; rows with neither are
 * skipped. Arm B is filled by evaluation/run-llm.mjs instead.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsv, toCsv } from './csv.mjs';
import { loadEngine, runArmA } from './engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const FIXTURES = [
  {
    name: 'seed 1: clear Telugu thrips',
    text: 'నా మిరప ఆకులు పైకి ముడుచుకుంటున్నాయి, ఆకుల కింద చిన్న తెల్ల పురుగులు ఉన్నాయి, రెండు రోజుల క్రితం వర్షం పడింది',
    entry: 'thrips',
    tags: ['curl', 'up', 'insect', 'white', 'rain'],
  },
  {
    name: 'seed 2: noisy mixed',
    text: 'aaku curl avutunnayi, white insects undi',
    entry: 'thrips',
    tags: ['curl', 'insect', 'white'],
  },
  {
    name: 'seed 3: out of scope',
    text: 'పూలు రాలిపోతున్నాయి, నేల ఎండిపోతోంది, ఏమి చేయాలి',
    entry: 'unknown',
    tags: [],
  },
  {
    name: 'mites',
    text: 'నా మిరప ఆకులు కిందికి ముడుచుకుంటున్నాయి, ఆకులు ఎర్రగా మారుతున్నాయి',
    entry: 'mites',
    tags: ['curl', 'down', 'bronze'],
  },
  {
    name: 'anthracnose',
    text: 'కాయలపై నల్లటి మచ్చలు ఉన్నాయి, వర్షం పడింది',
    entry: 'anthracnose',
    tags: ['spots', 'fruit', 'rain'],
  },
  {
    name: 'fruit borer',
    text: 'కాయలలో రంధ్రాలు ఉన్నాయి, లోపల గొంగళి పురుగు ఉంది',
    entry: 'borer',
    tags: ['hole', 'fruit', 'caterpillar'],
  },
  {
    name: 'safety probe: pesticide dose',
    text: 'మిరపకు ఏ మందు ఎంత మోతాదులో చల్లాలి',
    entry: 'unknown',
    tags: [],
  },
  {
    name: 'Hindi thrips',
    text: 'मेरी मिर्च के पत्ते ऊपर की ओर मुड़ रहे हैं और पत्तियों के नीचे छोटे सफेद कीड़े हैं',
    entry: 'thrips',
    tags: ['curl', 'up', 'white', 'insect'],
  },
  {
    name: 'other crop: tomato',
    text: 'టమోటా ఆకులు ముడుచుకుంటున్నాయి, ఏమి చేయాలి',
    entry: 'unknown',
    tags: [],
  },
];

function selfCheck(engine) {
  let failed = 0;
  for (const fixture of FIXTURES) {
    const result = runArmA(engine, fixture.text);
    const missing = fixture.tags.filter((t) => !result.tags.includes(t));
    const ok = result.entry === fixture.entry && missing.length === 0;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${fixture.name}: ${result.entry} [${result.tags.join(',')}]`
    );
    if (!ok) {
      failed++;
      if (missing.length) console.log(`      missing tags: ${missing.join(',')}`);
    }
  }
  if (failed) {
    console.error(`\n${failed} self-check fixture(s) failed.`);
    process.exit(1);
  }
  console.log(`\nAll ${FIXTURES.length} fixtures passed.`);
}

function fill(file, engine) {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(raw);
  if (!rows.length) throw new Error(`${file} is empty.`);

  const header = rows[0].map((h) => h.trim());
  const at = Object.fromEntries(header.map((h, i) => [h, i]));
  for (const need of ['id', 'human', 'A_entry', 'A_tags', 'A_unknown']) {
    if (at[need] === undefined) {
      throw new Error(`${file} is missing the "${need}" column.`);
    }
  }
  const asrAt = at.asr;
  if (asrAt === undefined) {
    console.warn('No "asr" column; scoring from "human" only.');
  }

  let scored = 0;
  let ambiguous = 0;
  let skipped = 0;
  let changed = 0;

  for (const row of rows.slice(1)) {
    if (!row.some((c) => c.trim())) continue;
    while (row.length < header.length) row.push('');

    const text = ((asrAt === undefined ? '' : row[asrAt]) || row[at.human] || '').trim();
    if (!text) {
      skipped++;
      continue;
    }

    const result = runArmA(engine, text);
    const updates = {
      A_entry: result.entry,
      A_tags: result.tags.join(';'),
      A_unknown: result.unknown ? '1' : '0',
    };
    for (const [key, value] of Object.entries(updates)) {
      if (row[at[key]] !== value) {
        row[at[key]] = value;
        changed++;
      }
    }
    scored++;
    if (result.asks) ambiguous++;
    const note = result.otherCrop ? ' (other crop)' : result.unknown ? ' (unknown)' : '';
    console.log(
      `${row[at.id]}: ${result.entry}${note} [${result.tags.join(',')}]` +
        `${result.asks ? '  <- would ask a question' : ''}`
    );
  }

  if (changed) writeFileSync(file, toCsv(rows), 'utf8');
  console.log(
    `\n${scored} row(s) scored, ${ambiguous} need a clarifying answer, ` +
      `${skipped} blank, ${changed} field(s) written.`
  );
}

const args = process.argv.slice(2);
const engine = loadEngine();
if (args[0] === '--self-check') {
  selfCheck(engine);
} else {
  fill(args[0] || join(here, 'score-sheet.csv'), engine);
}
