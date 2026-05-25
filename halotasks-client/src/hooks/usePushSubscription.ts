import { apiClient } from '../services/api';

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);

  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return registration;
  } catch (error) {
    console.warn('[SW] Registration failed:', error);
    return null;
  }
}

export async function subscribePush(): Promise<boolean> {
  if (!VAPID_PUBLIC_KEY) {
    console.warn('[Push] VITE_VAPID_PUBLIC_KEY is not set.');
    return false;
  }

  if (!('PushManager' in window)) {
    console.warn('[Push] PushManager is not supported in this browser.');
    return false;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) as unknown as BufferSource,
    });

    await apiClient.post('/api/push/subscribe', subscription.toJSON());
    return true;
  } catch (error) {
    console.warn('[Push] Subscription failed:', error);
    return false;
  }
}

export async function unsubscribePush(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      return;
    }

    await Promise.all([
      subscription.unsubscribe(),
      apiClient.post('/api/push/unsubscribe', { endpoint: subscription.endpoint }),
    ]);
  } catch (error) {
    console.warn('[Push] Unsubscribe failed:', error);
  }
}

export async function relayToServer(payload: { title: string; body: string; tag: string }): Promise<void> {
  try {
    await apiClient.post('/api/push/relay', payload);
  } catch (error) {
    console.debug('[Push] Relay failed:', error);
  }
}