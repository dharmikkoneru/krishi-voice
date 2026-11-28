#!/usr/bin/env node
// The proxy cannot import kb.json in every runtime, so it carries a copy.
// This check keeps that copy honest.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ENTRIES, TAGS } from './constraints.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const kb = JSON.parse(readFileSync(join(here, '..', 'kb.json'), 'utf8'));

const expected = Object.fromEntries(
  kb.entries.map((e) => [e.id, [...e.tags].sort().join(',')])
);
const actual = Object.fromEntries(
  Object.entries(ENTRIES).map(([id, tags]) => [id, [...tags].sort().join(',')])
);
const expectedTags = Object.keys(kb.lex).sort().join(',');
const actualTags = [...TAGS].sort().join(',');

const problems = [];
for (const id of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
  if (expected[id] !== actual[id]) {
    problems.push(`entry ${id}: kb.json [${expected[id] || 'missing'}] vs proxy [${actual[id] || 'missing'}]`);
  }
}
if (expectedTags !== actualTags) {
  problems.push(`tags: kb.json [${expectedTags}] vs proxy [${actualTags}]`);
}

if (problems.length) {
  console.error('proxy/constraints.mjs is out of date:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`proxy constraints match kb.json (${Object.keys(expected).length} entries, ${TAGS.length} tags).`);
