// Keep in sync with ../kb.json. `node proxy/check-constraints.mjs` fails if they drift.
export const ENTRIES = {
  thrips: ['curl', 'up', 'insect', 'white'],
  mites: ['curl', 'down', 'bronze'],
  virus: ['curl', 'yellow', 'stunt', 'white'],
  anthracnose: ['spots', 'fruit', 'rain'],
  borer: ['hole', 'fruit', 'caterpillar'],
};

export const TAGS = [
  'curl',
  'up',
  'down',
  'insect',
  'white',
  'yellow',
  'spots',
  'fruit',
  'hole',
  'caterpillar',
  'stunt',
  'bronze',
  'rain',
];
