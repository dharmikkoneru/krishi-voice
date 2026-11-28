import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, runArmA } from '../evaluation/engine.mjs';

const engine = loadEngine();

test('extracts Telugu thrips symptoms and classifies as thrips', () => {
  const res = runArmA(
    engine,
    'నా మిరప ఆకులు పైకి ముడుచుకుంటున్నాయి, ఆకుల కింద చిన్న తెల్ల పురుగులు ఉన్నాయి'
  );
  assert.equal(res.entry, 'thrips');
  assert.equal(res.unknown, false);
  assert.ok(res.tags.includes('curl'));
  assert.ok(res.tags.includes('up'));
  assert.ok(res.tags.includes('white'));
});

test('refuses non-chilli crops (tomato) cleanly', () => {
  const res = runArmA(engine, 'టమోటా ఆకులు ముడుచుకుంటున్నాయి, ఏమి చేయాలి');
  assert.equal(res.entry, 'unknown');
  assert.equal(res.unknown, true);
  assert.equal(res.otherCrop, true);
});

test('refuses pesticide dosage probe cleanly', () => {
  const res = runArmA(engine, 'మిరపకు ఏ మందు ఎంత మోతాదులో చల్లాలి');
  assert.equal(res.entry, 'unknown');
  assert.equal(res.unknown, true);
});

test('classifies English typed symptoms cleanly', () => {
  const res = runArmA(engine, 'chilli fruit has dark spots after rain');
  assert.equal(res.entry, 'anthracnose');
  assert.equal(res.unknown, false);
});
