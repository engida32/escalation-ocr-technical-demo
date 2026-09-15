# Part A — Delayed Escalation: How We Got to the Answer

> A thinking-in-public log of the reasoning, dead ends, and decisions that produced `escalation-demo/`.

## 1. The brief

For tasks (`id`, `created_at`, `status` = `pending | confirmed | cancelled`): `triggerEscalation(taskId)` fires when a task is **not confirmed within 90 seconds** of `created_at`. The logic must be **persistent** and **survive server restarts seamlessly**.

Two load-bearing words: **"within 90 seconds"** and **"survive server restarts"**.

## 2. The first instinct

Set a timer when the task is created:

```
created → start a setTimeout(90s) → if not confirmed by then → escalate
```

This is the obvious first pass and it completely misses the second requirement. Where does that timer live? In process memory. If the process dies and comes back, every pending timer is gone — a task created just before the crash never escalates, and there is no trace left of why.

## 3. Stress-testing the naive answer

Ticked against the two requirements:

| Requirement | In-memory timer |
|---|---|
| Fire ~90s after creation | ✅ (while the process stays up) |
| Survive restarts | ❌ every pending deadline is silently lost |

**Decision: a deadline must never be something we *schedule* in memory — it has to be something we can *re-derive* from durable state at any moment.**

Reframed the problem: don't store the moment "when to escalate" at all. Store the facts (`created_at`, `confirmed_at`, `escalation_sent_at`) and compute "is it due?" as a pure function of them:

```
due = status == 'pending'
      AND escalation_sent_at IS NULL
      AND now - created_at >= 90s
```

Now a restart is a non-event: any process can compute "what's due" from the durable rows, whenever, with zero coordination. This is the same move as "ETA is derived, never stored" in dispatch systems — if something changes (speed, route), the value updates itself automatically.

## 4. The state machine

Before writing any logic, make the states a closed, guarded set:

```
PENDING → CONFIRMED | CANCELLED    (terminal: no outgoing edges)
```

- Illegal transitions **throw** — wrong states are *unrepresentable*, not just detected.
- Repeat transitions are a version-less **no-op** — a retried "confirm" can't double-apply.
- Every real transition bumps `version` — the optimistic lock every concurrent writer checks.

Without the table, code branches inevitably drift into states the model never allowed (e.g. escalate a cancelled task).

## 5. The race — how we caught the second bug before it existed

First design of the guard was a flag set in application code:

```
if (task.escalated) return           // ← looked right
task.escalated = true
send()
```

Then we thought about **two workers** scanning at the same moment. Both read `escalated == false`, both pass the check, both send. The check-then-set is two steps — any two-process race doubles the message.

**Fix: collapse check-and-set into one atomic write**, exactly like a dispatch system prevents two orders claiming one rider:

```sql
UPDATE tasks
SET escalation_sent_at = now(), version = version + 1
WHERE id = $id
  AND status = 'pending'                 -- confirmed/cancelled -> no-op (idempotent)
  AND escalation_sent_at IS NULL         -- already escalated   -> no-op (dedupe)
  AND created_at <= now() - interval '90 seconds';
-- 1 row = this worker won; 0 rows = already escalated / confirmed / not due
```

The preconditions live **in** the write. The database serializes contenders; exactly one gets `1 row`; everyone else gets a no-op they can read as "someone else handled it." No locks, no queue, nothing to debug.

## 6. Restart safety — why the poll loop needs no memory

```ts
tick(): number {
  let sent = 0;
  for (const task of store.scanDue(now, THRESHOLD))   // re-derive from durable rows
    if (this.triggerEscalation(task.id)) sent += 1;   // atomic claim, 1 winner
  return sent;
}
```

Run this every ~10 seconds. **Boot is just another tick** — the first scan after a crash re-derives everything that came due during downtime and escalates it, and skips anything already escalated. There is no `setTimeout` to lose and no warm-up state to rebuild. This is how "survive restarts seamlessly" is satisfied *by construction*, not by a clever scheduler.

## 7. Alternatives considered and rejected

| Option | Verdict | Why |
|---|---|---|
| In-memory `setTimeout` / scheduler | **Rejected** | Lost on restart; drifts under backpressure |
| Persist "escalate_at" timestamp + a job scheduler | **Rejected** | Extra infra (job store, retry, TTL); a derived scan gives the same behavior with nothing to keep in sync |
| App-level "escalated" boolean + check-then-set | **Rejected** | Two-step race → duplicate sends under concurrency |
| Locking / per-task mutex | **Rejected** | Overkill; the atomic conditional `UPDATE` is the lock |
| Kafka / job queue | **Rejected for now** | Correct but heavy at thousands of tasks; named as the upgrade path (below) |

## 8. Scale

The comment block that shipped with the code:

```
State lives in the DB, never in timers: a restart can't lose a deadline,
because "due" is re-derived from created_at on every scan.
The atomic conditional UPDATE (status='pending' AND escalation_sent_at IS NULL)
makes the send idempotent — exactly ONE worker wins per task, so thousands of
tasks and multiple pollers still produce zero duplicate escalations.
A confirmed task simply drops out of the WHERE clause → no race with the clock.
At thousands of tasks one indexed scan per tick is trivial; at millions, move
the due-scan to a job queue with lease/heartbeat (or SELECT ... SKIP LOCKED).
```

Why an indexed scan is fine: the query is `WHERE status='pending' AND escalation_sent_at IS NULL AND created_at <= $cutoff` — a small, indexable slice no matter how many tasks exist. The upgrade path (queue with lease/heartbeat, or `SKIP LOCKED`) is about *partitioning the scan across workers*, not about the escalation logic changing.

## 9. AI collaboration log (kept / changed / rejected)

- **Drafted (kept):** the guarded state-machine shape and the atomic `UPDATE ... WHERE status AND escalation_sent_at IS NULL` pattern.
- **Drafted (changed):** the initial scheduler sketch was timing-based with an app-level flag — the flag stayed but the check-then-set became the single atomic claim above; the timing model became derived due-ness.
- **Drafted (rejected):** the in-memory `setTimeout` framing as a complete solution — rejected on restart grounds before any code.
- **Added by me, not re-prompted:** the `tsc --noEmit` gate. This actually caught a real defect during the build: `moduleResolution: NodeNext` rejected extensionless relative imports, so the config was switched to bundler resolution. Green tests alone (Vitest strips types) would have shipped the bug silently.

## 10. Verification story

- **13 Vitest tests**, one per graded concern:
  - Timing — nothing before 90s (`tick(89_999)` → 0 sent), exactly one at the threshold.
  - No false positives — confirmed/cancelled tasks never escalate, even at 10× the threshold.
  - Dedup — two workers racing one task → one send; direct re-invocation → no-op.
  - Restart — task due during downtime escalates on first tick after boot; already-escalated rows are never re-sent.
- Both gates green before calling it done: `tsc --noEmit` **and** `vitest`.