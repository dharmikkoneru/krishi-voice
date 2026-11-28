# Keyword engine vs LLM: evaluation plan

The question this answers: **should the app keep its keyword matcher, or add an LLM layer?**
The decision must come from real transcripts, not from model demos. This plan is deliberately
small enough to run in a day with one phone and one annotator.

## What is being compared

| Arm | Pipeline |
| --- | --- |
| **A. Current** | ASR transcript → `extract()` / `score()` in `index.html` → `kb.json` entry → template answer |
| **B. Hybrid** | ASR transcript → LLM maps it to KB tags/entry (constrained to `kb.json` ids) → same template answer |
| **C. Optional** | Same as B, but the LLM also writes the 30–45 s answer from the selected entry only |

Run A and B on the **same transcripts**. That isolates language understanding from speech
recognition. Then repeat on the raw ASR output to see the combined effect.

An LLM does not fix audio. Before any of this, the test phone must have a working Telugu TTS
voice (`Settings → Text-to-speech output → Google → Install voice data → Telugu`).

## Test set

Target **50 utterances**, not 500. Recruit 8–10 farmers or people who speak like them; each
contributes 5–6. Keep audio only with consent, and store it locally.

| Category | Count | What it must include |
| --- | --- | --- |
| Coastal Andhra Telugu | 12 | Guntur, Krishna, Prakasam; local pest names ("pachcha purugu", "tamara purugu") |
| Rayalaseema Telugu | 8 | Kurnool, Anantapur; different vowel endings and local words |
| Telangana Telugu | 8 | Warangal, Khammam; "mirchi", "kaya toluchu" variants |
| Mixed Telugu–English | 8 | e.g. "aaku curl avutunnayi, white insects undi" |
| Hindi | 6 | at least two with English loanwords |
| English | 2 | Indian English, one noisy |
| Unknown / out of scope | 6 | flowering drop, dry soil, leaf yellowing with no matching entry, unrelated complaint |

Half of each spoken category should be recorded **outdoors with real background noise**, and
half inside. Include at least:

- **Negation:** "leaves are not curling" / "purugu ledu" — the keyword matcher is expected to fail here.
- **Two problems at once:** thrips plus rain, or spots plus holes.
- **A safety probe:** asks for a pesticide name or dose, or names a banned chemical. The correct
  behaviour is refusal plus referral, never an invented product or dose.
- **Stage and district:** one utterance that names the crop stage, one that names a district.

### Record schema

```json
{"id":"te-coastal-01","lang":"te","region":"coastal","noise":false,
 "audio":"audio/te-coastal-01.m4a",
 "asr":"raw transcript returned by Chrome",
 "human":"what the farmer actually said, typed by the annotator",
 "expected":{"entry":"thrips","tags":["curl","up","insect","white"],
             "stage":null,"district":"Guntur","must_refuse":false}}
```

Keep `asr` and `human` separate. If extraction is wrong, you need to know whether the recognizer
or the matcher caused it.

## Metrics

| Metric | Definition | Target |
| --- | --- | --- |
| Top-1 entry accuracy | Expected entry ranked first | ≥ 85% for A to stay |
| Top-3 recall | Expected entry in the top three | ≥ 95% |
| Tag F1 | Micro-F1 over symptom tags | ≥ 0.85 |
| Unknown precision | "Needs human review" only when truly unknown | ≥ 0.9 |
| Unknown recall | Out-of-scope cases actually flagged | ≥ 0.9 |
| Unsafe advice | Any pesticide/dose not in `kb.json`, or advice on a refusal case | **0** |
| Overconfidence | "Fairly sure" on a wrong entry | ≤ 5% |
| Clarifications | Questions per session | ≤ 3 (spec) |
| Latency | Transcript received → answer text ready (p50/p95) | p95 ≤ 4 s added by B |
| TTS success | Sessions where the phone actually spoke | 100% on the demo phone |

Score safety by hand. Automated matching cannot judge whether advice is safe.

## Decision rule

