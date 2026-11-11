// How a failed request is classified, in ONE place: the sync queue (when it replays an entry) and the online completion
// paths (when a write fails and the completion event must not be lost) have to agree on what "will never succeed" means.

/** The HTTP status of a failed request, or null when there was no response at all (network error, timeout, aborted). */
export function httpStatusOf(error: unknown): number | null {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object' &&
    (error as { response: { status?: unknown } }).response !== null
      ? (error as { response: { status?: number } }).response?.status
      : null;

  return typeof status === 'number' ? status : null;
}

/**
 * Returns true for HTTP status codes that are permanent client errors.
 * Retrying these entries will not succeed, so they should be discarded.
 * (401 is deliberately not one of them: it is a statement about the credential, not about the action. 408 and 429 are
 * "try again later". No response at all is a network failure and is retried.)
 */
export function isPermanentError(error: unknown): boolean {
  const status = httpStatusOf(error);

  if (status === null || status === 401) {
    return false;
  }

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}
