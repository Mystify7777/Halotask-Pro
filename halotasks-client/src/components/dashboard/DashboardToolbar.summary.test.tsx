import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import DashboardToolbar from './DashboardToolbar';
import TaskFilters from './TaskFilters';

// The productivity snapshot lives in the search panel and is collapsed (not rendered) until the Summary toggle is used.

function Harness({ withToggle = true }: { withToggle?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <DashboardToolbar
      isFiltersExpanded={false}
      syncArea={null}
      inlineActions={null}
      bulkActions={null}
      statusMessages={null}
      summary={open ? <div data-testid="snapshot">snapshot</div> : null}
      filters={
        <TaskFilters
          search=""
          filterMode="active"
          priorityFilter="all"
          sortBy="dueSoonest"
          tagFilter={null}
          filtersExpanded={false}
          summaryExpanded={open}
          onSummaryExpandedChange={withToggle ? setOpen : undefined}
          onSearchChange={vi.fn()}
          onFilterModeChange={vi.fn()}
          onPriorityFilterChange={vi.fn()}
          onSortByChange={vi.fn()}
          onClearTagFilter={vi.fn()}
          onFiltersExpandedChange={vi.fn()}
        />
      }
    />
  );
}

describe('Summary toggle in the search panel', () => {
  it('is collapsed by default: aria-expanded=false and nothing rendered', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /Summary/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('snapshot')).toBeNull();
  });

  it('opens and closes the snapshot inside the toolbar panel, wired by aria-controls', async () => {
    const { container } = render(<Harness />);
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: /Summary/ });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const snap = screen.getByTestId('snapshot');
    expect(container.querySelector('.toolbar-panel')).toContainElement(snap);
    expect(snap.closest('#summary-panel')).not.toBeNull();
    expect(toggle.getAttribute('aria-controls')).toBe('summary-panel');
    await user.click(toggle);
    expect(screen.queryByTestId('snapshot')).toBeNull();
  });

  it('the Filters toggle is independent of it', async () => {
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Summary/ }));
    expect(screen.getByRole('button', { name: /Filters/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('no toggle is shown when the page does not wire one', () => {
    render(<Harness withToggle={false} />);
    expect(screen.queryByRole('button', { name: /Summary/ })).toBeNull();
  });
});