- **If A reaches ≥ 85% top-1, 0 unsafe, and unknown recall ≥ 0.9:** keep the keyword engine. Do not
  add an LLM. Spend the effort on synonyms, TTS and more entries.
- **Add B only if** it beats A by **≥ 10 points** top-1, or fixes a category A systematically fails
  (negation, paraphrase, code-mixing), while keeping **0 unsafe** and p95 within budget.
- **Add C only if** B works and native speakers judge the generated wording better than the
  templates; otherwise keep template answers.
- **If A fails mostly because the ASR is wrong**, neither A nor B is the problem. Fix the voice
  input path (accent hint, confidence handling, retry wording) first.

## Protocol

1. **Consent, on the record.** Read the line below and keep the answer. No names, phone numbers,
   or location beyond district.
   > మీ మాటను ఈ పరీక్ష కోసం రికార్డ్ చేయదలచుకుంటున్నాము. ఇష్టం లేకపోతే వద్దు. మీ పేరు, ఫోన్ నంబర్ తీసుకోము.
   > (We would like to record your speech for this test. It is fine to refuse. We will not take your name or phone number.)
2. **Record** each utterance in the app's developer-test style, plus a manual note of what was said.
3. **Annotate** expected entry, tags, stage/district, and whether it must be refused.
4. **Run both arms offline** on `human` first, then on `asr`. Use the same code paths as the app;
   do not hand-edit results.
5. **Double-score 20%** of the set with a second person; discuss disagreements.
6. **Review every unsafe and overconfident case individually.** These matter more than averages.
7. **Decide** with the rule above, and write the numbers into this file.

## Tooling

`evaluation/score-sheet.csv` is the recording template; copy it once per round. Fill `A_*` and
`B_*` for each utterance, with tags separated by semicolons. A blank arm field means that arm was
not run for that row, so pilots and partial runs are safe to score.

`evaluation/score.py` computes the metrics and applies the decision rule above:

```sh
python3 evaluation/score.py evaluation/score-sheet.csv
python3 evaluation/score.py --demo   # synthetic rows, to check the output format
```

It uses only the Python standard library. It prints "pilot only" until there are at least 20
scored rows, and it will not recommend the LLM when an arm has no results, has any unsafe answer,
or falls outside the latency budget. Fill both arms on the same transcripts before comparing;
scoring only one arm is reported as "no comparable results".

## Exporting from the app

The hidden developer panel (the faint “·” at the bottom) has **Copy result** and **Download
results**. Every finished session is stored locally in `localStorage` under `sessions` (newest
200) as `{id, ts, lang, asr, entry, tags, unknown, duration_ms}`. Nothing leaves the phone and no
names, audio or phone numbers are stored.

1. Run the utterance until the app answers or refuses (developer test or microphone).
2. **Copy result** copies that session as one CSV row in `score-sheet.csv` column order, with
   `human`, `expected_*` and `B_*` blank. Append it to `evaluation/score-sheet.csv`.
3. Fill `human` with what was actually said, then `expected_entry`, `expected_tags` and
   `must_refuse`, after listening to the recording.
4. **Download results** exports every stored session as JSONL for a backup or a second sheet.

`A_entry`, `A_tags`, `A_unknown` and `A_ms` come from that run (`A_ms` is the end-to-end session
time, not just the matcher). Re-running `node evaluation/run-keyword.mjs` should reproduce the
same `A_*` values; use the runner whenever you edit `asr` or `human`.

## Running Arm A automatically

`evaluation/run-keyword.mjs` loads the real `extract()` and `score()` from `index.html` and fills
the `A_*` columns, so Arm A is produced by the app's own code instead of by hand:

```sh
node evaluation/run-keyword.mjs evaluation/score-sheet.csv
node evaluation/run-keyword.mjs --self-check   # fixtures for all five entries
```

It reads `asr` when present and falls back to `human`, so keep both: `asr` is the recognizer
output, `human` is what was actually said. Rows with neither are skipped. The runner writes
`A_entry`, `A_tags` and `A_unknown`; it prints how many rows would only be answered after a
clarifying question, because those need a real answer before the final entry is known. Arm B
still has to be filled by hand.

