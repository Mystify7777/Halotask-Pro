import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import CompletedSection from '../dashboard/CompletedSection';
import DashboardToolbar from '../dashboard/DashboardToolbar';
import TaskFilters from '../dashboard/TaskFilters';
import { makeTask } from '../../test/taskFactory';
import DisclosureToggle from './DisclosureToggle';

// Issue #11: every show/hide control on the dashboard looks and is announced the same way.

function Stateful({ attention }: { attention?: string }) {
  const [open, setOpen] = useState(false);
  return <DisclosureToggle label="Filters" expanded={open} onToggle={() => setOpen((v) => !v)} controls="panel" attention={attention} />;
}

describe('<DisclosureToggle />', () => {
  it('has an accessible name that does not change with the state, and says its state through aria-expanded', async () => {
    const user = userEvent.setup();
    render(<Stateful />);
    const button = screen.getByRole('button', { name: 'Filters' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('draws its chevron in CSS and hides it from assistive technology (no glyph in the accessible name)', () => {
    render(<Stateful />);
    const button = screen.getByRole('button');
    expect(button.querySelector('.disclosure-chevron')).toHaveAttribute('aria-hidden', 'true');
    expect(button.textContent).not.toMatch(/[▲▼▾▸]/);
  });

  it('works from the keyboard: Enter and Space both toggle it', async () => {
    const user = userEvent.setup();
    render(<Stateful />);
    const button = screen.getByRole('button');
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard(' ');
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('announces something needing attention in text, not only with a dot', () => {
    render(<Stateful attention="Filters are active" />);
    expect(screen.getByRole('button', { name: /Filters are active/ })).toBeInTheDocument();
    expect(document.querySelector('.disclosure-attention')).toHaveAttribute('aria-hidden', 'true');
  });

  it('only points aria-controls at a region when the caller says one exists', () => {
    const { rerender } = render(<DisclosureToggle label="Summary" expanded={false} onToggle={vi.fn()} />);
    expect(screen.getByRole('button')).not.toHaveAttribute('aria-controls');
    rerender(<DisclosureToggle label="Summary" expanded onToggle={vi.fn()} controls="summary-panel" />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-controls', 'summary-panel');
  });
});

describe('the dashboard controls that use it', () => {
  const baseFilters = {
    search: '', filterMode: 'all' as const, priorityFilter: 'all' as const, sortBy: 'dueSoonest' as const, tagFilter: null,
    onSearchChange: vi.fn(), onFilterModeChange: vi.fn(), onPriorityFilterChange: vi.fn(), onSortByChange: vi.fn(), onClearTagFilter: vi.fn(),
  };

  it('Filters and Summary share one control, and the filter selections survive collapsing and reopening', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [filtersOpen, setFiltersOpen] = useState(true);
      const [priority, setPriority] = useState<'all' | 'high'>('high');
      return (
        <TaskFilters
          {...baseFilters}
          priorityFilter={priority}
          onPriorityFilterChange={(value) => setPriority(value as 'all' | 'high')}
          filtersExpanded={filtersOpen}
          onFiltersExpandedChange={setFiltersOpen}
          summaryExpanded={false}
          onSummaryExpandedChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    const filters = screen.getByRole('button', { name: /Filters/ });
    expect(filters).toHaveClass('disclosure-toggle');
    expect(screen.getByRole('button', { name: /Summary/ })).toHaveClass('disclosure-toggle');
    expect(filters).toHaveAttribute('aria-expanded', 'true');

    await user.click(filters);
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'false');
    // an active (non-default) filter is still visible while collapsed, in text for screen readers too
    expect(screen.getByRole('button', { name: /Filters are active/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Filters/ }));
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByDisplayValue(/high/i)).toBeInTheDocument(); // the priority select still holds "high"
  });

  it('Completed: named with its count, state in aria-expanded, aria-controls only while the list exists', async () => {
    const user = userEvent.setup();
    const tasks = [makeTask({ _id: 'a', completed: true }), makeTask({ _id: 'b', completed: true })];
    render(<CompletedSection tasks={tasks} onToggleTask={vi.fn()} onDeleteTask={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'Completed, 2 tasks' });
    expect(toggle).toHaveClass('disclosure-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).not.toHaveAttribute('aria-controls');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'completed-section-list');
    expect(document.getElementById('completed-section-list')).not.toBeNull();
  });
});

describe('collapsed panels are not tab stops', () => {
  it('the collapsed advanced-filter panel is inert (not focusable, not announced) and becomes live when opened', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <TaskFilters
          search="" filterMode="all" priorityFilter="all" sortBy="dueSoonest" tagFilter={null}
          onSearchChange={vi.fn()} onFilterModeChange={vi.fn()} onPriorityFilterChange={vi.fn()} onSortByChange={vi.fn()} onClearTagFilter={vi.fn()}
          filtersExpanded={open} onFiltersExpandedChange={setOpen}
        />
      );
    }
    render(<Harness />);
    const panel = document.getElementById('filter-advanced-panel')!;
    expect(panel).toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    expect(panel).not.toHaveAttribute('inert');
    await user.click(screen.getByRole('button', { name: /Filters/ }));
    expect(panel).toHaveAttribute('inert');
  });

  it('the collapsed sync row of the toolbar is inert too', () => {
    const { container, rerender } = render(
      <DashboardToolbar isFiltersExpanded={false} filters={null} syncArea={<button>Retry sync</button>} inlineActions={null} bulkActions={null} statusMessages={null} />,
    );
    expect(container.querySelector('.toolbar-meta-wrap')).toHaveAttribute('inert');
    rerender(<DashboardToolbar isFiltersExpanded filters={null} syncArea={<button>Retry sync</button>} inlineActions={null} bulkActions={null} statusMessages={null} />);
    expect(container.querySelector('.toolbar-meta-wrap')).not.toHaveAttribute('inert');
  });
});
