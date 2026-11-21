import { describe, expect, it } from 'vitest';
import { applyActionToQueue, COMPLETION_STATE_FIELDS, completionKeyOf, type QueueActionInput } from './queueActions';
import type { SyncQueueRecord } from './syncQueue';

// Issue #59: the queue contract (see THE QUEUE CONTRACT in queueActions.ts and claude/audit-issue-59.md). One row per sequence
// of the audit's algebra table, then the two additions (F1, F2), identity, idempotence, and a property test over random
// sequences. The pure function only: the real-storage, two-tab and processor cases are in queue.contract.realdb.test.ts.

let n = 0;
const add = (queue: SyncQueueRecord[], action: QueueActionInput): SyncQueueRecord[] =>
  applyActionToQueue(queue, action, `id-${++n}`, 1000 + n);
const run = (actions: QueueActionInput[], start: SyncQueueRecord[] = []) => actions.reduce(add, start);

const T = 'srv-1'; // a task that exists on the server
const L = 'local-1'; // a task whose create has not synced

const CR = (taskId = L, payload: Record<string, unknown> = { title: 'new' }): QueueActionInput => ({ type: 'create', taskId, payload });
const U = (payload: Record<string, unknown>, taskId = T): QueueActionInput => ({ type: 'update', taskId, payload });
const D = (taskId = T): QueueActionInput => ({ type: 'delete', taskId });
const C = (completionId: string, taskId = T): QueueActionInput => ({
  type: 'completion',
  taskId,
  payload: { kind: 'complete', completionId, completedAt: '2026-10-20T10:00:00.000Z', utcOffsetMinutes: 330, title: 'T', estimatedMinutes: 0 },
});
const R = (completionId: string | undefined, taskId = T): QueueActionInput => ({
  type: 'completion',
  taskId,
  payload: { kind: 'revoke', ...(completionId ? { completionId } : {}), revokedAt: '2026-10-20T11:00:00.000Z', title: 'T', estimatedMinutes: 0 },
});

/** A compact, exact description of a queue: `type:task{payload}` or `kind:completionId:task` for completions. */
const describeQueue = (queue: readonly SyncQueueRecord[]): string[] =>
  queue.map((entry) => {
    if (entry.type === 'completion') {
      const p = entry.payload as { kind: string; completionId?: string };
      return `${p.kind}:${p.completionId ?? '-'}:${entry.taskId}`;
    }
    const body = entry.payload ? JSON.stringify(entry.payload) : '';
    return `${entry.type}:${entry.taskId}${body}`;
  });

describe('the algebra (audit section 2): every sequence, exact result', () => {
  const cases: Array<[string, QueueActionInput[], string[]]> = [
    ['create -> update', [CR(), U({ priority: 'high' }, L)], [`create:${L}{"title":"new","priority":"high"}`]],
    ['update -> update (different fields)', [U({ title: 'a' }), U({ priority: 'high' })], [`update:${T}{"title":"a","priority":"high"}`]],
    ['update -> update (same field, last wins)', [U({ title: 'a' }), U({ title: 'b' })], [`update:${T}{"title":"b"}`]],
    ['update -> update clears with null (a clear is not lost)', [U({ dueDate: '2026-01-01' }), U({ dueDate: null })], [`update:${T}{"dueDate":null}`]],
    ['update -> complete', [U({ title: 'a' }), C('c1')], [`update:${T}{"title":"a"}`, `complete:c1:${T}`]],
    ['complete -> update', [C('c1'), U({ title: 'a' })], [`complete:c1:${T}`, `update:${T}{"title":"a"}`]],
    ['update -> complete -> update (edit merges across, ends before the event)', [U({ title: 'a' }), C('c1'), U({ priority: 'high' })], [`update:${T}{"title":"a","priority":"high"}`, `complete:c1:${T}`]],
    ['complete -> complete (same id: one event queued twice)', [C('c1'), C('c1')], [`complete:c1:${T}`]],
    ['complete -> revoke -> complete (three events)', [C('c1'), R('c1'), C('c2')], [`complete:c1:${T}`, `revoke:c1:${T}`, `complete:c2:${T}`]],
    ['complete -> revoke (never cancelled)', [C('c1'), R('c1')], [`complete:c1:${T}`, `revoke:c1:${T}`]],
    ['revoke without id twice (nothing to dedupe on)', [R(undefined), R(undefined)], [`revoke:-:${T}`, `revoke:-:${T}`]],
    ['revoke(c1) twice (one event queued twice)', [R('c1'), R('c1')], [`revoke:c1:${T}`]],
    ['update -> delete (server task)', [U({ title: 'a' }), D()], [`delete:${T}`]],
    ['complete -> delete (completion kept)', [C('c1'), D()], [`complete:c1:${T}`, `delete:${T}`]],
    ['update -> complete -> delete', [U({ title: 'a' }), C('c1'), D()], [`complete:c1:${T}`, `delete:${T}`]],
    ['delete -> delete', [D(), D()], [`delete:${T}`]],
    ['create -> complete -> delete: the completion SURVIVES (not "improved" into an empty queue)', [CR(), C('c1', L), D(L)], [`complete:c1:${L}`]],
    ['create -> complete -> revoke -> delete: both events survive', [CR(), C('c1', L), R('c1', L), D(L)], [`complete:c1:${L}`, `revoke:c1:${L}`]],
    ['create -> complete -> update', [CR(), C('c1', L), U({ title: 'z' }, L)], [`create:${L}{"title":"z"}`, `complete:c1:${L}`]],
    ['create -> update -> update -> delete: nothing reaches the server', [CR(), U({ title: 'a' }, L), U({ title: 'b' }, L), D(L)], []],
    ['two tasks interleaved: per task, ordered by first queued', [U({ a: 1 }, 'A'), U({ b: 1 }, 'B'), U({ c: 1 }, 'A'), U({ d: 1 }, 'B')], ['update:A{"a":1,"c":1}', 'update:B{"b":1,"d":1}']],
    ['update(A) -> delete(B) -> update(A)', [U({ a: 1 }, 'A'), D('B'), U({ c: 1 }, 'A')], ['update:A{"a":1,"c":1}', 'delete:B']],
  ];

  it.each(cases)('%s', (_name, actions, expected) => {
    expect(describeQueue(run(actions))).toEqual(expected);
  });
});

