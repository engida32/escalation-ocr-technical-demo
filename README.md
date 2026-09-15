# Technical Challenge — Escalation & OCR Extraction

A two-part full-stack technical challenge, solved with verified code and a written approach.

## Parts

| Part | Problem | Location |
|---|---|---|
| **A — Delayed Escalation** | Restart-safe "escalate a task if it isn't confirmed within 90s", so no timer is lost and no duplicate send happens. | `escalation-demo/` (TS + Vitest, passing) · `approach/part-a-delayed-escalation.md` |
| **B — Noisy Input → Structured JSON** | Noisy OCR / photos of menus and business signs → clean, validated JSON (`menu` and `listing` shapes). | `approach/part-b-noisy-ocr-to-json.md` |

## Quick start (Part A)

```bash
cd escalation-demo
npm install
npm test          # Vitest — 13 tests
npm run typecheck # tsc --noEmit
```

## The approach in one line

State lives in durable storage and is **derived on every pass** — never in memory — so a restart is a non-event, and every state-changing write is a **single atomic guard** so exactly one claim wins any race.