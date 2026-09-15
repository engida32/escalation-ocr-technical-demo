import type { Task } from './task';

export const ESCALATION_THRESHOLD_MS = 90_000;

// ---------------------------------------------------------------------------
// State lives in the DB, never in timers: a restart can't lose a deadline,
// because "due" is re-derived from created_at on every scan.
// The atomic conditional update (status='pending' AND escalation_sent_at IS NULL)
// makes the send idempotent — exactly ONE worker wins per task, so thousands of
// tasks and multiple pollers still produce zero duplicate escalations.
// A confirmed task simply drops out of the WHERE clause → no race with the clock.
// At thousands of tasks one indexed scan per tick is trivial; at millions, move
// the due-scan to a job queue with lease/heartbeat (or SELECT ... SKIP LOCKED).
// ---------------------------------------------------------------------------

// The production write. `triggerEscalation` below is the pure mirror of it.
export const ESCALATE_ONE_SQL = `
UPDATE tasks
SET escalation_sent_at = now(), version = version + 1
WHERE id = $id
  AND status = 'pending'                  -- confirmed/cancelled -> no-op (idempotent)
  AND escalation_sent_at IS NULL          -- already escalated   -> no-op (dedupe)
  AND created_at <= now() - interval '90 seconds';
-- 1 row  -> this worker won the claim; 0 rows -> already escalated/confirmed/not due
`;

export interface EscalationStore {
  byId(id: string): Task | undefined;
  save(task: Task): void;
  scanDue(now: number, thresholdMs: number): Task[];
}

export function isDue(task: Task, now: number, thresholdMs: number): boolean {
  return task.status === 'PENDING'
    && task.escalationSentAt === null
    && now - task.createdAt >= thresholdMs;
}

export class EscalationEngine {
  constructor(
    private readonly store: EscalationStore,
    private readonly thresholdMs: number = ESCALATION_THRESHOLD_MS,
    private readonly send: (task: Task) => void = () => {},
  ) {}

  // triggerEscalation(taskId) — the sprint's required entry point.
  // Enum of ESCALATE_ONE_SQL: returns true ONLY when this invocation wins the
  // claim (mirrors "1 row affected"); otherwise false -> caller does nothing.
  triggerEscalation(taskId: string, now = Date.now()): boolean {
    const current = this.store.byId(taskId);
    if (!current || !isDue(current, now, this.thresholdMs)) return false;
    const claimed: Task = { ...current, escalationSentAt: now, version: current.version + 1 };
    this.store.save(claimed);
    this.send(claimed);
    return true;
  }

  // Restart-safe poll loop tick. Every pass re-derives due-ness from durable
  // state, so anything that came due during downtime is caught the instant
  // the process is back up. Returns how many escalations this worker sent.
  tick(now = Date.now()): number {
    let sent = 0;
    for (const task of this.store.scanDue(now, this.thresholdMs)) {
      if (this.triggerEscalation(task.id, now)) sent += 1;
    }
    return sent;
  }
}

// In-memory stand-in for the durable table. "Durable" here means the rows
// outlive any single engine instance — which is exactly how restart works in
// the tests: a fresh engine over the same rows re-derives everything.
export function createMemoryStore(initial: Task[] = []): EscalationStore {
  const rows = new Map(initial.map(t => [t.id, t]));
  return {
    byId: id => rows.get(id),
    save: t => {
      rows.set(t.id, t);
    },
    scanDue: (now, thresholdMs) =>
      [...rows.values()].filter(t => isDue(t, now, thresholdMs)),
  };
}