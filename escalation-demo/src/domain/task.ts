export type TaskStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED';

export interface Task {
  id: string;
  status: TaskStatus;
  createdAt: number;              // ms epoch — persisted, survives restart
  confirmedAt: number | null;     // set once, atomically, on CONFIRMED
  escalationSentAt: number | null; // set once, atomically — THE dedupe guard
  version: number;                // every real write bumps it (optimistic lock)
}

export class TaskStateError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`invalid transition ${from} -> ${to}`);
    this.name = 'TaskStateError';
  }
}

export const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  PENDING:   ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function transition(task: Task, to: TaskStatus, now = Date.now()): Task {
  if (task.status === to) return task; // idempotent retry: no-op, no version bump
  if (!canTransition(task.status, to)) throw new TaskStateError(task.status, to);
  return {
    ...task,
    status: to,
    confirmedAt: to === 'CONFIRMED' ? now : task.confirmedAt,
    version: task.version + 1,
  };
}