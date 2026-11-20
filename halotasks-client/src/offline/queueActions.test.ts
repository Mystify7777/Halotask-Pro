import { describe, expect, it } from 'vitest';
import { applyActionToQueue, type QueueActionInput } from './queueActions';
import type { SyncQueueRecord } from './syncQueue';

// Issue #57: the queue's merge policy moved out of enqueueSyncAction into a pure function so it can run inside the same
// IndexedDB transaction as the task list. These tests pin the policy (it must not change) and the per-task ordering the
// issue requires: entries keep their position or are removed, and new work goes to the end.

let n = 0;
const add = (queue: SyncQueueRecord[], action: QueueActionInput): SyncQueueRecord[] => applyActionToQueue(queue, action, `id-${++n}`, 1000 + n);
const run = (actions: QueueActionInput[], start: SyncQueueRecord[] = []) => actions.reduce(add, start);
const shape = (queue: SyncQueueRecord[]) => queue.map((e) => `${e.type}:${e.taskId}`);

const complete = (taskId: string, completionId: string): QueueActionInput => ({
  type: 'completion',
  taskId,
  payload: { kind: 'complete', completionId, completedAt: '2026-10-20T10:00:00.000Z', utcOffsetMinutes: 0 },
});
const revoke = (taskId: string, completionId: string): QueueActionInput => ({
  type: 'completion',
  taskId,
  payload: { kind: 'revoke', completionId, revokedAt: '2026-10-20T11:00:00.000Z' },
});

describe('applyActionToQueue', () => {
  it('is pure: the input queue is never changed and a new array is returned', () => {
    const queue = run([{ type: 'update', taskId: 'a', payload: { title: 'x' } }]);
    const frozen = Object.freeze([...queue]);
    const next = applyActionToQueue(frozen, { type: 'update', taskId: 'a', payload: { priority: 'high' } }, 'z', 5);
    expect(next).not.toBe(frozen);
    expect(frozen[0].payload).toEqual({ title: 'x' });
    expect(next[0].payload).toEqual({ title: 'x', priority: 'high' });
  });

  it('merges an update into the task\'s queued create, then into a queued update, later fields winning', () => {
    const q1 = run([
      { type: 'create', taskId: 'local-1', payload: { title: 'A', priority: 'low' } },
      { type: 'update', taskId: 'local-1', payload: { title: 'B' } },
    ]);
    expect(q1).toHaveLength(1);
    expect(q1[0]).toMatchObject({ type: 'create', payload: { title: 'B', priority: 'low' } });

    const q2 = run([
      { type: 'update', taskId: 's1', payload: { title: 'A' } },
      { type: 'update', taskId: 's1', payload: { title: 'B', priority: 'high' } },
    ]);
    expect(q2).toHaveLength(1);
    expect(q2[0].payload).toEqual({ title: 'B', priority: 'high' });
  });

  it('cancels a queued create when the task is deleted before it ever reached the server', () => {
    expect(run([
      { type: 'create', taskId: 'local-1', payload: { title: 'A' } },
      { type: 'update', taskId: 'local-1', payload: { title: 'B' } },
      { type: 'delete', taskId: 'local-1' },
    ])).toEqual([]);
  });

  it('a delete drops the task\'s queued updates, is queued once, and never drops completion entries', () => {
    const q = run([
      { type: 'update', taskId: 's1', payload: { title: 'A' } },
      complete('s1', 'c1'),
      { type: 'delete', taskId: 's1' },
      { type: 'delete', taskId: 's1' },
    ]);
    expect(shape(q)).toEqual(['completion:s1', 'delete:s1']);
  });

  it('completion entries are never merged, keep their order, and are idempotent by kind and completionId', () => {
    const q = run([complete('s1', 'c1'), revoke('s1', 'c1'), complete('s1', 'c2'), complete('s1', 'c2'), revoke('s1', 'c1')]);
    expect(q.map((e) => `${e.payload?.kind}:${e.payload?.completionId}`)).toEqual(['complete:c1', 'revoke:c1', 'complete:c2']);
  });

  it('the issue\'s sequence (edit title, complete, edit priority, delete) never reorders what remains', () => {
    const steps: QueueActionInput[] = [
      { type: 'update', taskId: 's1', payload: { title: 'T' } },
      complete('s1', 'c1'),
      { type: 'update', taskId: 's1', payload: { priority: 'high' } },
    ];
    // After the edits: one merged update (kept at its original place, ahead of the completion) and the completion.
    const mid = run(steps);
    expect(shape(mid)).toEqual(['update:s1', 'completion:s1']);
    expect(mid[0].payload).toEqual({ title: 'T', priority: 'high' });
    // The delete then removes the update and goes last.
    expect(shape(add(mid, { type: 'delete', taskId: 's1' }))).toEqual(['completion:s1', 'delete:s1']);
  });

  it('a dependent entry never precedes its create, and work for different tasks keeps its relative order', () => {
    const q = run([
      { type: 'create', taskId: 'local-1', payload: { title: 'A' } },
      { type: 'update', taskId: 's2', payload: { title: 'B' } },
      complete('local-1', 'c1'),
      { type: 'create', taskId: 'local-2', payload: { title: 'C' } },
    ]);
    expect(shape(q)).toEqual(['create:local-1', 'update:s2', 'completion:local-1', 'create:local-2']);
  });
});