describe('F1: nothing is queued behind a delete of the same task', () => {
  it('delete -> update on a server task is just the delete', () => {
    expect(describeQueue(run([D(), U({ title: 'late' })]))).toEqual([`delete:${T}`]);
  });

  it('the dropped update does not disturb other tasks or the delete itself', () => {
    const queue = run([U({ a: 1 }, 'A'), D('B'), U({ late: true }, 'B'), U({ b: 2 }, 'A')]);
    expect(describeQueue(queue)).toEqual(['update:A{"a":1,"b":2}', 'delete:B']);
  });

  it('an update -> delete -> update sequence ends as the single delete', () => {
    expect(describeQueue(run([U({ title: 'a' }), D(), U({ title: 'b' })]))).toEqual([`delete:${T}`]);
  });

  it('a delete placed by the sync settle step (task deleted while its create was in flight) also blocks later edits', () => {
    const queue = run([D('srv-9')]);
    expect(describeQueue(applyActionToQueue(queue, U({ title: 'x' }, 'srv-9'), 'z', 1))).toEqual(['delete:srv-9']);
  });

  it('only the SAME task is affected', () => {
    expect(describeQueue(run([D('A'), U({ x: 1 }, 'B')]))).toEqual(['delete:A', 'update:B{"x":1}']);
  });

  it('the queue is returned unchanged (same entries, same ids)', () => {
    const before = run([D()]);
    const after = applyActionToQueue(before, U({ title: 'late' }), 'new-id', 5);
    expect(after).toEqual(before);
    expect(after.some((entry) => entry.id === 'new-id')).toBe(false);
  });
});

