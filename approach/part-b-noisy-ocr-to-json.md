# Noisy Input → Structured JSON — Approach

## The brief

Ingest noisy images / OCR text (menus, business signs) and output structured JSON in two shapes:

- **Menu** — `[{ "item": string, "price": number }]`
- **Listing** — `[{ "name": string, "sector": string, "contact": string, "location": string }]`

## 1. Preprocessing pipeline

Noise is removed before the model ever sees the text — cleaning helps the OCR pass and the LLM equally. Concrete steps, each with a reason:

1. **Grayscale** — drops color-channel noise from signs/menus.
2. **Contrast boost / adaptive threshold** — separates text from table shadows and glare (menus photographed at tables).
3. **Denoise** (bilateral/median) — removes low-light OCR confetti.
4. **Perspective correction** — deskews the forced-perspective photo of a menu or storefront sign.
5. **Script-aware hinting** — tell the OCR/inference layer that non-Latin script (e.g. Amharic) is expected, so it stops mis-segmenting word boundaries; normalize whitespace after.

## 2. Extraction prompt

The prompt's three non-negotiables: **exact schema**, **null-over-fabricate**, **no markdown fences** (a fence is the #1 cause of unparseable output).

```
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

## 3. Validation & normalization

The extraction model is treated as unreliable — output is parsed and coerced deterministically:

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

## Why these choices

- **Null over fabricate** — a wrong price is worse than a missing one for anything that feeds a payments or inventory pipeline.
- **Deterministic guard over re-prompting** — "the model keeps emitting fences" is fixed in code with a three-line strip, not by arguing with the model. The prompt asks for clean JSON; the validator enforces it regardless.
- **Coercion centralized** — price normalization (`"1,500 ETB" → 1500`) lives in one function so the schema contract is testable in isolation.