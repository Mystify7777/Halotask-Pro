import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';
import { MAX_UNHEALTHY, RETRY_DELAY_MS, SLOW_PROBE_MS, WAKE_BUDGET_MS } from '../hooks/useBackendReadiness';
import BackendWarmup from './BackendWarmup';

// Issue #12: the pre-login warm-up experience. The probe is replaced; the hook, the overlay and the notice are real.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));

const answers = (...results: HealthProbeResult[]) => {
  let call = 0;
  probe.mockImplementation(async () => results[Math.min(call++, results.length - 1)]);
};
const pending = () => probe.mockImplementation(() => new Promise<HealthProbeResult>(() => undefined));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
// The overlay chains its close (ready beat, then exit animation) through effects, so each step needs its own render:
// advancing the whole span inside one act would batch them. This mirrors how ColdStartOverlay.test.tsx steps through it.
const finishClose = async () => {
  await advance(900);
  await advance(500);
};
const overlay = () => screen.queryByRole('dialog', { name: 'Server loading' });
const failure = () => screen.queryByTestId('backend-warmup-failure');

beforeEach(() => {
  vi.useFakeTimers();
  probe.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('<BackendWarmup /> with no session (nothing is rendered from, or read from, an account)', () => {
  it('a backend that answers at once renders nothing at all', async () => {
    answers('ok');
    const { container } = render(<BackendWarmup />);
    await advance(WAKE_BUDGET_MS);
    expect(container).toBeEmptyDOMElement();
  });

  it('a slow backend gets the existing Task Tapper overlay, and it closes with the "ready" beat once a probe says ok', async () => {
    answers('no-answer', 'ok');
    render(<BackendWarmup />);
    expect(overlay()).toBeNull();
    await advance(0); // the first probe came back empty: the backend is waking
    expect(overlay()).toBeInTheDocument();
    expect(screen.getByText(/Waking up the server/)).toBeInTheDocument();

    await advance(RETRY_DELAY_MS); // the next probe is ok
    expect(screen.getByText(/Server is ready!/)).toBeInTheDocument();
    await finishClose();
    expect(overlay()).toBeNull();
    expect(failure()).toBeNull();
  });

  it('a first probe that is merely slow (still unanswered) also brings the overlay up, after SLOW_PROBE_MS and not before', async () => {
    pending();
    render(<BackendWarmup />);
    await advance(SLOW_PROBE_MS - 1);
    expect(overlay()).toBeNull();
    await advance(1);
    expect(overlay()).toBeInTheDocument();
  });

  it('keeps the overlay up for as long as the backend is only waking (no timer ends it)', async () => {
    answers('no-answer');
    render(<BackendWarmup />);
    await advance(WAKE_BUDGET_MS - RETRY_DELAY_MS * 3);
    expect(overlay()).toBeInTheDocument();
    expect(screen.getByText(/Waking up the server/)).toBeInTheDocument();
    expect(failure()).toBeNull();
  });

  it('the overlay closes by itself when the backend comes up after a wait of several probes', async () => {
    answers('no-answer', 'no-answer', 'ok');
    render(<BackendWarmup />);
    await advance(0);
    await advance(RETRY_DELAY_MS * 2);
    expect(screen.getByText(/Server is ready!/)).toBeInTheDocument();
    await finishClose();
    expect(overlay()).toBeNull();
  });

  it('the user can dismiss the overlay early, and nothing reappears when the backend later comes up', async () => {
    answers('no-answer', 'no-answer', 'ok');
    render(<BackendWarmup />);
    await advance(0);
    await advance(400);
    fireEvent.click(screen.getByRole('button', { name: /close server loading screen/i }));
    await advance(0); // exiting
    await advance(500); // the exit animation ends
    expect(overlay()).toBeNull();

    await advance(RETRY_DELAY_MS * 3);
    expect(overlay()).toBeNull();
    expect(failure()).toBeNull();
  });
});

describe('<BackendWarmup /> when the backend has failed (not just a cold start)', () => {
  it('no healthy answer within the wake budget: the overlay closes WITHOUT claiming ready, and a timeout notice appears', async () => {
    answers('no-answer');
    render(<BackendWarmup />);
    await advance(WAKE_BUDGET_MS + RETRY_DELAY_MS + 2_000);

    expect(screen.queryByText(/Server is ready!/)).toBeNull();
    expect(overlay()).toBeNull();
    expect(failure()).toHaveAttribute('data-reason', 'timeout');
    expect(failure()).toHaveTextContent(/couldn't reach the server/i);
    expect(failure()).not.toHaveTextContent(/waking/i);
  });

  it('a backend that answers "unavailable" gets its own wording: up, but without its database', async () => {
    answers('unhealthy');
    render(<BackendWarmup />);
    await advance(RETRY_DELAY_MS * MAX_UNHEALTHY + 2_000);

    expect(screen.queryByText(/Server is ready!/)).toBeNull();
    expect(failure()).toHaveAttribute('data-reason', 'unhealthy');
    expect(failure()).toHaveTextContent(/can't reach its database/i);
  });

  it.each([
    ['no-answer', 'timeout'],
    ['unhealthy', 'unhealthy'],
  ] as const)('dismissing the overlay early does not hide a real outage: a later %s still produces the "%s" failure notice', async (probeResult, reason) => {
    answers(probeResult);
    render(<BackendWarmup />);
    await advance(0);
    await advance(400);
    expect(overlay()).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close server loading screen/i }));
    await advance(0);
    await advance(500);
    expect(overlay()).toBeNull();
    expect(failure()).toBeNull(); // dismissed while still waiting: nothing has failed yet

    await advance(WAKE_BUDGET_MS + RETRY_DELAY_MS + 2_000);
    expect(overlay()).toBeNull(); // the game does not come back
    expect(failure()).toHaveAttribute('data-reason', reason);
    expect(screen.queryByText(/Server is ready!/)).toBeNull();
  });

  it('"Check again" runs a fresh wait and clears the notice once the backend is ok', async () => {
    answers('unhealthy');
    render(<BackendWarmup />);
    await advance(RETRY_DELAY_MS * MAX_UNHEALTHY + 2_000);
    expect(failure()).toBeInTheDocument();

    answers('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await advance(0);

    expect(failure()).toBeNull();
    expect(overlay()).toBeNull();
  });

  it('the failure notice is an alert, so a screen reader hears it', async () => {
    answers('unhealthy');
    render(<BackendWarmup />);
    await advance(RETRY_DELAY_MS * MAX_UNHEALTHY + 2_000);
    expect(screen.getByRole('alert')).toBe(failure());
  });
});