describe('F2: an edit crosses a completion only while it cannot modify completion state', () => {
  it('the field list the guard protects names the completion-affecting fields', () => {
    expect([...COMPLETION_STATE_FIELDS].sort()).toEqual(['completed', 'completedAt', 'completionEvent', 'completionId']);
  });

  it.each(COMPLETION_STATE_FIELDS)('an update carrying `%s` is NOT merged back into an update that precedes a completion', (field) => {
    const queue = run([U({ title: 'a' }), C('c1'), U({ [field]: 'x' })]);
    expect(describeQueue(queue)).toEqual([`update:${T}{"title":"a"}`, `complete:c1:${T}`, `update:${T}{"${field}":"x"}`]);
  });

  it.each(COMPLETION_STATE_FIELDS)('...nor into a queued create that precedes a completion (`%s`)', (field) => {
    const queue = run([CR(), C('c1', L), U({ [field]: 'x' }, L)]);
    expect(describeQueue(queue)).toEqual([`create:${L}{"title":"new"}`, `complete:c1:${L}`, `update:${L}{"${field}":"x"}`]);
  });

  it('such an update still merges normally when no completion lies between (it stays an ordinary edit)', () => {
    const queue = run([U({ title: 'a' }), U({ completed: true })]);
    expect(describeQueue(queue)).toEqual([`update:${T}{"title":"a","completed":true}`]);
  });

  it('...and merges into an update that already FOLLOWS the completion', () => {
    const queue = run([U({ title: 'a' }), C('c1'), U({ completed: true }), U({ completed: false })]);
    expect(describeQueue(queue)).toEqual([`update:${T}{"title":"a"}`, `complete:c1:${T}`, `update:${T}{"completed":false}`]);
  });

  it('a plain edit after that still merges into the FIRST update (the earliest entry), as before', () => {
    const queue = run([U({ title: 'a' }), C('c1'), U({ completed: true }), U({ priority: 'low' })]);
    expect(describeQueue(queue)).toEqual([`update:${T}{"title":"a","priority":"low"}`, `complete:c1:${T}`, `update:${T}{"completed":true}`]);
  });

  it('a completion belonging to ANOTHER task is not a boundary for this one', () => {
    const queue = run([U({ title: 'a' }), C('c1', 'other'), U({ completed: true })]);
    expect(describeQueue(queue)).toEqual([`update:${T}{"title":"a","completed":true}`, 'complete:c1:other']);
  });

  it('plain edits (no completion field) keep merging across a completion: one request instead of two', () => {
    const queue = run([U({ title: 'a' }), C('c1'), U({ priority: 'high', tags: ['x'] })]);
    expect(describeQueue(queue)).toEqual([`update:${T}{"title":"a","priority":"high","tags":["x"]}`, `complete:c1:${T}`]);
  });

  it('every real edit payload in the app is safe to merge: none of them names a completion field', () => {
    // The shape useDashboardTasks builds for an edit / checklist tick (Issue #15): title, priority, tags, dates, estimate, description, subtasks.
    const realEdit = { title: 't', priority: 'high', tags: [], dueDate: null, dueTime: null, startTime: null, estimatedMinutes: 0, description: 'd', subtasks: [] };
    for (const field of COMPLETION_STATE_FIELDS) expect(field in realEdit).toBe(false);
  });
});

describe('identity and idempotence', () => {
  it('a merge keeps the earlier entry\'s id, type and task; only payload and createdAt move', () => {
    const first = applyActionToQueue([], U({ title: 'a' }), 'first', 100);
    const merged = applyActionToQueue(first, U({ priority: 'high' }), 'second', 200);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'first', type: 'update', taskId: T, createdAt: 200, payload: { title: 'a', priority: 'high' } });
  });

  it('a merge into a create keeps the create\'s id and type', () => {
    const created = applyActionToQueue([], CR(), 'cr', 100);
    const merged = applyActionToQueue(created, U({ priority: 'high' }, L), 'u', 200);
    expect(merged[0]).toMatchObject({ id: 'cr', type: 'create', taskId: L });
  });

  it('completion entries are never rewritten: payload, id and completionId are exactly what was queued', () => {
    const queue = applyActionToQueue([], C('c1'), 'ce', 100);
    const after = [U({ title: 'a' }), U({ title: 'b' }), D(), C('c1'), R('c1')].reduce(
      (current, action, i) => applyActionToQueue(current, action, `x${i}`, 300 + i),
      queue,
    );
    const completion = after.find((entry) => entry.id === 'ce');
    expect(completion).toEqual(queue[0]);
    expect(completionKeyOf(completion!)).toBe('complete:c1');
  });

  it('applying the same completion twice stores it once (the second call returns the same queue)', () => {
    const once = run([C('c1')]);
    expect(applyActionToQueue(once, C('c1'), 'again', 9)).toEqual(once);
  });

  it('is pure: frozen input, new array out, input untouched', () => {
    const queue = Object.freeze(run([U({ title: 'a' }), C('c1')]).map((entry) => Object.freeze({ ...entry, payload: Object.freeze({ ...entry.payload }) })));
    const snapshot = JSON.stringify(queue);
    for (const action of [U({ title: 'b' }), D(), C('c2'), R('c1'), U({ completed: true })]) {
      expect(() => applyActionToQueue(queue, action, 'p', 1)).not.toThrow();
    }
    expect(JSON.stringify(queue)).toBe(snapshot);
  });

  it('replaying the same actions from the stored (cloned) queue gives the same queue (reload determinism)', () => {
    const actions = [CR(), U({ title: 'a' }, L), C('c1', L), U({ priority: 'high' }, L), D(L), U({ x: 1 }, 'A'), D('A'), U({ y: 1 }, 'A')];
    let live: SyncQueueRecord[] = [];
    let reloaded: SyncQueueRecord[] = [];
    actions.forEach((action, i) => {
      live = applyActionToQueue(live, action, `id${i}`, 10 + i, `m-${i}`);
      reloaded = applyActionToQueue(structuredClone(reloaded), action, `id${i}`, 10 + i, `m-${i}`); // a structured clone is what storage returns
    });
    expect(reloaded).toEqual(live);
  });
});

