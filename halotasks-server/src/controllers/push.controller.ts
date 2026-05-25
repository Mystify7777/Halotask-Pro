import { Request, Response } from 'express';
import webpush from 'web-push';
import User from '../models/User.model';

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

interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export const subscribe = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const subscription = req.body as Partial<PushSubscriptionJSON>;

  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    res.status(400).json({ message: 'Invalid push subscription object' });
    return;
  }

  await User.findByIdAndUpdate(userId, {
    $pull: { pushSubscriptions: { endpoint: subscription.endpoint } },
  });

  await User.findByIdAndUpdate(userId, {
    $push: { pushSubscriptions: subscription },
  });

  res.json({ ok: true });
};

export const unsubscribe = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const { endpoint } = req.body as { endpoint?: string };

  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (!endpoint) {
    res.status(400).json({ message: 'endpoint is required' });
    return;
  }

  await User.findByIdAndUpdate(userId, {
    $pull: { pushSubscriptions: { endpoint } },
  });

  res.json({ ok: true });
};

export const relay = async (req: Request, res: Response): Promise<void> => {
  const userId = req.user?.id;
  const { title, body, tag } = req.body as {
    title?: string;
    body?: string;
    tag?: string;
  };

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    res.json({ sent: 0, reason: 'vapid_not_configured' });
    return;
  }

  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (!title || !body) {
    res.status(400).json({ message: 'title and body are required' });
    return;
  }

  const user = await User.findById(userId).select('pushSubscriptions').lean();
  const subscriptions = (user?.pushSubscriptions ?? []) as PushSubscriptionJSON[];

  if (subscriptions.length === 0) {
    res.json({ sent: 0 });
    return;
  }

  const payload = JSON.stringify({ title, body, tag: tag ?? 'halotask-push' });
  const staleEndpoints: string[] = [];
  let sent = 0;

  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(subscription as webpush.PushSubscription, payload, {
          TTL: 3600,
        });
        sent += 1;
      } catch (error: unknown) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          staleEndpoints.push(subscription.endpoint);
        } else {
          console.warn('[Push] Delivery failed for endpoint:', subscription.endpoint, error);
        }
      }
    }),
  );

  if (staleEndpoints.length > 0) {
    await User.findByIdAndUpdate(userId, {
      $pull: { pushSubscriptions: { endpoint: { $in: staleEndpoints } } },
    });
  }

  res.json({ sent, pruned: staleEndpoints.length });
};