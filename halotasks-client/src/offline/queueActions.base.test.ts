import { describe, expect, it } from 'vitest';
import { applyActionToQueue, type QueueActionInput } from './queueActions';
import type { SyncQueueRecord } from './syncQueue';

// Issue #62B, queue contract rule 7: how `base` (the server-derived value at the start of the first unsent edit of a field, D11)
// behaves when edits are merged. Pure, no storage.

let n = 0;
const add = (queue: SyncQueueRecord[], action: QueueActionInput): SyncQueueRecord[] => applyActionToQueue(queue, action, `id-${++n}`, 1000 + n);
const update = (payload: Record<string, unknown>, base?: Record<string, unknown>, rebase = false): QueueActionInput => ({ type: 'update', taskId: 'a', payload, ...(base ? { base } : {}), ...(rebase ? { rebase } : {}) });

describe('base in the queue', () => {
  it('a new update entry stores the base it was given', () => {
    expect(add([], update({ title: 'B' }, { title: 'A' }))[0].base).toEqual({ title: 'A' });
  });

  it('later edits never move the base of a field the entry holds (A, B, C, D -> base A)', () => {
    let queue = add([], update({ title: 'B' }, { title: 'A' }));
    queue = add(queue, update({ title: 'C' }, { title: 'B' }));
    queue = add(queue, update({ title: 'D' }, { title: 'C' }));
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ payload: { title: 'D' }, base: { title: 'A' } });
  });

  it('a field the entry does not hold yet takes the new edit\'s base', () => {
    let queue = add([], update({ title: 'B' }, { title: 'A' }));
    queue = add(queue, update({ priority: 'high' }, { priority: 'low' }));
    expect(queue[0].base).toEqual({ title: 'A', priority: 'low' });
  });

  it('an entry without a base stays without one, whatever is merged into it', () => {
    let queue = add([], update({ title: 'B' }));
    queue = add(queue, update({ priority: 'high' }, { priority: 'low' }));
    expect('base' in queue[0]).toBe(false);
  });

  it('a create never has a base, even when an update with one is merged into it', () => {
    let queue = add([], { type: 'create', taskId: 'a', payload: { title: 'New' } });
    queue = add(queue, update({ title: 'Newer' }, { title: 'New' }));
    expect(queue[0].type).toBe('create');
    expect('base' in queue[0]).toBe(false);
    expect(queue[0].payload).toEqual({ title: 'Newer' });
  });

  it('only a resolution (rebase) replaces a base, and the instruction itself is never stored', () => {
    let queue = add([], update({ title: 'B' }, { title: 'A' }));
    queue = add(queue, update({ title: 'Mine' }, { title: 'Theirs' }, true));
    expect(queue[0].base).toEqual({ title: 'Theirs' });
    expect('rebase' in queue[0]).toBe(false);
  });

  it('an update queued behind a completion merges into the earlier update keeping its base; a completion has none', () => {
    let queue = add([], update({ title: 'B' }, { title: 'A' }));
    queue = add(queue, { type: 'completion', taskId: 'a', payload: { kind: 'complete', completionId: 'c', completedAt: '2026-10-20T10:00:00.000Z', utcOffsetMinutes: 0 } });
    queue = add(queue, update({ title: 'C' }, { title: 'B' }));
    expect(queue.map((e) => e.type)).toEqual(['update', 'completion']);
    expect(queue[0].base).toEqual({ title: 'A' });
    expect('base' in queue[1]).toBe(false);
  });
});
