import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmailReminderPreferences } from '../../types/auth';

// Issue #29 - the email reminder section of the Reminders page: an explicit opt-in that lives on the server. The service is
// replaced, so these tests prove what the screen asks for and shows; that the server stores it is the server's own tests.

const service = vi.hoisted(() => ({ getEmailReminders: vi.fn(), updateEmailReminders: vi.fn() }));
vi.mock('../../services/userService', () => ({ userService: service }));
vi.mock('../../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

import { useAuthStore } from '../../store/authStore';
import { saveReminderSettings } from '../../reminders/settings';
import EmailReminderSettings from './EmailReminderSettings';

const DEFAULTS: EmailReminderPreferences = {
  enabled: false,
  dueSoonEnabled: true,
  overdueEnabled: true,
  workSessionSoonEnabled: true,
  startNowEnabled: true,
  bufferMinutes: 60,
  quietHoursStart: '22:30',
  quietHoursEnd: '07:00',
  digestEnabled: false,
  digestTime: '07:30',
  timeZone: null,
  accountTimeZone: 'Asia/Kolkata',
  effectiveTimeZone: 'Asia/Kolkata',
  available: true,
};

const signIn = (id = 'a') => {
  const token = `${btoa('{}')}.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
  useAuthStore.getState().setAuth({ token, user: { id, name: 'Alice', email: 'alice@x.test', timeZone: 'Asia/Kolkata' } });
};

/** The server: holds one preference object, applies a partial update the way the real route does. */
const serverHolds = (initial: Partial<EmailReminderPreferences> = {}) => {
  let current = { ...DEFAULTS, ...initial };
  service.getEmailReminders.mockImplementation(async () => ({ ...current }));
  service.updateEmailReminders.mockImplementation(async (update: Partial<EmailReminderPreferences>) => {
    current = { ...current, ...update };
    current.effectiveTimeZone = current.timeZone ?? current.accountTimeZone ?? 'UTC';
    return { ...current };
  });
};

beforeEach(() => {
  localStorage.clear();
  service.getEmailReminders.mockReset();
  service.updateEmailReminders.mockReset();
  signIn();
});

describe('EmailReminderSettings', () => {
  it('is OFF by default: only the master switch shows, and it names the account address as the only destination', async () => {
    serverHolds();
    render(<EmailReminderSettings />);
    const toggle = await screen.findByLabelText('Email me reminders');
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/only to alice@x.test/)).toBeInTheDocument();
    expect(screen.queryByText('Which reminders')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Send a daily summary')).not.toBeInTheDocument();
    expect(service.updateEmailReminders).not.toHaveBeenCalled();
  });

  it('turning it on for the first time copies the browser reminder choices (once), then shows the options', async () => {
    saveReminderSettings({ enabled: true, bufferMinutes: 30, dueSoonEnabled: true, overdueEnabled: false, workSessionSoonEnabled: true, startNowEnabled: false, quietHoursStart: '23:00', quietHoursEnd: '06:30' });
    serverHolds();
    render(<EmailReminderSettings />);
    fireEvent.click(await screen.findByLabelText('Email me reminders'));

    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenCalledTimes(1));
    expect(service.updateEmailReminders).toHaveBeenCalledWith({
      enabled: true,
      dueSoonEnabled: true,
      overdueEnabled: false,
      workSessionSoonEnabled: true,
      startNowEnabled: false,
      bufferMinutes: 30,
      quietHoursStart: '23:00',
      quietHoursEnd: '06:30',
    });
    expect(await screen.findByText('Which reminders')).toBeInTheDocument();
    expect(screen.getByLabelText('Overdue')).not.toBeChecked();
  });

  it('when the user already customised email, turning it on again sends only the switch', async () => {
    serverHolds({ bufferMinutes: 90 });
    render(<EmailReminderSettings />);
    fireEvent.click(await screen.findByLabelText('Email me reminders'));
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenCalledWith({ enabled: true }));
  });

  it('turning it off sends only enabled:false and hides the options', async () => {
    serverHolds({ enabled: true });
    render(<EmailReminderSettings />);
    fireEvent.click(await screen.findByLabelText('Email me reminders'));
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenCalledWith({ enabled: false }));
    await waitFor(() => expect(screen.queryByText('Which reminders')).not.toBeInTheDocument());
  });

  it('each control saves just its own field', async () => {
    serverHolds({ enabled: true });
    render(<EmailReminderSettings />);
    fireEvent.click(await screen.findByLabelText('Overdue'));
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ overdueEnabled: false }));

    fireEvent.change(await screen.findByLabelText('Heads-up before a planned start'), { target: { value: '15' } });
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ bufferMinutes: 15 }));

    fireEvent.change(await screen.findByLabelText('Email quiet hours start'), { target: { value: '21:15' } });
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ quietHoursStart: '21:15' }));
  });

  it('an incomplete time (an input mid-edit) is never sent', async () => {
    serverHolds({ enabled: true });
    render(<EmailReminderSettings />);
    fireEvent.change(await screen.findByLabelText('Email quiet hours end'), { target: { value: '' } });
    expect(service.updateEmailReminders).not.toHaveBeenCalled();
  });

  it('the digest is a separate opt-in: off by default, its time appears only once it is on', async () => {
    serverHolds({ enabled: true });
    render(<EmailReminderSettings />);
    const digest = await screen.findByLabelText('Send a daily summary');
    expect(digest).not.toBeChecked();
    expect(screen.queryByLabelText('Send it at')).not.toBeInTheDocument();

    fireEvent.click(digest);
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ digestEnabled: true }));
    const time = await screen.findByLabelText('Send it at');
    expect(time).toHaveValue('07:30');
    fireEvent.change(time, { target: { value: '06:45' } });
    await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ digestTime: '06:45' }));
  });

  describe('email time zone', () => {
    it('defaults to "Use account time zone" and shows which one that is', async () => {
      serverHolds({ enabled: true });
      render(<EmailReminderSettings />);
      const select = (await screen.findByLabelText('Email time zone')) as HTMLSelectElement;
      expect(select.value).toBe('');
      expect(screen.getByRole('option', { name: 'Use account time zone (Asia/Kolkata)' })).toBeInTheDocument();
    });

    it('choosing a zone saves an override; choosing "Use account time zone" clears it (null)', async () => {
      serverHolds({ enabled: true });
      render(<EmailReminderSettings />);
      const select = await screen.findByLabelText('Email time zone');
      fireEvent.change(select, { target: { value: 'Europe/Berlin' } });
      await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ timeZone: 'Europe/Berlin' }));
      await waitFor(() => expect((screen.getByLabelText('Email time zone') as HTMLSelectElement).value).toBe('Europe/Berlin'));

      fireEvent.change(screen.getByLabelText('Email time zone'), { target: { value: '' } });
      await waitFor(() => expect(service.updateEmailReminders).toHaveBeenLastCalledWith({ timeZone: null }));
    });

    it('warns, and never guesses the device zone, when no zone is saved anywhere', async () => {
      serverHolds({ enabled: true, accountTimeZone: null, effectiveTimeZone: 'UTC' });
      render(<EmailReminderSettings />);
      expect(await screen.findByText(/No time zone is saved, so email times use UTC/)).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Use account time zone (none saved, UTC)' })).toBeInTheDocument();
      expect(service.updateEmailReminders).not.toHaveBeenCalled();
    });
  });

  it('says so when the server has no email provider configured', async () => {
    serverHolds({ available: false });
    render(<EmailReminderSettings />);
    expect(await screen.findByText(/Email delivery is not set up on this server/)).toBeInTheDocument();
  });

  it('a failed save shows an error and keeps showing what the server last confirmed', async () => {
    serverHolds({ enabled: true });
    render(<EmailReminderSettings />);
    const overdue = await screen.findByLabelText('Overdue');
    service.updateEmailReminders.mockRejectedValueOnce(new Error('network down'));
    fireEvent.click(overdue);
    expect(await screen.findByRole('alert')).toHaveTextContent(/previous settings are unchanged/);
    expect(screen.getByLabelText('Overdue')).toBeChecked();
  });

  it('a failed load says the settings need a connection and offers no controls', async () => {
    service.getEmailReminders.mockRejectedValue(new Error('offline'));
    render(<EmailReminderSettings />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/need a connection/);
    expect(screen.queryByLabelText('Email me reminders')).not.toBeInTheDocument();
  });

  it('never shows an address field, a provider name or a credential', async () => {
    serverHolds({ enabled: true });
    const { container } = render(<EmailReminderSettings />);
    await screen.findByLabelText('Email time zone');
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.textContent).not.toMatch(/smtp|brevo|api key|secret/i);
  });

  it('ignores a slow response that belongs to the previous account after the session changed', async () => {
    let resolveFirst: (value: EmailReminderPreferences) => void = () => undefined;
    service.getEmailReminders
      .mockImplementationOnce(() => new Promise<EmailReminderPreferences>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => ({ ...DEFAULTS, enabled: false }));
    render(<EmailReminderSettings />);

    act(() => signIn('b')); // another account signs in while the first request is still pending
    expect(await screen.findByLabelText('Email me reminders')).not.toBeChecked();

    await act(async () => resolveFirst({ ...DEFAULTS, enabled: true })); // the stale answer arrives late
    expect(screen.getByLabelText('Email me reminders')).not.toBeChecked();
  });
});
