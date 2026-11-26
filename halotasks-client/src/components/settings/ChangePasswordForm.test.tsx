import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AxiosError } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #46 — the Settings change-password form. The real auth store, API client guard and PasswordInput run; the API
// (userService), IndexedDB and push registration are replaced so each request can be held and settled by hand.

const api = vi.hoisted(() => ({ changePassword: vi.fn() }));
vi.mock('../../services/userService', () => ({ userService: api }));
vi.mock('../../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));
const push = vi.hoisted(() => ({ subscribePush: vi.fn(async () => true) }));
vi.mock('../../hooks/usePushSubscription', () => push);

import { apiClient, authRedirect } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import ChangePasswordForm, { describeChangeFailure } from './ChangePasswordForm';

const exp = () => Math.floor(Date.now() / 1000) + 3600;
const jwtLike = (n: string) => `${btoa('{}')}.${btoa(JSON.stringify({ exp: exp(), n }))}.sig`;
const OLD_TOKEN = jwtLike('old');
const NEW_TOKEN = jwtLike('new');
const ALICE = { id: 'a', name: 'Alice', email: 'a@x.test' };

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
const failure = (status: number, data: Record<string, unknown>) =>
  new AxiosError('x', 'ERR_BAD_REQUEST', undefined, undefined, { status, data, statusText: '', headers: {}, config: {} as never });

const renderForm = () => render(<ChangePasswordForm />);

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
const fill = async (user: ReturnType<typeof userEvent.setup>, current: string, next: string, confirm: string) => {
  if (current) await user.type(field('Current password'), current);
  if (next) await user.type(field('New password'), next);
  if (confirm) await user.type(field('Confirm new password'), confirm);
};
const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: /^change password|changing/i }));

const setOnline = (value: boolean) => {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
  act(() => {
    window.dispatchEvent(new Event(value ? 'online' : 'offline'));
  });
};

beforeEach(() => {
  api.changePassword.mockReset();
  push.subscribePush.mockClear();
  localStorage.clear();
  useAuthStore.getState().setAuth({ token: OLD_TOKEN, user: ALICE });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what the form asks for before it calls the server', () => {
  it.each([
    ['no current password', '', 'new-password-1', 'new-password-1', 'Enter your current password.'],
    ['a short new password', 'old-password', '12345', '12345', 'The new password must be at least 6 characters long.'],
    ['a new password equal to the current one', 'same-password', 'same-password', 'same-password', 'The new password must be different from the current one.'],
    ['a confirmation that does not match', 'old-password', 'new-password-1', 'new-password-2', 'The new passwords do not match.'],
  ])('%s is refused locally and nothing is sent', async (_name, current, next, confirm, message) => {
    const user = userEvent.setup();
    renderForm();
    await fill(user, current, next, confirm);
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(api.changePassword).not.toHaveBeenCalled();
  });

  it('shows a mismatch note while typing the confirmation', async () => {
    const user = userEvent.setup();
    renderForm();
    await fill(user, '', 'new-password-1', 'new-pass');
    expect(screen.getByRole('note')).toHaveTextContent('do not match yet');
  });

  it('points someone who forgot the current password at the signed-out reset flow, without a link that would bounce them back (a signed-in user is redirected away from /forgot-password)', () => {
    renderForm();
    expect(screen.getByText(/forgot your current password\? sign out/i)).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('labels', () => {
  it.each(['Current password', 'New password', 'Confirm new password'])(
    'the visible "%s" label is really associated with its input (label.control is the input, and clicking the label focuses it)',
    async (name) => {
      const user = userEvent.setup();
      renderForm();
      const label = screen.getByText(name, { selector: 'label' }) as HTMLLabelElement;
      const input = field(name);
      expect(label.control).toBe(input);
      await user.click(label);
      expect(input).toHaveFocus();
    },
  );
});

describe('online only', () => {
  it('offline: the button is disabled, a note says why, and submitting sends nothing; online again enables it', async () => {
    setOnline(false);
    const user = userEvent.setup();
    renderForm();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent('needs a connection');
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);
    expect(api.changePassword).not.toHaveBeenCalled();

    setOnline(true);
    expect(screen.getByRole('button', { name: 'Change password' })).toBeEnabled();
  });

  it('nothing is written to storage, queued or cached by an attempt', async () => {
    api.changePassword.mockRejectedValue(failure(403, { code: 'INVALID_CURRENT_PASSWORD' }));
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'old-password-xyz', 'new-password-abc', 'new-password-abc');
    await submit(user);
    await screen.findByRole('alert');
    const everything = JSON.stringify({ ...localStorage, ...sessionStorage });
    expect(everything).not.toContain('old-password-xyz');
    expect(everything).not.toContain('new-password-abc');
  });
});

describe('a successful change', () => {
  it('sends the two passwords, replaces the session with the returned token, clears the fields and says so', async () => {
    const generationBefore = useAuthStore.getState().sessionGeneration;
    api.changePassword.mockResolvedValue({ token: NEW_TOKEN, user: { ...ALICE, timeZone: 'Asia/Kolkata' }, message: 'ok' });
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);

    expect(api.changePassword).toHaveBeenCalledWith({ currentPassword: 'old-password', newPassword: 'new-password-1' });
    expect(await screen.findByRole('status')).toHaveTextContent('Your other devices were signed out');
    expect(useAuthStore.getState().token).toBe(NEW_TOKEN);
    expect(localStorage.getItem('halotasks_token')).toBe(NEW_TOKEN);
    expect(useAuthStore.getState().user?.timeZone).toBe('Asia/Kolkata');
    expect(useAuthStore.getState().sessionGeneration).toBe(generationBefore + 1);
    expect(field('Current password').value).toBe('');
    expect(field('New password').value).toBe('');
    expect(field('Confirm new password').value).toBe('');
  });

  it('shows nothing finished before the answer, and blocks a second submit while it is out', async () => {
    const held = deferred<{ token: string; user: typeof ALICE; message: string }>();
    api.changePassword.mockReturnValue(held.promise);
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);

    expect(screen.getByRole('button', { name: 'Changing…' })).toBeDisabled();
    expect(screen.queryByRole('status')).toBeNull();
    expect(useAuthStore.getState().token).toBe(OLD_TOKEN);
    await user.click(screen.getByRole('button', { name: 'Changing…' }));
    expect(api.changePassword).toHaveBeenCalledTimes(1);

    await act(async () => held.resolve({ token: NEW_TOKEN, user: ALICE, message: 'ok' }));
    expect(await screen.findByRole('status')).toBeInTheDocument();
  });

  it('while the change is out, another request of this tab refused 401 does not sign the user out (the form runs inside the session swap)', async () => {
    const redirect = vi.spyOn(authRedirect, 'toLogin').mockImplementation(() => {});
    const adapter = apiClient.defaults.adapter;
    apiClient.defaults.adapter = (config) => Promise.reject(new AxiosError('HTTP 401', 'ERR_BAD_REQUEST', config, undefined, { status: 401, data: {}, statusText: '', headers: {}, config }));
    try {
      const held = deferred<{ token: string; user: typeof ALICE; message: string }>();
      api.changePassword.mockReturnValue(held.promise);
      const user = userEvent.setup();
      renderForm();
      await fill(user, 'old-password', 'new-password-1', 'new-password-1');
      await submit(user);

      await expect(apiClient.get('/api/stray')).rejects.toMatchObject({ response: { status: 401 } });
      expect(redirect).not.toHaveBeenCalled();
      expect(useAuthStore.getState().token).toBe(OLD_TOKEN);

      await act(async () => held.resolve({ token: NEW_TOKEN, user: ALICE, message: 'ok' }));
      expect(await screen.findByRole('status')).toBeInTheDocument();
      expect(useAuthStore.getState().token).toBe(NEW_TOKEN);
    } finally {
      apiClient.defaults.adapter = adapter;
    }
  });

  it('registers this device for push again only when notifications are allowed', async () => {
    api.changePassword.mockResolvedValue({ token: NEW_TOKEN, user: ALICE, message: 'ok' });

    vi.stubGlobal('Notification', { permission: 'granted' });
    const user = userEvent.setup();
    const first = renderForm();
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);
    await screen.findByRole('status');
    expect(push.subscribePush).toHaveBeenCalledTimes(1);
    first.unmount();

    push.subscribePush.mockClear();
    vi.stubGlobal('Notification', { permission: 'default' });
    renderForm();
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);
    await screen.findByRole('status');
    expect(push.subscribePush).not.toHaveBeenCalled();
  });
});

