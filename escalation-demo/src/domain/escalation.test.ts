import { describe, expect, it } from 'vitest';
import { transition, canTransition, TaskStateError, type Task, type TaskStatus } from './task';
import { EscalationEngine, createMemoryStore, ESCALATION_THRESHOLD_MS, type EscalationStore } from './escalation';

const T = ESCALATION_THRESHOLD_MS; // 90_000
const NOW = 1_700_000_000_000;

const pendingTask = (id: string, createdAt = NOW): Task => ({
  id,
  status: 'PENDING',
  createdAt,
  confirmedAt: null,
  escalationSentAt: null,
  version: 1,
});

function attach(store: EscalationStore) {
  const sent: string[] = [];
  const engine = new EscalationEngine(store, T, t => { sent.push(t.id); });
  return { engine, sent };
}

describe('task state machine', () => {
  it('follows the happy path and bumps version each write', () => {
    const confirmed = transition(pendingTask('t1'), 'CONFIRMED', NOW + 30_000);
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.confirmedAt).toBe(NOW + 30_000);
    expect(confirmed.version).toBe(2);
  });

  it('rejects impossible transitions', () => {
    expect(() => transition(pendingTask('t1'), 'FGODER')).toThrow(TaskStateError);
    expect(() => transition({ ...pendingTask('t1'), status: 'CONFIRMED' }, 'CANCELLED')).toThrow(TaskStateError);
  });

  it('is idempotent on repeat transitions (no version bump)', () => {
    const once = transition(pendingTask('t1'), 'CANCELLED');
    const twice = transition(once, 'CANCELLED');
    expect(twice.version).toBe(once.version);
  });

  it('terminal states have no outgoing transitions', () => {
    for (const status of ['CONFIRMED', 'CANCELLED'] as TaskStatus[]) {
      expect(canTransition(status, 'PENDING')).toBe(false);
    }
  });
});

describe('escalation timing', () => {
  it('does NOT escalate before the 90s threshold', () => {
    const store = createMemoryStore([pendingTask('t1', NOW)]);
    const { engine, sent } = attach(store);
    expect(engine.tick(NOW + 89_999)).toBe(0);
    expect(sent).toEqual([]);
    expect(store.byId('t1')!.escalationSentAt).toBeNull();
  });

  it('escalates exactly once at the threshold', () => {
    const store = createMemoryStore([pendingTask('t1', NOW)]);
    const { engine, sent } = attach(store);
    expect(engine.tick(NOW + T)).toBe(1);
    expect(sent).toEqual(['t1']);
    expect(store.byId('t1')!.escalationSentAt).toBe(NOW + T);
  });

  it('confirmed before the threshold never escalates', () => {
    const confirmed = transition(pendingTask('t1', NOW), 'CONFIRMED', NOW + 30_000);
    const { engine, sent } = attach(createMemoryStore([confirmed]));
    expect(engine.tick(NOW + 10 * T)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('cancelled tasks never escalate', () => {
    const cancelled = transition(pendingTask('t1', NOW), 'CANCELLED');
    const { engine, sent } = attach(createMemoryStore([cancelled]));
    expect(engine.tick(NOW + 10 * T)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('unknown task id is a safe no-op', () => {
    const { engine, sent } = attach(createMemoryStore([pendingTask('t1', NOW)]));
    expect(engine.triggerEscalation('nope', NOW + T)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('duplicate prevention', () => {
  it('two workers on the same store: only one wins each claim', () => {
    const store = createMemoryStore([pendingTask('t1', NOW)]);
    const sentA: string[] = [];
    const sentB: string[] = [];
    const a = new EscalationEngine(store, T, t => { sentA.push(t.id); });
    const b = new EscalationEngine(store, T, t => { sentB.push(t.id); });

    expect(a.tick(NOW + T)).toBe(1); // worker A claims
    expect(b.tick(NOW + T)).toBe(0); // worker B re-reads, sees escalationSentAt, no-op
    expect([...sentA, ...sentB]).toEqual(['t1']);
  });

  it('direct re-invocation of triggerEscalation is a no-op after the first claim', () => {
    const { engine, sent } = attach(createMemoryStore([pendingTask('t2', NOW)]));
    expect(engine.triggerEscalation('t2', NOW + T)).toBe(true);
    expect(engine.triggerEscalation('t2', NOW + T)).toBe(false);
    expect(engine.triggerEscalation('t2', NOW + 10 * T)).toBe(false);
    expect(sent).toEqual(['t2']);
  });
});

describe('restart survival', () => {
  it('catch-up: tasks that came due during downtime escalate on the next tick', () => {
    const store = createMemoryStore([pendingTask('t1', NOW)]);
    // process crashed at t=0 with no in-memory state; a fresh worker boots at +10min
    const { engine, sent } = attach(store);
    expect(engine.tick(NOW + 600_000)).toBe(1);
    expect(sent).toEqual(['t1']);
    expect(store.byId('t1')!.escalationSentAt).toBe(NOW + 600_000);
  });

  it('no re-send: already-escalated tasks stay sent across a restart', () => {
    const store = createMemoryStore([pendingTask('t1', NOW)]);
    expect(attach(store).engine.tick(NOW + T)).toBe(1); // worker #1 escalates
    const { engine, sent } = attach(store);             // worker #2 boots after "restart"
    expect(engine.tick(NOW + 600_000)).toBe(0);
    expect(sent).toEqual([]);
  });
});