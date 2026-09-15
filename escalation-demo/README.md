# escalation-demo

A minimal, verified implementation of **restart-safe delayed escalation** for the full-stack technical challenge.

## Problem

For tasks (`id`, `created_at`, `status` = `pending | confirmed | cancelled`), escalate a task if it is not confirmed within 90 seconds — persistently, surviving server restarts, with no duplicate escalations.

## Run

```bash
npm install
npm test          # Vitest — 13 tests
npm run typecheck # tsc --noEmit
```

## Design

- **State machine** (`src/domain/task.ts`): `PENDING → CONFIRMED | CANCELLED`. Illegal transitions throw; repeat transitions are a version-less no-op; every real write bumps `version` (optimistic lock).
- **Derived due-ness, not timers** (`src/domain/escalation.ts`): a task is "due" when `status='pending' AND escalation_sent_at IS NULL AND now - created_at >= 90s`. Because due-ness is re-derived from durable rows on every pass, a restart loses nothing — the poll loop catches everything overdue during downtime on the first tick after boot.
- **Atomic claim**: `triggerEscalation(id)` is a guarded write mirroring

  ```sql
  UPDATE tasks SET escalation_sent_at = now(), version = version + 1
  WHERE id = $id AND status = 'pending'
    AND escalation_sent_at IS NULL AND created_at <= now() - interval '90 seconds'
  ```

  returning `true` only when this invocation wins — so any number of workers racing one task produce **exactly one send**. `ESCALATE_ONE_SQL` ships beside the pure mirror so code and SQL can't drift.
- **Storage**: `createMemoryStore()` stands in for the durable table; "durability" is modelled correctly — rows outlive any single engine instance, which is how the restart tests work.

## Tests (13)

- **State machine** — happy path + version bumps, illegal transitions throw, repeat transitions don't bump, terminal states are closed.
- **Timing** — nothing before 90s, exactly one escalation at the threshold, unknown id is a safe no-op.
- **No false positives** — confirmed and cancelled tasks never escalate, even at 10× the threshold.
- **Duplicate prevention** — two workers sharing a store → one send; direct re-invocation → no-op.
- **Restart survival** — task due during downtime escalates on the next tick; already-escalated tasks are not re-sent.

## Layout

```
src/domain/
  task.ts             state machine (status, transitions, version)
  escalation.ts       derived due-ness, atomic claim, poll loop, store interface
  escalation.test.ts  the 13 verification tests
```