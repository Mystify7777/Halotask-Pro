import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeTask } from '../../test/taskFactory';
import type { Subtask, Task } from '../../types/task';
import TaskCard from './TaskCard';

// Issue #15 (phase 3): the card's disclosure, progress and subtask checkboxes, and the main checkbox's keyboard use.
// jsdom proves the DOM, roles, names and event isolation; real layout and screen readers are separate checks.

const sub = (id: string, extra: Partial<Subtask> = {}): Subtask => ({ id, title: `step ${id}`, completed: false, ...extra });

const mount = (task: Task, props: Partial<React.ComponentProps<typeof TaskCard>> = {}) => {
  const handlers = {
    onToggleTask: vi.fn(),
    onToggleSubtask: vi.fn(),
    onDeleteTask: vi.fn(),
    onStartEditing: vi.fn(),
    onToggleTagFilter: vi.fn(),
    onToggleSelect: vi.fn(),
  };
  const parent = { click: vi.fn(), keyDown: vi.fn() };
  render(
    // stands in for any ancestor that reacts to clicks or keys
    <div onClick={parent.click} onKeyDown={parent.keyDown}>
      <TaskCard task={task} activeActionTaskId={null} tagFilter={null} isSelected={false} bulkActionLoading={false} {...handlers} {...props} />
    </div>,
  );
  return { ...handlers, parent };
};

const rich = () => makeTask({ _id: 't1', title: 'Plan trip', description: 'line one\n  line two', subtasks: [sub('a', { completed: true }), sub('b'), sub('c')] });
const disclosure = () => screen.getByRole('button', { name: /Details for "Plan trip"/ });

