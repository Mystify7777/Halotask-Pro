import { describe, expect, it } from 'vitest';
import { describeRejections } from './rejections';

describe('describeRejections', () => {
  it('says nothing when nothing was refused', () => {
    expect(describeRejections([])).toBeNull();
  });

  it('names the change, the task and the status, and says it was not saved', () => {
    const text = describeRejections([{ type: 'update', taskId: 's1', title: 'Report', status: 400 }]);
    expect(text).toBe('Not saved: the server rejected the edit to “Report” (error 400). Showing what the server has.');
  });

  it('falls back to the title the app still knows, then to a generic name', () => {
    expect(describeRejections([{ type: 'delete', taskId: 's1', title: null, status: 403 }], () => 'Known')).toContain('deletion of “Known”');
    expect(describeRejections([{ type: 'delete', taskId: 's1', title: null, status: null }])).toContain('deletion of a task.');
  });

  it('a refused create reads as a new task and several refusals are summarised', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ type: 'create' as const, taskId: `local-${i}`, title: `T${i}`, status: 422 }));
    const text = describeRejections(items) as string;
    expect(text).toContain('new task “T0”');
    expect(text).toContain('and 2 more');
  });
});
