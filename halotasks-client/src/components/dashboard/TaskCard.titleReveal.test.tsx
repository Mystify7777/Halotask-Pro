import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeTask } from '../../test/taskFactory';
import TaskCard from './TaskCard';

// Task grid: long titles are cut with an ellipsis (CSS) and shown in full when the card is clicked.
// jsdom proves the state, roles and click isolation; the ellipsis and the card widths are checked in a real browser.

const mount = () => {
  const handlers = {
    onToggleTask: vi.fn(),
    onToggleSubtask: vi.fn(),
    onDeleteTask: vi.fn(),
    onStartEditing: vi.fn(),
    onToggleTagFilter: vi.fn(),
    onToggleSelect: vi.fn(),
  };
  const task = makeTask({ _id: 't1', title: 'Plan trip', tags: ['work'], description: 'notes', subtasks: [{ id: 'a', title: 'step a', completed: false }] });
  const view = render(<TaskCard task={task} activeActionTaskId={null} tagFilter={null} isSelected={false} bulkActionLoading={false} {...handlers} />);
  return { ...handlers, view };
};

const titleButton = () => screen.getByText('Plan trip').closest('button') as HTMLButtonElement;

describe('click to reveal the full title', () => {
  it('the title is a button, collapsed by default, with aria-expanded', () => {
    mount();
    expect(titleButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the title toggles it open and closed, and changes the style class', async () => {
    mount();
    const user = userEvent.setup();
    const strong = screen.getByText('Plan trip');
    const closedClass = strong.className;
    await user.click(titleButton());
    expect(titleButton()).toHaveAttribute('aria-expanded', 'true');
    expect(strong.className).not.toBe(closedClass);
    await user.click(titleButton());
    expect(titleButton()).toHaveAttribute('aria-expanded', 'false');
    expect(strong.className).toBe(closedClass);
  });

  it('works from the keyboard (Enter and Space on the title button)', async () => {
    mount();
    const user = userEvent.setup();
    titleButton().focus();
    await user.keyboard('{Enter}');
    expect(titleButton()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(titleButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking blank card area (not a control) also toggles it', async () => {
    const { view } = mount();
    const user = userEvent.setup();
    await user.click(view.container.firstElementChild as HTMLElement);
    expect(titleButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('the details region is still labelled by the title', () => {
    mount();
    const toggle = screen.getByRole('button', { name: /Details for "Plan trip"/ });
    return userEvent.setup().click(toggle).then(() => {
      expect(screen.getByRole('region', { name: 'Plan trip' })).toBeInTheDocument();
    });
  });
});

describe('other controls do not toggle the title and keep their own handlers', () => {
  it('Edit, Delete, select, main checkbox, tag chip', async () => {
    const h = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit task: Plan trip' }));
    expect(h.onStartEditing).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Delete task: Plan trip' }));
    expect(h.onDeleteTask).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('checkbox', { name: 'Select task: Plan trip' }));
    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('checkbox', { name: /Mark "Plan trip" as complete/ }));
    expect(h.onToggleTask).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: /Details for "Plan trip"/ }));
    await user.click(screen.getByRole('button', { name: 'Filter by tag: work' }));
    expect(h.onToggleTagFilter).toHaveBeenCalledTimes(1);
    expect(titleButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('a subtask checkbox and the region body do not toggle it', async () => {
    const h = mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Details for "Plan trip"/ }));
    await user.click(screen.getByRole('checkbox', { name: /step a/ }));
    expect(h.onToggleSubtask).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('region', { name: 'Plan trip' }));
    expect(titleButton()).toHaveAttribute('aria-expanded', 'false');
  });
});