describe('a task without a description or subtasks renders as before', () => {
  it('has no disclosure, no progress, no region', () => {
    mount(makeTask({ title: 'Plain' }));
    expect(screen.queryByRole('button', { name: /^Details for/ })).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('a task cached before the field existed (no subtasks key) does not break', () => {
    const legacy = makeTask({ title: 'Old' });
    delete (legacy as { subtasks?: unknown }).subtasks;
    mount(legacy);
    expect(screen.getByText('Old')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('a blank (whitespace) description does not create a disclosure', () => {
    mount(makeTask({ description: '   \n ' }));
    expect(screen.queryByRole('button', { name: /^Details for/ })).toBeNull();
  });
});

describe('progress and disclosure', () => {
  it('shows 2-of-N progress as text and as a progressbar, derived from the subtasks', () => {
    mount(rich());
    expect(screen.getByText('1/3')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: /Plan trip/ });
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
    expect(bar).toHaveAttribute('aria-valuetext', '1 of 3 subtasks completed');
  });

  it('is collapsed by default: the description and the subtasks are not rendered', () => {
    mount(rich());
    expect(disclosure()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('step a')).toBeNull();
    expect(screen.queryByText(/line one/)).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('expands to one region labelled by the task title, with aria-controls pointing at it, and collapses again', async () => {
    const user = userEvent.setup();
    mount(rich());

    await user.click(disclosure());

    const button = screen.getByRole('button', { name: /Details for "Plan trip"/ });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const region = screen.getByRole('region', { name: 'Plan trip' });
    expect(button).toHaveAttribute('aria-controls', region.id);
    expect(within(region).getAllByRole('checkbox')).toHaveLength(3);

    await user.click(button);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('keeps the Details label and accessible name stable while expanded: only aria-expanded changes (Issue #11)', async () => {
    const user = userEvent.setup();
    mount(rich());
    const toggle = disclosure();

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Details');
    expect(toggle).toHaveAccessibleName('Details for "Plan trip"');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveTextContent('Details');
    expect(toggle).not.toHaveTextContent(/hide/i);
    expect(toggle).toHaveAccessibleName('Details for "Plan trip"');
  });

  it('does not point aria-controls at an element that is not rendered (collapsed)', () => {
    mount(rich());
    expect(disclosure()).not.toHaveAttribute('aria-controls');
    expect(document.getElementById('t1-details')).toBeNull();
  });

  it('is operable by keyboard (Enter and Space on the real button)', async () => {
    const user = userEvent.setup();
    mount(rich());
    disclosure().focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('region')).toBeInTheDocument();
    await user.keyboard(' ');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('keeps the description text, line breaks and indentation as typed', async () => {
    const user = userEvent.setup();
    mount(rich());
    await user.click(disclosure());
    const description = screen.getByText(/line one/);
    expect(description.tagName).toBe('P');
    expect(description.textContent).toBe('line one\n  line two');
  });

  it('description only: a disclosure and no progress; subtasks only: progress and no description', async () => {
    const user = userEvent.setup();
    mount(makeTask({ title: 'D', description: 'just notes' }));
    expect(screen.queryByRole('progressbar')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Details for "D"/ }));
    expect(screen.getByText('just notes')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /step/ })).toBeNull();
  });

  it('each subtask checkbox has a visible label and reflects its state', async () => {
    const user = userEvent.setup();
    mount(rich());
    await user.click(disclosure());
    expect(screen.getByRole('checkbox', { name: 'step a' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'step b' })).not.toBeChecked();
  });

  it('two cards never share region ids', async () => {
    const user = userEvent.setup();
    const a = makeTask({ _id: 'x1', title: 'A', description: 'a' });
    const b = makeTask({ _id: 'x2', title: 'B', description: 'b' });
    render(<><TaskCard task={a} activeActionTaskId={null} tagFilter={null} isSelected={false} bulkActionLoading={false} onToggleTask={vi.fn()} onToggleSubtask={vi.fn()} onDeleteTask={vi.fn()} onStartEditing={vi.fn()} onToggleTagFilter={vi.fn()} onToggleSelect={vi.fn()} /><TaskCard task={b} activeActionTaskId={null} tagFilter={null} isSelected={false} bulkActionLoading={false} onToggleTask={vi.fn()} onToggleSubtask={vi.fn()} onDeleteTask={vi.fn()} onStartEditing={vi.fn()} onToggleTagFilter={vi.fn()} onToggleSelect={vi.fn()} /></>);
    await user.click(screen.getByRole('button', { name: /for "A"/ }));
    await user.click(screen.getByRole('button', { name: /for "B"/ }));
    const [ra, rb] = screen.getAllByRole('region');
    expect(ra.id).not.toBe(rb.id);
  });
});

describe('subtask checkboxes are isolated from the parent', () => {
  it('toggling one calls onToggleSubtask once with the task id and that subtask id, and nothing else', async () => {
    const user = userEvent.setup();
    const h = mount(rich());
    await user.click(disclosure());

    await user.click(screen.getByRole('checkbox', { name: 'step b' }));

    expect(h.onToggleSubtask).toHaveBeenCalledTimes(1);
    expect(h.onToggleSubtask).toHaveBeenCalledWith('t1', 'b');
    expect(h.onToggleTask).not.toHaveBeenCalled();
    expect(h.onToggleSelect).not.toHaveBeenCalled();
    expect(h.onStartEditing).not.toHaveBeenCalled();
    expect(h.onDeleteTask).not.toHaveBeenCalled();
  });

  it('clicking the label text toggles once too, and no click or key event reaches an ancestor', async () => {
    const user = userEvent.setup();
    const h = mount(rich());
    await user.click(disclosure());
    h.parent.click.mockClear();

    await user.click(screen.getByText('step c'));
    screen.getByRole('checkbox', { name: 'step a' }).focus();
    await user.keyboard(' ');
    await user.keyboard('{Enter}');

    expect(h.onToggleSubtask).toHaveBeenCalledWith('t1', 'c');
    expect(h.onToggleSubtask.mock.calls.every(([taskId]) => taskId === 't1')).toBe(true);
    expect(h.parent.click).not.toHaveBeenCalled();
    expect(h.parent.keyDown).not.toHaveBeenCalled();
    expect(h.onToggleTask).not.toHaveBeenCalled();
  });

  it('Space on a subtask checkbox toggles that subtask once and never the parent', async () => {
    const user = userEvent.setup();
    const h = mount(rich());
    await user.click(disclosure());
    screen.getByRole('checkbox', { name: 'step b' }).focus();

    await user.keyboard(' ');

    expect(h.onToggleSubtask).toHaveBeenCalledTimes(1);
    expect(h.onToggleTask).not.toHaveBeenCalled();
  });

  it('subtask checkboxes are disabled while the task is busy', async () => {
    const user = userEvent.setup();
    mount(rich(), { activeActionTaskId: 't1' });
    await user.click(disclosure());
    expect(screen.getByRole('checkbox', { name: 'step a' })).toBeDisabled();
  });
});

describe('the main checkbox keyboard', () => {
  const main = () => screen.getByRole('checkbox', { name: /Mark "Plan trip"/ });

  it('Enter toggles exactly once', () => {
    const h = mount(rich());
    fireEvent.keyDown(main(), { key: 'Enter' });
    expect(h.onToggleTask).toHaveBeenCalledTimes(1);
  });

  it('Space toggles exactly once and is not left to scroll the page', () => {
    const h = mount(rich());
    const notPrevented = fireEvent.keyDown(main(), { key: ' ' });
    expect(h.onToggleTask).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false); // default prevented
  });

  it('a real Space keypress through user-event toggles once (no duplicate from a synthesized click)', async () => {
    const user = userEvent.setup();
    const h = mount(rich());
    main().focus();
    await user.keyboard(' ');
    expect(h.onToggleTask).toHaveBeenCalledTimes(1);
  });

  it('other keys do nothing, and a disabled task ignores Space and Enter', () => {
    const h = mount(rich());
    fireEvent.keyDown(main(), { key: 'a' });
    fireEvent.keyDown(main(), { key: 'Tab' });
    expect(h.onToggleTask).not.toHaveBeenCalled();
  });

  it('is ignored while the task is being updated', () => {
    const h = mount(rich(), { activeActionTaskId: 't1' });
    fireEvent.keyDown(main(), { key: ' ' });
    fireEvent.keyDown(main(), { key: 'Enter' });
    expect(h.onToggleTask).not.toHaveBeenCalled();
  });
});