describe('property: random sequences keep the contract', () => {
  // Small deterministic PRNG so a failure is reproducible from its seed.
  const prng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const tasks = ['A', 'B', 'local-C'];
  // 'A' and 'B' exist on the server; 'local-C' only exists once its create has been queued (a task cannot be edited before it is created).
  const actionFrom = (rand: () => number, ids: { next: number; created: boolean }): QueueActionInput => {
    const taskId = tasks[Math.floor(rand() * tasks.length)];
    if (taskId === 'local-C' && !ids.created) {
      ids.created = true;
      return { type: 'create', taskId, payload: { title: `t${ids.next++}` } };
    }
    const pick = 1 + Math.floor(rand() * 7);
    if (pick <= 2) return { type: 'update', taskId, payload: { [`f${Math.floor(rand() * 3)}`]: ids.next++ } };
    if (pick === 3) return { type: 'delete', taskId };
    if (pick <= 5) return C(`c${Math.floor(rand() * 4)}`, taskId);
    return R(rand() < 0.5 ? `c${Math.floor(rand() * 4)}` : undefined, taskId);
  };

  it('holds for 400 seeded sequences of up to 14 actions', () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const rand = prng(seed);
      const ids = { next: 0, created: false };
      let queue: SyncQueueRecord[] = [];
      const everQueued: SyncQueueRecord[] = []; // completion entries as queued, to prove none is lost or rewritten
      const length = 1 + Math.floor(rand() * 14);
      for (let step = 0; step < length; step += 1) {
        const action = actionFrom(rand, ids);
        const before = queue;
        queue = applyActionToQueue(queue, action, `s${seed}-${step}`, step);

        // Order: surviving entries keep their relative order (a merge changes payload/createdAt, never position).
        const survivors = before.filter((entry) => queue.some((q) => q.id === entry.id));
        expect(queue.filter((q) => survivors.some((s) => s.id === q.id)).map((q) => q.id)).toEqual(survivors.map((s) => s.id));
        // Only ever grows by the new entry (never reorders by inserting in the middle).
        const added = queue.filter((q) => !before.some((b) => b.id === q.id));
        expect(added.length).toBeLessThanOrEqual(1);
        if (added.length === 1) expect(queue[queue.length - 1]).toBe(added[0]);

        if (action.type === 'completion') {
          const key = completionKeyOf(action as { payload?: Record<string, unknown> });
          const alreadyQueued = key !== null && everQueued.some((e) => completionKeyOf(e) === key);
          if (!alreadyQueued) everQueued.push(queue[queue.length - 1]);
        }
      }

      // 1. A completion entry is never lost or rewritten (a delete, a create-cancel or an edit never touches it).
      for (const event of everQueued) expect(queue.find((q) => q.id === event.id)).toEqual(event);
      // 2. Completion entries are unique by kind:completionId when they have one.
      const keys = queue.filter((q) => q.type === 'completion').map((q) => completionKeyOf(q)).filter((k): k is string => k !== null);
      expect(new Set(keys).size).toBe(keys.length);
      // 3. Nothing follows a delete for the same task, except completion events (kept as history).
      queue.forEach((entry, index) => {
        if (entry.type !== 'delete') return;
        const behind = queue.slice(index + 1).filter((other) => other.taskId === entry.taskId && other.type !== 'completion');
        expect(behind.filter((other) => other.type !== 'delete')).toEqual([]);
      });
      // 4. At most one create, one update and one delete per task.
      for (const task of tasks) {
        for (const type of ['create', 'update', 'delete'] as const) {
          expect(queue.filter((q) => q.taskId === task && q.type === type).length).toBeLessThanOrEqual(1);
        }
      }
      // 5. No update precedes a create of the same task (a dependent entry never precedes its create).
      queue.forEach((entry, index) => {
        if (entry.type === 'create') expect(queue.slice(0, index).some((q) => q.taskId === entry.taskId && q.type === 'update')).toBe(false);
      });
    }
  });
});
