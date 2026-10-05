import { Response } from 'express';
import webpush from 'web-push';
import { createPushAgent } from '../utils/pushNetworkGuard';
import User from '../models/User.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  PUSH_SUBSCRIPTIONS_MAX_PER_USER,
  parsePushSubscription,
  parseRelay,
  parseUnsubscribe,
} from '../utils/pushValidators';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT_EMAIL } = process.env;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${VAPID_CONTACT_EMAIL ?? 'admin@halotasks.app'}`,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
  );
} else {
  console.warn(
    '[Push] VAPID keys not configured. Run scripts/generate-vapid.js and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env',
  );
}

interface StoredSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

/** Per-delivery cap so one slow or hostile push endpoint cannot hold a relay request open indefinitely. */
const PUSH_DELIVERY_TIMEOUT_MS = 10_000;
// Shared agent whose DNS lookup refuses non-public addresses (SSRF boundary; see utils/pushNetworkGuard.ts).
const pushAgent = createPushAgent();

// Subscription material (endpoints are capability URLs, p256dh/auth are key material) is never logged.
// When a delivery has to be reported, only the push service's HOST and a status code are.
const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'invalid-endpoint';
  }
};

export const subscribe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user.id;

  const parsed = parsePushSubscription(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }
  const subscription = parsed.value;

  // Dedup and the per-user bound are enforced by single-document conditional updates (Mongo applies
  // each atomically), never by read-then-write or by a $pull followed by a $push:
  //   1. endpoint already stored  -> refresh its keys/expiry in place;
  //   2. endpoint absent          -> append, keeping only the newest PUSH_SUBSCRIPTIONS_MAX_PER_USER
  //                                  ($slice drops the oldest, so the array can never exceed the bound);
  //   3. step 2 matched nothing   -> another request stored this endpoint in between; refresh it.
  const refresh = () =>
    User.updateOne(
      { _id: userId, 'pushSubscriptions.endpoint': subscription.endpoint },
      { $set: { 'pushSubscriptions.$': subscription } },
    );

  if ((await refresh()).matchedCount > 0) {
    res.json({ ok: true });
    return;
  }

  const appended = await User.updateOne(
    { _id: userId, 'pushSubscriptions.endpoint': { $ne: subscription.endpoint } },
    { $push: { pushSubscriptions: { $each: [subscription], $slice: -PUSH_SUBSCRIPTIONS_MAX_PER_USER } } },
  );

  if (appended.matchedCount === 0 && (await refresh()).matchedCount === 0) {
    // Neither branch found the user: the token belongs to an account that no longer exists.
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  res.json({ ok: true });
};

export const unsubscribe = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user.id;

  const parsed = parseUnsubscribe(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  // The endpoint is a validated string, so it cannot carry a query operator such as { $ne: ... }.
  await User.findByIdAndUpdate(userId, {
    $pull: { pushSubscriptions: { endpoint: parsed.value.endpoint } },
  });

  res.json({ ok: true });
};

/**
 * Relay a notification to every device the caller registered.
 *   200 { sent, failed, pruned }
 *     sent    deliveries the push service accepted
 *     failed  deliveries that failed for any reason other than "gone" (kept; may recover)
 *     pruned  subscriptions the push service reported gone (404/410) and that were removed
 * Deliveries are independent: one failing endpoint never prevents the others, and a failure to prune
 * never turns a completed relay into an error.
 */
export const relay = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.user.id;

  const parsed = parseRelay(req.body);
  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    res.json({ sent: 0, reason: 'vapid_not_configured' });
    return;
  }

  const user = await User.findById(userId).select('pushSubscriptions').lean();
  const subscriptions = (user?.pushSubscriptions ?? []) as StoredSubscription[];

  if (subscriptions.length === 0) {
    res.json({ sent: 0 });
    return;
  }

  const staleEndpoints: string[] = [];
  let sent = 0;
  let failed = 0;

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription as webpush.PushSubscription, parsed.value.payload, {
          TTL: 3600,
          timeout: PUSH_DELIVERY_TIMEOUT_MS,
          agent: pushAgent,
        });
        sent += 1;
      } catch (error: unknown) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.push(subscription.endpoint);
        } else {
          failed += 1;
          console.warn(
            `[Push] Delivery failed (host ${hostOf(subscription.endpoint)}, ${
              typeof statusCode === 'number' ? `status ${statusCode}` : 'no status'
            })`,
          );
        }
      }
    }),
  );

  let pruned = 0;
  if (staleEndpoints.length > 0) {
    try {
      await User.findByIdAndUpdate(userId, {
        $pull: { pushSubscriptions: { endpoint: { $in: staleEndpoints } } },
      });
      pruned = staleEndpoints.length;
    } catch {
      console.warn('[Push] Could not prune stale subscriptions; they will be retried on the next relay.');
    }
  }

  res.json({ sent, failed, pruned });
};