describe('a failed change', () => {
  it('a wrong current password says so, keeps the session, does not sign out, and clears the fields', async () => {
    const generationBefore = useAuthStore.getState().sessionGeneration;
    api.changePassword.mockRejectedValue(failure(403, { code: 'INVALID_CURRENT_PASSWORD', message: 'x' }));
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'wrong-password', 'new-password-1', 'new-password-1');
    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('The current password is incorrect.');
    expect(useAuthStore.getState().token).toBe(OLD_TOKEN);
    expect(useAuthStore.getState().sessionGeneration).toBe(generationBefore);
    expect(field('Current password').value).toBe('');
    expect(field('New password').value).toBe('');
    expect(screen.queryByRole('status')).toBeNull();
    expect(push.subscribePush).not.toHaveBeenCalled();
  });

  it('a request that got no answer says the change may have happened and to sign in again with the new password', async () => {
    api.changePassword.mockRejectedValue(new AxiosError('Network Error', 'ERR_NETWORK'));
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent('sign in again with the new password');
    expect(useAuthStore.getState().token).toBe(OLD_TOKEN);
  });

  it('can be tried again after a failure', async () => {
    api.changePassword.mockRejectedValueOnce(failure(403, { code: 'INVALID_CURRENT_PASSWORD' })).mockResolvedValueOnce({ token: NEW_TOKEN, user: ALICE, message: 'ok' });
    const user = userEvent.setup();
    renderForm();
    await fill(user, 'wrong-password', 'new-password-1', 'new-password-1');
    await submit(user);
    await screen.findByRole('alert');
    await fill(user, 'old-password', 'new-password-1', 'new-password-1');
    await submit(user);
    await waitFor(() => expect(useAuthStore.getState().token).toBe(NEW_TOKEN));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('describeChangeFailure', () => {
  it.each([
    [failure(403, { code: 'INVALID_CURRENT_PASSWORD' }), 'The current password is incorrect.'],
    [failure(400, { code: 'PASSWORD_UNCHANGED' }), 'The new password must be different from the current one.'],
    [failure(400, { code: 'PASSWORD_TOO_SHORT' }), 'The new password must be at least 6 characters long.'],
    [failure(409, { code: 'PASSWORD_CHANGED_ELSEWHERE' }), 'The password was changed from somewhere else. Please sign in again.'],
    [failure(429, { message: 'Too many requests. Please try again later.' }), 'Too many attempts. Please try again later.'],
    [failure(401, {}), 'Your session has ended. Please sign in again.'],
    [failure(500, { message: 'Internal server error' }), 'Internal server error'],
    [failure(500, {}), 'The password could not be changed. Please try again.'],
  ])('maps %# to its sentence', (error, text) => {
    expect(describeChangeFailure(error)).toBe(text);
  });
});