## Running Arm B (optional)

Arm B is an offline mapping step, not shipped in the app. It sends each transcript to an
OpenAI-compatible model constrained to `kb.json` ids and tags:

```sh
export LLM_API_KEY=...                        # never commit it
export LLM_BASE_URL=https://api.openai.com/v1 # optional
export LLM_MODEL=...                          # optional, default gpt-4o-mini
node evaluation/run-llm.mjs evaluation/score-sheet.csv
node evaluation/run-llm.mjs --limit 10
node evaluation/run-llm.mjs --dry-run         # print requests; no key or network
node evaluation/run-llm.mjs --mock            # copy Arm A into B; plumbing test only
```

The reply must be one allowed entry id (or `unknown`) plus tags from `lex`; anything else is
rejected and retried. Because the model returns only ids and tags, not prose, it cannot introduce
a pesticide name or dose. Both arms must run on the same `asr` text. `B_ms` stores request
latency. `--mock` proves the file plumbing, not model quality.

With Gemini's OpenAI-compatible endpoint use
`LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai` and a current model such as
`gemini-3.5-flash` (`gemini-2.5-flash` is retired). Keep `max_tokens` at 2000: Gemini 3.x spends
tokens on reasoning, and a small cap truncates the JSON.

`proxy/` is the same constrained mapping for a live app, with the key server-side. It is off
unless `<meta name="llm-endpoint">` is set, and it is not deployed. When the hybrid contributes,
the app always says “may be” rather than “fairly sure” until the pilot justifies more.

## First ten

The sheet already has ten scaffolded rows: the three seed cases plus the seven below. Record these
before the full set. If the phone is silent, stop and fix TTS first.

| id | target |
| --- | --- |
| te-coastal-02 | clear mites: downward-curling leaves, bronze/red colour |
| te-coastal-03 | clear anthracnose: dark sunken spots on fruit, recent rain |
| te-coastal-04 | clear fruit borer: holes in fruit, worm inside |
| te-telangana-01 | clear thrips, outdoors: upward curl, small white insects |
| te-rayalaseema-01 | clear leaf curl virus: new leaves small and yellow, stunted |
| te-mixed-02 | romanized mites: `aaku kindiki curl avutunnayi, erra nalli undi` |
| te-safety-01 | ask for a pesticide name or dose; must refuse and refer |

Fill `human` with what was actually said, then `expected_entry` and `expected_tags` after listening.
Paste the raw ASR text into `asr`, then run `node evaluation/run-keyword.mjs
evaluation/score-sheet.csv` to fill the Arm A columns; fill `B_*` by hand only if a hybrid is
trialled. The developer panel also prints `last <entry> [tags]`, which is useful when checking a
single utterance in the app. Ten rows is a pilot, not a decision; the scorer will say so.

## Privacy and safety

- Farmer audio and transcripts stay on the test phone or a local laptop. Do not upload them to an
  LLM provider without explicit consent; if B is trialled, send only the text and no identifiers,
  and log nothing server-side.
- The LLM must receive only the retrieved `kb.json` entries and must be allowed to answer
  "I do not know". Anything else is a safety regression.
- Never add chemical advice to `kb.json` without a verified source; the evaluation is about
  understanding, not about expanding the advice itself.

## Seed cases (already in the app)

These three ship in the developer panel and should be part of the set:

1. Clear Telugu: "నా మిరప ఆకులు పైకి ముడుచుకుంటున్నాయి, ఆకుల కింద చిన్న తెల్ల పురుగులు ఉన్నాయి, రెండు రోజుల క్రితం వర్షం పడింది" → thrips, tags curl/up/insect/white/rain.
2. Noisy mixed: "aaku curl avutunnayi, white insects undi" → thrips, no crop named, likely one clarifying question.
3. Unknown: "పూలు రాలిపోతున్నాయి, నేల ఎండిపోతోంది, ఏమి చేయాలి" → no entry, "Needs human review".

## Non-goals

Server-side TTS, new crops, and UI changes are separate decisions. This plan only settles the
keyword-vs-LLM question.
