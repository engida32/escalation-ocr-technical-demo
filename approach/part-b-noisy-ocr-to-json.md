# Part B — Noisy Input → Structured JSON: How We Got to the Answer

> A thinking-in-public log of how the pipeline, prompt, and validator were built.

## 1. The brief

Ingest noisy images / OCR text (menus, business signs) and output structured JSON in two shapes:

- **Menu** — `[{ "item": string, "price": number }]`
- **Listing** — `[{ "name": string, "sector": string, "contact": string, "location": string }]`

The input is *noisy* — glare, shadows, skew, bad light, non-Latin script. The output must be *structured and trusted* downstream.

## 2. First framing: two noise problems, not one

We get **visual** noise (a bent photo of a menu) and **textual** noise (OCR garbage, Amharic misread word boundaries). Each needs a different layer:

- visual noise → **preprocessing pipeline** before anything reads the pixels
- textual noise → **prompt policy + deterministic validation** after the model reads

Trying to fix visual noise in the prompt ("just read it better") wastes tokens and fails; trying to fix OCR garbage purely in preprocessing is impossible. Splitting the problem this way is what makes each layer small and testable.

## 3. Preprocessing pipeline — why each step exists

1. **Grayscale** — drop color-channel noise (yellow signs, blue menus) that confuses text detection.
2. **Contrast boost / adaptive threshold** — separate foreground glyphs from table shadows and glare; this is the difference between "menu on a café table" and "readable text."
3. **Denoise (bilateral/median)** — kills low-light sensor speckle, which OCR faithfully transcribes as garbage.
4. **Perspective correction** — deskew the forced-perspective photo of a menu/sign so rows line up like rows.
5. **Script-aware hinting** — tell the pipeline the text may be Amharic (Ge'ez script) so OCR selects a script-aware model and stops merging glyphs across word boundaries; normalize whitespace afterwards.

The list is ordered: each step feeds the next, pixel → geometry → text.

## 4. Prompt design — the three non-negotiables

Version 1 of the prompt ("extract items and prices") produced free-text answers and occasional prose. Two revisions later, three hard rules earned their place:

1. **Exact schema, in the prompt** — the model is told the precise output shape, so the JSON contract lives next to the code that validates it.
2. **No markdown fences, no prose** — "Return ONLY valid JSON". The fence is the #1 cause of unparseable output; state the prohibition, don't hope.
3. **Missing ≠ invented** — `null` for unreadable, never a guess. A wrong price is worse than a missing one for anything feeding a payments/inventory pipeline.

```text
Extract structured JSON from noisy OCR and photos of menus or business signs.
Return ONLY valid JSON — no prose, no markdown fences.

MENU -> array of {"item": string, "price": number | null}
  - item: best-guess name; "" if unreadable. Never invent items.
  - price: a number in ETB — strip currency symbols, commas, whitespace;
    if unreadable -> null, never a guess.

LISTING -> array of {"name": string, "sector": string,
                     "contact": string, "location": string}
  - any field you cannot read -> null. NEVER fabricate.
  - contact: keep only digits.
  - unknown fields do not change the schema.

Non-Latin / noisy text: keep the closest confident transliteration,
otherwise null. When ambiguous, prefer null over a guess.
```

Price coercion is inside the prompt ("strip currency symbols, commas") **and** in the validator below — defense in depth, since the two layers can disagree.

## 5. Validation — a trust boundary, not a formality

The model is treated as unreliable by default:

```ts
function normalize(json: string) {
  const cleaned = json.replace(/^```json?|```$/g, '').trim();   // fence strip
  let data; try { data = JSON.parse(cleaned); } catch { return []; }
  return (data || [])
    .filter(x => x && x.item)
    .map(x => ({ item: String(x.item).trim(),
                 price: normPrice(x.price) }));   // parseFloat on digits only; else null
}
```

- Fence-strip: the single most common failure ("it worked in my head, it didn't parse in code").
- No wrap in try/catch noise: a single `return []` on parse failure keeps the pipeline deterministic.
- `normPrice` coerces `"1,500 ETB" → 1500` and refuses anything without digits → `null`.

## 6. Alternatives considered and rejected

| Option | Verdict | Why |
|---|---|---|
| OCR-only (no LLM), custom parser | **Rejected** | Rule-based parsing of table layouts shatters on noisy, varied input; the generic-Language-model path generalizes |
| Re-prompt the model until output is clean | **Rejected** | A deterministic 3-line strip beats arguing with a model; also costs latency + tokens, and still fails on malformed JSON |
| Two-prompt routing (vision → extraction) | **Kept as extension** | One prompt with a discriminated schema suffices for the two given shapes; a multi-step "classify then extract" pass is the upgrade if shapes multiply |
| Schema-validate then re-attempt on failure | **Noted** | Good safety net; validator keeps the pipeline synchronous and fast at MVP |

## 7. AI collaboration log (kept / changed / rejected)

- **Drafted (kept):** the discrimination between Menu and Listing shapes, the `null`-over-fabricate policy, and the exact-schema prompt section.
- **Drafted (changed):** the first prompt allowed prose around the JSON; tightened to "return only valid JSON" with an explicit no-fences rule.
- **Drafted (rejected):** relying on the prompt alone to produce parseable output — overrode with the deterministic validator; **added by me, not re-prompted:** the fence-strip and price coercion live in code, not in the prompt's good intentions.

## 8. How this maps to the whole solution

"State/trust derived, never assumed" is the theme of both parts. Part A derives escalation due-ness from durable facts instead of trusting a timer; Part B validates extracted JSON instead of trusting the model. Same judgment pattern, two domains: **derive from something ground-truthy, and make the one dangerous action (re-sending, trusting output) a guarded, explicit decision.**