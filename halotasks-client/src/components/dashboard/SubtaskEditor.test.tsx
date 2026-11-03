import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Subtask } from '../../types/task';
import { MAX_SUBTASKS } from '../../utils/subtasks';
import SubtaskEditor from './SubtaskEditor';
import TaskCreateForm from './TaskCreateForm';
import TaskEditForm from './TaskEditForm';
import TaskFormFields from './TaskFormFields';
import type { TaskEditState } from './types';

// Issue #15 (phase 3): the editor inside the shared create/edit form. jsdom proves DOM behaviour and focus order, not a
// real browser; tests/… for real keyboard and layout are the Chromium checks.

// Importing the create form pulls in modules that open IndexedDB at load; jsdom has none, and nothing here uses it.
vi.mock('../../offline/db', () => ({ offlineDb: { get: async () => null, set: async () => undefined, remove: async () => undefined } }));

const sub = (id: string, extra: Partial<Subtask> = {}): Subtask => ({ id, title: `step ${id}`, completed: false, ...extra });

const Harness = ({ initial = [] as Subtask[], onChange = vi.fn(), error }: { initial?: Subtask[]; onChange?: (s: Subtask[]) => void; error?: string | null }) => {
  const [list, setList] = useState(initial);
  return (
    <>
      <SubtaskEditor subtasks={list} onChange={(next) => { setList(next); onChange(next); }} error={error} />
      <output data-testid="state">{JSON.stringify(list)}</output>
    </>
  );
};
const state = () => JSON.parse(screen.getByTestId('state').textContent ?? '[]') as Subtask[];

describe('SubtaskEditor', () => {
  it('adds a row with a NEW id, focuses it, and leaves existing ids and states alone', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[sub('a', { completed: true })]} />);

    await user.click(screen.getByRole('button', { name: '+ Add subtask' }));

    const after = state();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(sub('a', { completed: true }));
    expect(after[1]).toMatchObject({ title: '', completed: false });
    expect(after[1].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(after[1].id).not.toBe('a');
    expect(screen.getByLabelText('Subtask 2 title')).toHaveFocus();
  });

  it('renaming changes only that title; the id and the state stay exactly as they were', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[sub('a', { completed: true }), sub('b')]} />);

    await user.type(screen.getByLabelText('Subtask 1 title'), '!');

    expect(state()).toEqual([sub('a', { title: 'step a!', completed: true }), sub('b')]);
  });

  it('removing keeps the other ids and moves focus to the neighbour, or to Add when none is left', async () => {
    const user = userEvent.setup();
    render(<Harness initial={[sub('a'), sub('b'), sub('c')]} />);

    await user.click(screen.getByRole('button', { name: /Remove subtask 2: step b/ }));
    expect(state().map((s) => s.id)).toEqual(['a', 'c']);
    expect(screen.getByLabelText('Subtask 2 title')).toHaveFocus(); // the row that took its place

    await user.click(screen.getByRole('button', { name: /Remove subtask 2/ }));
    expect(screen.getByLabelText('Subtask 1 title')).toHaveFocus(); // the one before it

    await user.click(screen.getByRole('button', { name: /Remove subtask 1/ }));
    expect(state()).toEqual([]);
    expect(screen.getByRole('button', { name: '+ Add subtask' })).toHaveFocus();
  });

  it(`disables Add at ${MAX_SUBTASKS} and shows the count`, () => {
    const full = Array.from({ length: MAX_SUBTASKS }, (_, i) => sub(`s${i}`));
    render(<Harness initial={full} />);
    expect(screen.getByRole('button', { name: /Limit of 20 reached/ })).toBeDisabled();
    expect(screen.getByText('20/20')).toBeInTheDocument();
  });

  it('caps a title at the server limit in the input', () => {
    render(<Harness initial={[sub('a')]} />);
    expect(screen.getByLabelText('Subtask 1 title')).toHaveAttribute('maxlength', '200');
  });

  it('Enter in a row never submits the surrounding form, and adds a row after the last non-blank one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness initial={[sub('a'), sub('b')]} />
      </form>,
    );

    await user.click(screen.getByLabelText('Subtask 1 title'));
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Subtask 2 title')).toHaveFocus(); // moved on, did not add

    await user.keyboard('{Enter}');
    expect(state()).toHaveLength(3); // after the last: a new row
    expect(screen.getByLabelText('Subtask 3 title')).toHaveFocus();

    await user.keyboard('{Enter}'); // the new row is blank: no endless blank rows
    expect(state()).toHaveLength(3);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('shows a refusal as an alert without touching the list', () => {
    render(<Harness initial={[sub('a')]} error="Subtask ids must be unique." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Subtask ids must be unique.');
    expect(state()).toEqual([sub('a')]);
  });
});

