# Delayed Escalation Logic — Approach

## The brief

For tasks (`id`, `created_at`, `status` = `pending | confirmed | cancelled`):

- `triggerEscalation(taskId)` fires when a task is **not confirmed within 90 seconds** of `created_at`.
- The logic must be **persistent** and **survive server restarts seamlessly**.

## The core decision — no timers

The natural first pass is an in-memory 90-second timer. The problem: a timer lives only in process memory, so a restart silently drops every pending deadline — a task that came due during a reboot would never escalate.

Design rule: **state lives in durable storage; "due" is re-derived from persisted facts on every pass.**

- Persisted facts: `created_at`, `confirmed_at`, `escalation_sent_at`.
- Derived rule: `due == status='pending' AND escalation_sent_at IS NULL AND now - created_at >= 90s`.

A restart is therefore a non-event: the poll loop re-scans durable rows, so anything overdue during downtime escalates on the first tick after boot.

## The state machine

`PENDING → CONFIRMED | CANCELLED`. Terminal states have no outgoing transitions, and illegal transitions throw — **wrong states are unrepresentable, not just detected.** Every real transition bumps a `version` field (the optimistic lock that makes concurrent writers safe); repeat transitions are a version-less no-op, so a retried callback cannot apply twice.

```ts
export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING:   ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

export function transition(task: Task, to: TaskStatus, now = Date.now()): Task {
  if (task.status === to) return task;           // idempotent retry: no-op, no bump
  if (!canTransition(task.status, to)) throw new TaskStateError(task.status, to);
  return {
    ...task, status: to,
    confirmedAt: to === 'CONFIRMED' ? now : task.confirmedAt,
    version: task.version + 1,
  };
}
```

## The atomic claim

Escalation is one guarded write — the same shape as an "atomic seat grab":

```sql
UPDATE tasks
SET escalation_sent_at = now(), version = version + 1
WHERE id = $id
  AND status = 'pending'                 -- confirmed/cancelled -> no-op (idempotent)
  AND escalation_sent_at IS NULL         -- already escalated   -> no-op (dedupe)
  AND created_at <= now() - interval '90 seconds';
-- 1 row = this worker won the claim; 0 rows = already escalated / confirmed / not due
```

`triggerEscalation(taskId)` mirrors this exactly and returns `true` only when this invocation wins the write. Because the write itself encodes all preconditions, any number of workers can race a single task and **exactly one send happens**. This is the same version-guard pattern used to prevent double-claims in dispatch systems (one order per rider).

## Restart-safe loop

A poller scans due rows every ~10 seconds and re-attempts the claim per task:

```ts
triggerEscalation(taskId: string): boolean {
  const current = store.byId(taskId);
  if (!current || !isDue(current, now, THRESHOLD)) return false; // 0 rows -> no-op
  const claimed = { ...current, escalationSentAt: now, version: current.version + 1 };
  store.save(claimed);
  send(claimed);
  return true;
}

tick(): number {                       // re-derives due-ness from durable state
  let sent = 0;
  for (const task of store.scanDue(now, THRESHOLD))
    if (this.triggerEscalation(task.id)) sent += 1;
  return sent;
}
```

## Scale

One indexed scan over pending-and-due rows is trivial at thousands of tasks. The upgrade path at higher volume: a job queue with lease + heartbeat, or `SELECT ... SKIP LOCKED`, so multiple workers **partition** the scan instead of replaying it.

## Verification

- `tsc --noEmit` — clean.
- Vitest — **13 passing**:
  - State machine: happy path + version bumps; illegal transitions throw; repeat is a no-bump no-op; terminal states closed.
  - Timing: nothing before 90s; exactly one escalation at 90s; unknown id = safe no-op.
  - No false positives: confirmed and cancelled tasks never escalate, even at 10× the threshold.
  - Duplicate prevention: two workers racing one task → one send; direct re-invocation → no-op.
  - Restart survival: task that came due during downtime escalates on first tick after boot; already-escalated tasks are not re-sent.

## Design discussion

- **Why not `setTimeout`?** A timer is lost on restart and drifts under backpressure; a derived rule degrades gracefully by construction.
- **Confirm at 89s?** `status='pending'` drops the task before the clock rule is even consulted — no race with the deadline.
- **Double invocation?** The second claim reads `escalation_sent_at != null` → 0 rows → no-op. Idempotent by construction.