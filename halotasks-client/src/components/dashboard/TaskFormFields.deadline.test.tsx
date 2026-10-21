import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import TaskEditForm from './TaskEditForm';
import TaskFormFields from './TaskFormFields';
import type { TaskEditState } from './types';

// The two optional inputs of Issues #9 and #10 in the shared form (used by both create and edit).

const noop = () => undefined;
const fields = (overrides: Partial<React.ComponentProps<typeof TaskFormFields>> = {}) => (
  <TaskFormFields
    title="t"
    priority="medium"
    dueDate=""
    dueTime=""
    startTime=""
    estimatedMinutes=""
    tags={[]}
    tagInput=""
    tagSuggestions={[]}
    onTitleChange={noop}
    onPriorityChange={noop}
    onDueDateChange={noop}
    onDueTimeChange={noop}
    onStartTimeChange={noop}
    onEstimatedMinutesChange={noop}
    onTagInputChange={noop}
    onAddTag={() => ({ message: null })}
    onRemoveTag={noop}
    {...overrides}
  />
);

describe('TaskFormFields', () => {
  it('offers an optional due time and an optional start, next to the existing due date', () => {
    render(fields());

    expect(screen.getByLabelText('Due date')).toHaveAttribute('type', 'date');
    expect(screen.getByLabelText('Due time')).toHaveAttribute('type', 'time');
    expect(screen.getByLabelText('Start time')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Due time')).not.toBeRequired();
    expect(screen.getByLabelText('Start time')).not.toBeRequired();
  });

  it('disables the due time until there is a due date (a time needs a day), and never disables the start', () => {
    const { rerender } = render(fields({ dueDate: '' }));
    expect(screen.getByLabelText('Due time')).toBeDisabled();
    expect(screen.getByLabelText('Start time')).toBeEnabled();

    rerender(fields({ dueDate: '2026-10-20' }));
    expect(screen.getByLabelText('Due time')).toBeEnabled();
  });

  it('shows the values it is given', () => {
    render(fields({ dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30' }));

    expect(screen.getByLabelText('Due time')).toHaveValue('17:30');
    expect(screen.getByLabelText('Start time')).toHaveValue('2026-10-20T09:30');
  });

  it('reports changes, and a cleared input is reported as an empty string', async () => {
    const onDueTimeChange = vi.fn();
    const onStartTimeChange = vi.fn();
    const user = userEvent.setup();
    render(fields({ dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30', onDueTimeChange, onStartTimeChange }));

    await user.clear(screen.getByLabelText('Due time'));
    await user.clear(screen.getByLabelText('Start time'));

    expect(onDueTimeChange).toHaveBeenLastCalledWith('');
    expect(onStartTimeChange).toHaveBeenLastCalledWith('');
  });
});

describe('TaskEditForm', () => {
  const Harness = ({ initial }: { initial: TaskEditState }) => {
    const [state, setState] = useState<TaskEditState | null>(initial);
    return (
      <>
        {state && (
          <TaskEditForm
            taskId="t1"
            editState={state}
            activeActionTaskId={null}
            editTagSuggestions={[]}
            onEditStateChange={setState}
            onSaveTaskEdit={noop}
            onCancelEditing={noop}
            onAddEditTag={() => ({ message: null })}
            onRemoveEditTag={noop}
          />
        )}
        <output data-testid="state">{JSON.stringify(state)}</output>
      </>
    );
  };
  const read = () => JSON.parse(screen.getByTestId('state').textContent ?? 'null') as TaskEditState;
  const initial: TaskEditState = {
    title: 't',
    priority: 'medium',
    tags: [],
    tagInput: '',
    dueDate: '2026-10-20',
    dueTime: '17:30',
    startTime: '2026-10-20T09:30',
    estimatedMinutes: '',
  };

  it('editing a time changes only that time', async () => {
    const user = userEvent.setup();
    render(<Harness initial={initial} />);

    await user.clear(screen.getByLabelText('Due time'));
    await user.type(screen.getByLabelText('Due time'), '08:05');

    expect(read()).toMatchObject({ dueDate: '2026-10-20', dueTime: '08:05', startTime: '2026-10-20T09:30' });
  });

  it('clearing the due date clears the due time with it, and leaves the start alone', async () => {
    const user = userEvent.setup();
    render(<Harness initial={initial} />);

    await user.clear(screen.getByLabelText('Due date'));

    expect(read()).toMatchObject({ dueDate: '', dueTime: '', startTime: '2026-10-20T09:30' });
    expect(screen.getByLabelText('Due time')).toBeDisabled();
  });
});