describe('the form around the editor', () => {
  const noop = () => undefined;
  const fields = (extra: Partial<React.ComponentProps<typeof TaskFormFields>> = {}) => (
    <TaskFormFields
      title="t" priority="medium" dueDate="" dueTime="" startTime="" estimatedMinutes="" tags={[]} tagInput="" tagSuggestions={[]}
      onTitleChange={noop} onPriorityChange={noop} onDueDateChange={noop} onDueTimeChange={noop} onStartTimeChange={noop}
      onEstimatedMinutesChange={noop} onTagInputChange={noop} onAddTag={() => ({ message: null })} onRemoveTag={noop}
      {...extra}
    />
  );

  it('without the optional handlers there is no description field and no editor (the form is unchanged)', () => {
    render(fields());
    expect(screen.queryByLabelText('Description')).toBeNull();
    expect(screen.queryByText(/Subtasks/)).toBeNull();
  });

  it('with them: a description field limited to the server length, optional, and the editor', () => {
    render(fields({ description: 'hi', onDescriptionChange: noop, subtasks: [], onSubtasksChange: noop }));
    const description = screen.getByLabelText('Description');
    expect(description).toHaveValue('hi');
    expect(description).toHaveAttribute('maxlength', '2000');
    expect(description).not.toBeRequired();
    expect(screen.getByRole('group', { name: /Subtasks/ })).toBeInTheDocument();
  });

  it('the edit form renders both only when the edit session carries them, and writes edits back to the state', async () => {
    const user = userEvent.setup();
    const baseState: TaskEditState = { title: 't', priority: 'low', tags: [], tagInput: '', dueDate: '', dueTime: '', startTime: '', estimatedMinutes: '' };
    const Host = ({ initial }: { initial: TaskEditState }) => {
      const [s, setS] = useState<TaskEditState | null>(initial);
      return (
        <>
          {s && <TaskEditForm taskId="t1" editState={s} activeActionTaskId={null} editTagSuggestions={[]} onEditStateChange={setS} onSaveTaskEdit={noop} onCancelEditing={noop} onAddEditTag={() => ({ message: null })} onRemoveEditTag={noop} />}
          <output data-testid="s">{JSON.stringify(s)}</output>
        </>
      );
    };
    const { unmount } = render(<Host initial={baseState} />);
    expect(screen.queryByLabelText('Description')).toBeNull();
    unmount();

    render(<Host initial={{ ...baseState, description: '', subtasks: [sub('a')], saveError: 'old problem' }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('old problem');
    await user.type(screen.getByLabelText('Description'), 'x');
    await user.type(screen.getByLabelText('Subtask 1 title'), '!');
    const s = JSON.parse(screen.getByTestId('s').textContent!);
    expect(s.description).toBe('x');
    expect(s.subtasks).toEqual([sub('a', { title: 'step a!' })]);
    expect(s.saveError).toBeNull(); // editing the list clears the old message
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the create form submits only from its own button, never from Enter inside a subtask row', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <TaskCreateForm
        title="t" priority="medium" dueDate="" dueTime="" startTime="" estimatedMinutes="" creatingTask={false} tags={[]} tagInput="" tagSuggestions={[]}
        onSubmit={onSubmit} onTitleChange={noop} onPriorityChange={noop} onDueDateChange={noop} onDueTimeChange={noop} onStartTimeChange={noop}
        onEstimatedMinutesChange={noop} onTagInputChange={noop} onAddTag={() => ({ message: null })} onRemoveTag={noop}
        description="" onDescriptionChange={noop} subtasks={[sub('a')]} onSubtasksChange={noop}
      />,
    );
    await user.click(screen.getByLabelText('Subtask 1 title'));
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(within(document.body).getByRole('button', { name: 'Add Task' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
