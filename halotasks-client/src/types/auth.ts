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