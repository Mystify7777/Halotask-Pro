/**
 * What the person is told about synchronization (Issue #58). This file owns the INTERPRETATION of the facts and nothing
 * else: it does no I/O, reads no clock, imports no React. The facts are owned by `useDashboardSync` (the single drain
 * funnel), each from the thing that actually knows it:
 *
 *   online       the existing connectivity signal
 *   pending      the length of the durable queue (Issue #57), re-read from storage, never counted by hand
 *   draining     a drain in this tab is between its start and its end
 *   blocked      why the last drain stopped before finishing (reported by the queue processor)
 *   rejections   changes the server received and explicitly refused (kept for this session, until dismissed)
 *   confirmedAt  the last time THIS session observed an empty queue as the result of a successful drain or list fetch
 *
 * "synced" is therefore never set by a code path; it is derived, so it cannot outlive a new local change.
 *
 * What the states do and do not claim:
 *  - `synced`: every change this device queued was accepted by the server. It does NOT say other devices' changes are
 *    visible here, nor that a Growth Tree award was granted.
 *  - `blocked` and `rejections` are different facts and stay different. `unreachable`: the server may not have received
 *    the work. `auth`: nothing can be sent until the sign-in is repaired. A rejection: the server DID receive the work and
 *    refused it. Do not collapse them into one "sync error".
 */

/** Why a drain stopped with work left. `null` when it did not stop early. */
export type BlockedReason = 'unreachable' | 'auth';

export type SyncFacts = {
  online: boolean;
  pending: number;
  draining: boolean;
  blocked: BlockedReason | null;
  /** Number of refused changes not yet dismissed. */
  rejections: number;
  /** ISO time, session-scoped; see the invariant on `useDashboardSync`. */
  confirmedAt: string | null;
};

export type SyncKind = 'attention' | 'syncing' | 'offline' | 'pending' | 'synced' | 'unverified';

export type SyncState = {
  kind: SyncKind;
  pending: number;
  /** Only for `attention`: what needs the person. Both can be set. */
  rejected: number;
  blocked: BlockedReason | null;
  /** Only for `synced`. */
  confirmedAt: string | null;
};

export function deriveSyncState(facts: SyncFacts): SyncState {
  const { online, pending, draining, rejections } = facts;
  // A stuck queue matters only while it can be acted on: online, with work left, and no attempt running right now.
  const stuck = online && pending > 0 && !draining ? facts.blocked : null;
  const base = { pending, rejected: rejections, blocked: null as BlockedReason | null, confirmedAt: null as string | null };

  if (rejections > 0 || stuck) return { ...base, kind: 'attention', blocked: stuck };
  if (draining && pending > 0) return { ...base, kind: 'syncing', rejected: 0 };
  if (!online) return { ...base, kind: 'offline', rejected: 0 };
  if (pending > 0) return { ...base, kind: 'pending', rejected: 0 };
  if (facts.confirmedAt) return { ...base, kind: 'synced', rejected: 0, confirmedAt: facts.confirmedAt };
  return { ...base, kind: 'unverified', rejected: 0 };
}
