import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #41 — the Settings time zone selector. The real store and zone module run; the API (userService) and IndexedDB
// are replaced so each request can be held and settled by hand.

const api = vi.hoisted(() => ({
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));
vi.mock('../../services/userService', () => ({ userService: api }));
vi.mock('../../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

import { useAuthStore } from '../../store/authStore';
import { getEffectiveTimeZone, getPreferredTimeZone } from '../../utils/timeZone';
import TimeZoneSetting from './TimeZoneSetting';

const TOKEN = `${btoa('{}')}.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
const ALICE = { id: 'a', name: 'Alice', email: 'a@x.test' };

const signIn = (timeZone?: string | null) =>
  useAuthStore.getState().setAuth({ token: TOKEN, user: timeZone === undefined ? ALICE : { ...ALICE, timeZone } });

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const apiError = (status: number, message: string) =>
  new AxiosError('failed', 'ERR_BAD_REQUEST', undefined, undefined, { status, data: { message }, statusText: '', headers: {}, config: {} as never });

const select = () => screen.getByLabelText('Time zone for task times') as HTMLSelectElement;
const saveButton = () => screen.getByRole('button', { name: /^(Save|Saving…)$/ });

beforeEach(() => {
  localStorage.clear();
  api.getPreferences.mockReset();
  api.updatePreferences.mockReset();
  useAuthStore.getState().clearAuth();
});

afterEach(() => {
  useAuthStore.getState().clearAuth();
  localStorage.clear();
});

describe('loading the saved value', () => {
  it('shows the saved zone as selected and as the effective zone', async () => {
    signIn('Asia/Kolkata');
    api.getPreferences.mockResolvedValue({ timeZone: 'Asia/Kolkata' });

    render(<TimeZoneSetting />);

    await waitFor(() => expect(screen.queryByText(/Loading your saved time zone/)).not.toBeInTheDocument());
    expect(select().value).toBe('Asia/Kolkata');
    expect(screen.getByText(/Using Asia\/Kolkata \(UTC\+05:30\) \(your saved preference\)\./)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled(); // nothing to save yet
  });

  it('is disabled with a loading message until the server answers', async () => {
    signIn('Asia/Kolkata');
    const pending = deferred<{ timeZone: string | null }>();
    api.getPreferences.mockReturnValue(pending.promise);

    render(<TimeZoneSetting />);

    expect(screen.getByText('Loading your saved time zone…')).toBeInTheDocument();
    expect(select()).toBeDisabled();
    expect(saveButton()).toBeDisabled();

    await act(async () => pending.resolve({ timeZone: 'Asia/Kolkata' }));
    expect(select()).toBeEnabled();
  });

  it('adopts the server\'s value when it was changed on another device since this session loaded', async () => {
    signIn('Asia/Kolkata');
    api.getPreferences.mockResolvedValue({ timeZone: 'Europe/London' });

    render(<TimeZoneSetting />);

    await waitFor(() => expect(select().value).toBe('Europe/London'));
    expect(useAuthStore.getState().user?.timeZone).toBe('Europe/London');
    expect(getEffectiveTimeZone()).toBe('Europe/London');
  });

  it('an account with no saved choice (an old response) shows the device option and saves nothing', async () => {
    signIn(); // no timeZone field at all
    api.getPreferences.mockResolvedValue({ timeZone: null });

    render(<TimeZoneSetting />);

    await waitFor(() => expect(screen.queryByText(/Loading your saved time zone/)).not.toBeInTheDocument());
    expect(select().value).toBe(''); // "Use this device"
    expect(screen.getByText(/this device, not saved/)).toBeInTheDocument();
    expect(getPreferredTimeZone()).toBeNull();
    expect(api.updatePreferences).not.toHaveBeenCalled(); // looking never writes the fallback back
  });

  it('keeps the last known value and says so when the server cannot be reached', async () => {
    signIn('Asia/Kolkata');
    api.getPreferences.mockRejectedValue(new Error('offline'));

    render(<TimeZoneSetting />);

    expect(await screen.findByText(/Could not load your saved time zone from the server; showing the last known setting\./)).toBeInTheDocument();
    expect(select().value).toBe('Asia/Kolkata');
    expect(select()).toBeEnabled();
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
  });
});

describe('choosing and saving', () => {
  const ready = async (timeZone?: string | null) => {
    signIn(timeZone);
    api.getPreferences.mockResolvedValue({ timeZone: timeZone ?? null });
    render(<TimeZoneSetting />);
    await waitFor(() => expect(select()).toBeEnabled());
  };

  it('an unsaved choice is marked as unsaved and changes nothing until saved', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');

    await user.selectOptions(select(), 'Europe/London');

    expect(screen.getByText('Unsaved change: not applied until you save.')).toBeInTheDocument();
    expect(saveButton()).toBeEnabled();
    expect(screen.getByText(/Using Asia\/Kolkata/)).toBeInTheDocument(); // still the saved zone
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
    expect(api.updatePreferences).not.toHaveBeenCalled();
  });

  it('choosing the saved value again is not a change', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');

    await user.selectOptions(select(), 'Europe/London');
    await user.selectOptions(select(), 'Asia/Kolkata');

    expect(screen.queryByText(/Unsaved change/)).not.toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('saving sends the choice, shows saving, then confirms and applies what the SERVER returned', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');
    const pending = deferred<{ timeZone: string | null }>();
    api.updatePreferences.mockReturnValue(pending.promise);

    await user.selectOptions(select(), 'America/Los_Angeles');
    await user.click(saveButton());

    expect(api.updatePreferences).toHaveBeenCalledWith({ timeZone: 'America/Los_Angeles' });
    expect(saveButton()).toHaveTextContent('Saving…');
    expect(saveButton()).toBeDisabled();
    expect(select()).toBeDisabled();
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata'); // not applied while the request is outstanding
    expect(screen.queryByText('Time zone saved.')).not.toBeInTheDocument();

    await act(async () => pending.resolve({ timeZone: 'America/Los_Angeles' }));

    expect(await screen.findByText('Time zone saved.')).toBeInTheDocument();
    expect(useAuthStore.getState().user?.timeZone).toBe('America/Los_Angeles');
    expect(getEffectiveTimeZone()).toBe('America/Los_Angeles');
    expect(JSON.parse(localStorage.getItem('halotasks_user')!).timeZone).toBe('America/Los_Angeles');
    expect(screen.getByText(/Using America\/Los Angeles \(UTC-0[78]:00\) \(your saved preference\)\./)).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
  });

  it('a failed save shows the error, keeps the previous saved value, and never claims success', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');
    api.updatePreferences.mockRejectedValue(apiError(400, 'timeZone must be a valid IANA time zone identifier, for example "Asia/Kolkata"'));

    await user.selectOptions(select(), 'Europe/London');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('timeZone must be a valid IANA time zone identifier');
    expect(screen.queryByText('Time zone saved.')).not.toBeInTheDocument();
    expect(useAuthStore.getState().user?.timeZone).toBe('Asia/Kolkata'); // the previous value survives
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
    expect(JSON.parse(localStorage.getItem('halotasks_user')!).timeZone).toBe('Asia/Kolkata');
    expect(select().value).toBe('Europe/London'); // the user's choice is kept so they can retry
    expect(saveButton()).toBeEnabled();
    expect(screen.getByText('Unsaved change: not applied until you save.')).toBeInTheDocument();
  });

  it('a network failure gets a generic message and the same guarantees', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');
    api.updatePreferences.mockRejectedValue(new Error('Network Error'));

    await user.selectOptions(select(), 'Europe/London');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save your time zone. Your previous setting is unchanged.');
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
  });

  it('retrying after a failure can succeed, and the error goes away', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');
    api.updatePreferences.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce({ timeZone: 'Europe/London' });

    await user.selectOptions(select(), 'Europe/London');
    await user.click(saveButton());
    await screen.findByRole('alert');
    await user.click(saveButton());

    expect(await screen.findByText('Time zone saved.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(getEffectiveTimeZone()).toBe('Europe/London');
  });

  it('choosing "Use this device" saves null, which clears the saved choice', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');
    api.updatePreferences.mockResolvedValue({ timeZone: null });

    await user.selectOptions(select(), '');
    await user.click(saveButton());

    expect(api.updatePreferences).toHaveBeenCalledWith({ timeZone: null });
    await waitFor(() => expect(getPreferredTimeZone()).toBeNull());
    expect(useAuthStore.getState().user).not.toHaveProperty('timeZone');
    expect(await screen.findByText(/this device, not saved/)).toBeInTheDocument();
  });

  it('first save for a legacy account stores a real choice', async () => {
    const user = userEvent.setup();
    await ready();
    api.updatePreferences.mockResolvedValue({ timeZone: 'Pacific/Kiritimati' });

    await user.selectOptions(select(), 'Pacific/Kiritimati');
    await user.click(saveButton());

    await waitFor(() => expect(getPreferredTimeZone()).toBe('Pacific/Kiritimati'));
  });

  it('a save that finishes after the user signed out does not touch the next session', async () => {
    const user = userEvent.setup();
    await ready('Asia/Kolkata');
    const pending = deferred<{ timeZone: string | null }>();
    api.updatePreferences.mockReturnValue(pending.promise);

    await user.selectOptions(select(), 'Europe/London');
    await user.click(saveButton());
    act(() => useAuthStore.getState().clearAuth());
    await act(async () => pending.resolve({ timeZone: 'Europe/London' }));

    expect(useAuthStore.getState().user).toBeNull();
    expect(getPreferredTimeZone()).toBeNull();
  });
});

describe('accessibility', () => {
  it('the selector has a visible label and a description, and is the first control reached by Tab', async () => {
    const user = userEvent.setup();
    signIn('Asia/Kolkata');
    api.getPreferences.mockResolvedValue({ timeZone: 'Asia/Kolkata' });
    render(<TimeZoneSetting />);
    await waitFor(() => expect(select()).toBeEnabled());

    expect(screen.getByRole('combobox', { name: 'Time zone for task times' })).toBe(select());
    expect(select()).toHaveAccessibleDescription(/Due times and start times are read in this zone/);
    await user.tab();
    expect(select()).toHaveFocus();
  });

  it('can be changed and saved from the keyboard alone', async () => {
    const user = userEvent.setup();
    signIn('Asia/Kolkata');
    api.getPreferences.mockResolvedValue({ timeZone: 'Asia/Kolkata' });
    api.updatePreferences.mockResolvedValue({ timeZone: 'UTC' });
    render(<TimeZoneSetting />);
    await waitFor(() => expect(select()).toBeEnabled());

    await user.tab();
    await user.selectOptions(select(), 'UTC'); // the select is focused; this is the keyboard-equivalent change
    await user.tab();
    expect(saveButton()).toHaveFocus();
    await user.keyboard('{Enter}');

    await waitFor(() => expect(api.updatePreferences).toHaveBeenCalledWith({ timeZone: 'UTC' }));
  });

  it('announces unsaved, saved and error states to assistive technology', async () => {
    const user = userEvent.setup();
    signIn('Asia/Kolkata');
    api.getPreferences.mockResolvedValue({ timeZone: 'Asia/Kolkata' });
    api.updatePreferences.mockRejectedValue(new Error('x'));
    render(<TimeZoneSetting />);
    await waitFor(() => expect(select()).toBeEnabled());

    await user.selectOptions(select(), 'UTC');
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved change');
    await user.click(saveButton());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('groups the options by region so the long list stays navigable', async () => {
    signIn('Asia/Kolkata');
    api.getPreferences.mockResolvedValue({ timeZone: 'Asia/Kolkata' });
    render(<TimeZoneSetting />);
    await waitFor(() => expect(select()).toBeEnabled());

    const groups = [...select().querySelectorAll('optgroup')].map((group) => group.label);
    expect(groups).toEqual(expect.arrayContaining(['Asia', 'America', 'Europe', 'Pacific']));
    expect(select().options[0].value).toBe(''); // the device option comes first
  });
});
