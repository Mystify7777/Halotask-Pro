import type { ScopedVerdict } from './launchState';

/**
 * What the SERVER said about a session, as the API client sees it (Issue #49). The API client reports; the launch provider
 * listens and stores the answer through `recordVerdict`, which drops anything that is not for the current session. This
 * module holds no state about sessions and decides nothing: it only carries an answer from where it is seen (the axios
 * interceptor, outside React) to where it is used (the provider).
 *
 * An answer is a REAL authenticated response: a success for a request that carried a bearer token, or a 401 for one. Public
 * calls (sign-in, register, password reset) and the health probe never produce one.
 */
type Listener = (answer: ScopedVerdict) => void;

const listeners = new Set<Listener>();

export function reportSessionAnswer(answer: ScopedVerdict): void {
  for (const listener of [...listeners]) {
    // An observer must never be able to break the response path of a request.
    try {
      listener(answer);
    } catch {
      /* ignored on purpose */
    }
  }
}

export function subscribeSessionAnswers(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
