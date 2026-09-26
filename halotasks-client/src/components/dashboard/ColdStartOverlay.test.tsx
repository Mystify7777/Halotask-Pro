import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ColdStartOverlay from './ColdStartOverlay';
import type { ColdStartOutcome } from './ColdStartOverlay';

function renderOverlay(outcome: ColdStartOutcome, onExited = vi.fn(), onDismiss = vi.fn()) {
  const utils = render(<ColdStartOverlay outcome={outcome} onExited={onExited} onDismiss={onDismiss} />);
  return { ...utils, onExited, onDismiss };
}

async function enterActivePhase() {
  // The overlay spends its first 400ms in an "entering" phase before the
  // close button / completion logic engages.
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

describe('ColdStartOverlay', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays open indefinitely while the outcome is "waking" (no fixed timeout)', async () => {
    const { onExited } = renderOverlay('waking');
    await enterActivePhase();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onExited).not.toHaveBeenCalled();
    expect(screen.getByText(/Waking up the server/)).toBeInTheDocument();
  });

  it('automatically closes and shows the ready badge when the outcome becomes "ready"', async () => {
    const { rerender, onExited } = renderOverlay('waking');
    await enterActivePhase();

    rerender(<ColdStartOverlay outcome="ready" onExited={onExited} onDismiss={vi.fn()} />);

    expect(screen.getByText(/Server is ready!/)).toBeInTheDocument();
    expect(onExited).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(onExited).toHaveBeenCalledTimes(1);
  });

  it('closes quietly on "error" and never claims the server is ready', async () => {
    const { rerender, onExited } = renderOverlay('waking');
    await enterActivePhase();

    rerender(<ColdStartOverlay outcome="error" onExited={onExited} onDismiss={vi.fn()} />);

    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(onExited).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Server is ready!/)).not.toBeInTheDocument();
  });

  it('lets the user manually dismiss while still waking, without touching backend state', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { onDismiss, onExited } = renderOverlay('waking');

    const closeButton = screen.getByRole('button', { name: /close server loading screen/i });
    await user.click(closeButton);

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(onExited).not.toHaveBeenCalled();
  });

  it('supports dismissing with the keyboard (Escape) for accessibility', async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { onDismiss } = renderOverlay('waking');

    const dialog = screen.getByRole('dialog', { name: /server loading/i });
    dialog.focus();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('hides the manual close control once a real outcome starts closing the overlay', async () => {
    const { rerender } = renderOverlay('waking');
    await enterActivePhase();

    expect(screen.getByRole('button', { name: /close server loading screen/i })).toBeInTheDocument();

    rerender(<ColdStartOverlay outcome="ready" onExited={vi.fn()} onDismiss={vi.fn()} />);

    expect(screen.getByText(/Server is ready!/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /close server loading screen/i })).not.toBeInTheDocument();
  });

  it('renders an accessible, labeled dialog', () => {
    renderOverlay('waking');
    const dialog = screen.getByRole('dialog', { name: /server loading/i });
    expect(within(dialog).getByRole('button', { name: /close server loading screen/i })).toBeInTheDocument();
  });
});
