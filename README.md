# Krishi Voice – voice-first chilli advisory (prototype)

Mobile-first web app for small farmers in Andhra Pradesh / Telangana. The farmer speaks a crop problem and hears a short answer in Telugu, Hindi or English. Uses the Web Speech API (Chrome on Android) and a local knowledge base (`kb.json`). Answers come only from the knowledge base; otherwise the app shows "Needs human review" and refers the farmer to the agriculture officer. It never invents pesticide names or doses.

## Run
Needs http(s) for the microphone and for loading `kb.json`.
- **GitHub Pages:** Settings → Pages → deploy from `main` / root. Open the URL on Android Chrome.
- **Local:** `python3 -m http.server`, then open http://localhost:8000
- **Developer test:** tap the faint “·” at the bottom for three pre-recorded inputs (clear Telugu, noisy mixed, unknown problem).

## Files
- `index.html` – UI, speech flow, matching logic, UI strings (`STR`)
- `kb.json` – entries, synonyms, symptom words, labels

## Add a crop
In `kb.json`:
1. Add the crop's names to `cropnames` and its display name to `crop`.
2. Add objects to `entries`:
```json
{"id":"example","names":["local name","standard name"],"tags":["curl","yellow"],"rc":3,
 "q":{"tag":"yellow","en":"Are the leaves yellow?","te":"...","hi":"..."},
 "en":{"n":"name","a":"non-chemical action","v":"thing to avoid"},
 "te":{"n":"","a":"","v":""},"hi":{"n":"","a":"","v":""}}
```
`tags` are symptom keys from `lex`; `rc` is recheck days, used both for the “look again in N days” line and the reminder question; `q` is the clarifying question. Only add chemical advice if it comes from a verified source.

## Add a synonym (local pest or symptom name)
- Pest name: append to that entry's `names` (e.g. "pachcha purugu" → thrips).
- Symptom word: append to a list in `lex` (native script or romanized).

## Add a language
1. `index.html`: add a key to `LANGS` (`bcp` speech code, `i`, `li` index) and a full set of strings in `STR`.
2. `kb.json`: add a third/fourth value to each `labels` array and each `heard` phrase, a field to every entry and every `q`, and the language to `crop`, `yes`, `no`, `cmd`.
3. Add a language button in the `#langs` div. Check the language is detected in `detect()` if it uses a new script.

## Limits
Extraction is keyword-based, not an LLM. To use an LLM, replace `extract()`/`answer()` with a server call that is restricted to retrieved `kb.json` entries. Telugu and Hindi strings are drafts; have a native speaker review them. Chrome's recognizer ignores noise-suppression settings, so noisy input relies on the confidence check.
