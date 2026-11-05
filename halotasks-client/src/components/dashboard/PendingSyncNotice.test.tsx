import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import PendingSyncNotice from './PendingSyncNotice';

// Pending work must be visible without opening the Filters panel.

const mount = (props: Partial<React.ComponentProps<typeof PendingSyncNotice>> = {}) => {
  const onRetry = vi.fn();
  render(<PendingSyncNotice pendingCount={2} isOnline syncing={false} onRetry={onRetry} {...props} />);
  return { onRetry };
};

describe('PendingSyncNotice', () => {
  it('shows nothing when nothing is queued', () => {
    mount({ pendingCount: 0 });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says how many changes are waiting and offers a retry when online', async () => {
    const { onRetry } = mount();
    expect(screen.getByRole('status')).toHaveTextContent('2 changes waiting to sync');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync now' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('uses the singular for one change', () => {
    mount({ pendingCount: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('1 change waiting to sync');
  });

  it('offline: explains why and offers no retry that cannot work', () => {
    mount({ isOnline: false });
    expect(screen.getByRole('status')).toHaveTextContent('(you are offline)');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('while syncing the button is disabled and says so', () => {
    mount({ syncing: true });
    expect(screen.getByRole('button', { name: 'Syncing...' })).toBeDisabled();
  });
});
