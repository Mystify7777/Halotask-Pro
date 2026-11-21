import { describe, expect, it } from 'vitest';
import { applyActionToQueue, newMutationId, type QueueActionInput } from './queueActions';
import type { SyncQueueRecord } from './syncQueue';
import { chunkPlan, payloadAppliedBy, type PlannedMutation } from './batchTransport';

// Issue #60, rule 6 of the queue contract: a mutation id names the payload as it was last changed. A new entry gets its own;
// every merge (which changes a payload under the same entry id) gets a NEW one; nothing else touches it.

const add = (queue: SyncQueueRecord[], action: QueueActionInput, mutationId: string, id = `e${queue.length}`) => applyActionToQueue(queue, action, id, 10, mutationId);

describe('mutation ids in the queue', () => {
  it('every new entry carries the mutation id it was queued with, and gets a fresh one by default', () => {
    const queue = add([], { type: 'create', taskId: 'local-1', payload: { title: 'a' } }, 'm-1');
    expect(queue[0].mutationId).toBe('m-1');
    const defaulted = applyActionToQueue([], { type: 'update', taskId: 'A', payload: { title: 'x' } });
    expect(defaulted[0].mutationId).toMatch(/^m-.{8,}/);
    expect(newMutationId()).not.toBe(newMutationId());
  });

  it('a merge keeps the entry id and gets a NEW mutation id (an update into an update, and an update into a create)', () => {
    let queue = add([], { type: 'update', taskId: 'A', payload: { title: 'one' } }, 'm-1', 'u');
    queue = add(queue, { type: 'update', taskId: 'A', payload: { priority: 'high' } }, 'm-2');
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 'u', mutationId: 'm-2', payload: { title: 'one', priority: 'high' } });

    let created = add([], { type: 'create', taskId: 'local-1', payload: { title: 'a' } }, 'm-3', 'c');
    created = add(created, { type: 'update', taskId: 'local-1', payload: { description: 'd' } }, 'm-4');
    expect(created[0]).toMatchObject({ id: 'c', mutationId: 'm-4' });
  });

  it('entries that are not merged into keep the mutation id they have', () => {
    let queue = add([], { type: 'update', taskId: 'A', payload: { title: 'one' } }, 'm-1', 'u');
    queue = add(queue, { type: 'update', taskId: 'B', payload: { title: 'b' } }, 'm-2', 'u2');
    queue = add(queue, { type: 'delete', taskId: 'C' }, 'm-3', 'd');
    expect(queue.map((e) => [e.id, e.mutationId])).toEqual([['u', 'm-1'], ['u2', 'm-2'], ['d', 'm-3']]);
  });

  it('a duplicate completion event changes nothing (it keeps the first entry and its mutation id)', () => {
    const event: QueueActionInput = { type: 'completion', taskId: 'A', payload: { kind: 'complete', completionId: 'c1', completedAt: 'x', utcOffsetMinutes: 0 } };
    let queue = add([], event, 'm-1', 'k');
    queue = add(queue, event, 'm-2');
    expect(queue).toHaveLength(1);
    expect(queue[0].mutationId).toBe('m-1');
  });

  it('an edit that cannot merge across a completion becomes its own entry with its own mutation id', () => {
    let queue = add([], { type: 'update', taskId: 'A', payload: { title: 'one' } }, 'm-1', 'u');
    queue = add(queue, { type: 'completion', taskId: 'A', payload: { kind: 'complete', completionId: 'c1', completedAt: 'x', utcOffsetMinutes: 0 } }, 'm-2', 'k');
    queue = add(queue, { type: 'update', taskId: 'A', payload: { completed: true } }, 'm-3', 'u2');
    expect(queue.map((e) => [e.id, e.mutationId])).toEqual([['u', 'm-1'], ['k', 'm-2'], ['u2', 'm-3']]);
  });

  it('never gives two live entries the same mutation id (random sequences)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    let queue: SyncQueueRecord[] = [];
    for (let i = 0; i < 300; i += 1) {
      const task = ['A', 'B', 'C'][Math.floor(rand() * 3)];
      const kind = rand();
      const action: QueueActionInput =
        kind < 0.6 ? { type: 'update', taskId: task, payload: { title: `t${i}` } } : kind < 0.85 ? { type: 'completion', taskId: task, payload: { kind: 'complete', completionId: `c${i}`, completedAt: 'x', utcOffsetMinutes: 0 } } : { type: 'delete', taskId: task };
      queue = applyActionToQueue(queue, action);
      const ids = queue.map((e) => e.mutationId);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('batch planning helpers', () => {
  const planned = (n: number, payload: Record<string, unknown> = { title: 't' }): PlannedMutation[] =>
    Array.from({ length: n }, (_, i) => ({ entryId: `e${i}`, mutation: { mutationId: `m-${i}`, type: 'update', task: { id: `srv-${i}` }, payload } }));

  it('chunkPlan keeps order and never exceeds 50 mutations', () => {
    expect(chunkPlan(planned(0))).toEqual([]);
    expect(chunkPlan(planned(50)).map((c) => c.length)).toEqual([50]);
    expect(chunkPlan(planned(51)).map((c) => c.length)).toEqual([50, 1]);
    expect(chunkPlan(planned(120)).flat().map((p) => p.entryId)).toEqual(planned(120).map((p) => p.entryId));
  });

  it('chunkPlan splits by size too, and always puts at least one mutation in a chunk', () => {
    const big = planned(3, { title: 'x'.repeat(400_000) });
    expect(chunkPlan(big).map((c) => c.length)).toEqual([1, 1, 1]);
    expect(chunkPlan(planned(1, { title: 'x'.repeat(900_000) })).map((c) => c.length)).toEqual([1]);
  });

  it('payloadAppliedBy keeps the fields the server task already holds, and always keeps completion fields', () => {
    expect(payloadAppliedBy({ title: 'T', priority: 'low', tags: ['a'] }, { title: 'T', priority: 'high', tags: ['a'], completed: true })).toEqual({ title: 'T', tags: ['a'], completed: true });
    expect(payloadAppliedBy(undefined, { title: 'T' })).toEqual({});
    expect(payloadAppliedBy({}, undefined)).toEqual({});
  });
});
