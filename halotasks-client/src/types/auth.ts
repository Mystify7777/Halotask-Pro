export type AuthUser = {
  id: string;
  name: string;
  email: string;
  /**
   * The user's saved IANA time zone (Issue #41), or null / absent when they have not chosen one. Absent is normal:
   * accounts and cached sessions that predate the preference have no such field, and the device's zone is used as a
   * fallback WITHOUT being saved.
   */
  timeZone?: string | null;
};

/** What GET and PUT /api/user/preferences return and accept. `timeZone: null` clears the saved choice. */
export type UserPreferences = {
  timeZone: string | null;
};

/**
 * What GET /api/user/email-reminders returns (Issue #29). Email reminders are OFF until the user turns them on. `timeZone`
 * is the email-only override (null = follow the account's time zone); `effectiveTimeZone` is the zone email scheduling
 * actually reads in. `available` says whether this server can send email at all.
 */
export type EmailReminderPreferences = {
  enabled: boolean;
  dueSoonEnabled: boolean;
  overdueEnabled: boolean;
  workSessionSoonEnabled: boolean;
  startNowEnabled: boolean;
  bufferMinutes: 15 | 30 | 60 | 90;
  quietHoursStart: string;
  quietHoursEnd: string;
  digestEnabled: boolean;
  digestTime: string;
  timeZone: string | null;
  accountTimeZone: string | null;
  effectiveTimeZone: string;
  available: boolean;
};

/** What PUT /api/user/email-reminders accepts: any subset of the editable fields. `timeZone: null` clears the override. */
export type EmailReminderUpdate = Partial<Omit<EmailReminderPreferences, 'accountTimeZone' | 'effectiveTimeZone' | 'available'>>;

export type AuthResponse = {
  token: string;
  user: AuthUser;
};

export type LoginPayload = {
  email: string;
  password: string;
};

export type RegisterPayload = {
  name: string;
  email: string;
  password: string;
};

export type ForgotPasswordPayload = {
  email: string;
};

export type ResetPasswordPayload = {
  email: string;
  token: string;
  password: string;
};

export type AuthMessageResponse = {
  message: string;
};