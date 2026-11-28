// Arm A: the app's own keyword engine, loaded from index.html so the
// evaluation cannot drift from the shipped matcher.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export function loadEngine() {
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const start = html.indexOf('const norm=s=>');
  const end = html.indexOf('const lab=');
  if (start < 0 || end <= start) {
    throw new Error(
      'Could not find the matching functions in index.html ' +
        '(looked for "const norm=s=>" ... "const lab=").'
    );
  }
  const code = html.slice(start, end);
  const kb = JSON.parse(readFileSync(join(root, 'kb.json'), 'utf8'));
  return new Function('KB', code + '\nreturn { extract, score };')(kb);
}

export function runArmA(engine, text) {
  const x = engine.extract(text);
  if (x.otherCrop && !x.crop) {
    // The refusal does not use the extracted symptoms, so it contributes no tags to F1.
    return { entry: 'unknown', tags: [], unknown: true, asks: false, otherCrop: true };
  }
  const ranked = engine.score(x);
  const [top, second] = ranked;
  const unknown = !top || top.n === 0;
  return {
    entry: unknown ? 'unknown' : top.e.id,
    tags: [...x.tags].sort(),
    unknown,
    otherCrop: false,
    // Same first-pass condition as answer(): a question comes before any answer.
    asks: !unknown && top.n < 4 && top.n - (second ? second.n : 0) < 2,
  };
}
