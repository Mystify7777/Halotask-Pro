import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../../test/taskFactory';
import TaskCard from './TaskCard';

// Selecting a task without a visible checkbox: right-click or long-press on the card; the checkbox shows once something is
// selected. jsdom proves handlers, state and DOM; real touch devices and real layout are separate checks.

const mount = (props: Partial<React.ComponentProps<typeof TaskCard>> = {}) => {
  const handlers = {
    onToggleTask: vi.fn(),
    onToggleSubtask: vi.fn(),
    onDeleteTask: vi.fn(),
    onStartEditing: vi.fn(),
    onToggleTagFilter: vi.fn(),
    onToggleSelect: vi.fn(),
  };
  const task = makeTask({ _id: 't1', title: 'Plan trip', tags: ['work'] });
  const view = render(<TaskCard task={task} activeActionTaskId={null} tagFilter={null} isSelected={false} bulkActionLoading={false} {...handlers} {...props} />);
  return { ...handlers, card: view.container.firstElementChild as HTMLElement };
};

afterEach(() => vi.useRealTimers());

const slot = () => screen.getByRole('checkbox', { name: 'Select task: Plan trip' }).parentElement as HTMLElement;

describe('right-click selects', () => {
  it('a right-click on the card selects it once and suppresses the browser menu', () => {
    const h = mount();
    const notPrevented = fireEvent.contextMenu(h.card);
    expect(notPrevented).toBe(false); // preventDefault was called
    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
    expect(h.onToggleSelect).toHaveBeenCalledWith('t1');
  });

  it('a right-click on the title or the meta area also selects', () => {
    const h = mount();
    fireEvent.contextMenu(screen.getByText('Plan trip'));
    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
  });

  it('does not hijack the browser menu on an input', () => {
    const h = mount();
    const notPrevented = fireEvent.contextMenu(screen.getByRole('checkbox', { name: 'Select task: Plan trip' }));
    expect(notPrevented).toBe(true);
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it('is ignored while the card is busy', () => {
    const h = mount({ bulkActionLoading: true });
    fireEvent.contextMenu(h.card);
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it('a normal left click does not select', async () => {
    const h = mount();
    await userEvent.setup().click(h.card);
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });
});

describe('long-press selects on touch', () => {
  const press = (el: Element, x = 10, y = 10) => fireEvent.pointerDown(el, { pointerType: 'touch', clientX: x, clientY: y });

  it('selects after 500ms and swallows the click that ends the press', () => {
    vi.useFakeTimers();
    const h = mount();
    press(h.card);
    act(() => { vi.advanceTimersByTime(499); });
    expect(h.onToggleSelect).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2); });
    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(h.card);
    fireEvent.click(screen.getByRole('button', { name: 'Edit task: Plan trip' }));
    expect(h.onStartEditing).not.toHaveBeenCalled(); // that click was swallowed
    fireEvent.click(screen.getByRole('button', { name: 'Edit task: Plan trip' }));
    expect(h.onStartEditing).toHaveBeenCalledTimes(1); // the next one is normal
  });

  it('a short tap, a scroll (movement) and a cancelled press do not select', () => {
    vi.useFakeTimers();
    const h = mount();
    press(h.card);
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.pointerUp(h.card);
    act(() => { vi.advanceTimersByTime(600); });
    press(h.card);
    fireEvent.pointerMove(h.card, { clientX: 10, clientY: 40 });
    act(() => { vi.advanceTimersByTime(600); });
    press(h.card);
    fireEvent.pointerCancel(h.card);
    act(() => { vi.advanceTimersByTime(600); });
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it('a mouse press never starts the long-press', () => {
    vi.useFakeTimers();
    const h = mount();
    fireEvent.pointerDown(h.card, { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(900); });
    expect(h.onToggleSelect).not.toHaveBeenCalled();
  });

  it('a long-press followed by the contextmenu Android fires selects only once', () => {
    vi.useFakeTimers();
    const h = mount();
    press(h.card);
    act(() => { vi.advanceTimersByTime(501); });
    fireEvent.contextMenu(h.card);
    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
  });
});

describe('the select checkbox is only shown once something is selected', () => {
  it('is hidden (zero-width slot) by default but still in the DOM and tab order', () => {
    mount();
    expect(slot().className).not.toMatch(/selectSlotShown/);
    expect(screen.getByRole('checkbox', { name: 'Select task: Plan trip' })).not.toHaveAttribute('tabindex', '-1');
  });

  it('is shown on a card that is not itself selected while selection mode is on', () => {
    mount({ selectionMode: true, isSelected: false });
    expect(slot().className).toMatch(/selectSlotShown/);
  });

  it('is shown on a selected card even if selection mode were off', () => {
    mount({ isSelected: true });
    expect(slot().className).toMatch(/selectSlotShown/);
    expect(screen.getByRole('checkbox', { name: 'Select task: Plan trip' })).toBeChecked();
  });

  it('the checkbox still selects when it is clicked', async () => {
    const h = mount({ selectionMode: true });
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Select task: Plan trip' }));
    expect(h.onToggleSelect).toHaveBeenCalledTimes(1);
  });
});

describe('edit and delete are icon buttons with names', () => {
  it('have accessible names, tooltips and an svg, no visible text', () => {
    mount();
    for (const [name, title] of [['Edit task: Plan trip', 'Edit'], ['Delete task: Plan trip', 'Delete']] as const) {
      const b = screen.getByRole('button', { name });
      expect(b).toHaveAttribute('title', title);
      expect(b.querySelector('svg')).not.toBeNull();
      expect(b.textContent).toBe('');
    }
  });

  it('a delete in flight shows busy and is disabled', () => {
    mount({ activeActionTaskId: 't1' });
    const b = screen.getByRole('button', { name: 'Delete task: Plan trip' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('aria-busy', 'true');
  });
});
