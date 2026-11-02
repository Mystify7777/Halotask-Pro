import axios from 'axios';
import { apiClient } from './api';

/**
 * What one readiness probe learned (Issue #12):
 * The server's contract has exactly two outcomes, and each is an exact HTTP status AND body pair:
 *  - 'ok'         `200 { status: 'ok' }`: it is serving and its database is connected.
 *  - 'unhealthy'  `503 { status: 'unavailable' }`: it is up but cannot do its job.
 *  - 'no-answer'  everything else: no response (network error, timeout), or a response that is not the backend's own
 *                 (a gateway error page while a sleeping host wakes, a proxy's reply, an unexpected body, a body that
 *                 contradicts its status such as `200 { status: 'unavailable' }` or `503 { status: 'ok' }`). This is
 *                 what an ordinary cold start looks like, so it is never reported as "ready" and never counted as the
 *                 backend itself saying it is unwell.
 */
export type HealthProbeResult = 'ok' | 'unhealthy' | 'no-answer';

/** One probe gives up after this long. A host that is still waking usually holds the request open, so the caller retries. */
export const HEALTH_PROBE_TIMEOUT_MS = 10_000;

const statusOf = (data: unknown): unknown =>
  typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as { status?: unknown }).status : undefined;

/**
 * Asks the backend whether it is ready, WITHOUT a session. It deliberately does not go through `apiClient`'s
 * interceptors: no Authorization header is attached, nothing reads the signed-in account, and a response can never sign
 * anyone out. Only the API's base URL is shared, so there is one place that knows where the backend lives.
 */
export async function probeBackendHealth(signal?: AbortSignal): Promise<HealthProbeResult> {
  try {
    const response = await axios.get('/api/health', {
      baseURL: apiClient.defaults.baseURL,
      timeout: HEALTH_PROBE_TIMEOUT_MS,
      signal,
      // Every status is an answer to classify, not an exception.
      validateStatus: () => true,
    });

    const status = statusOf(response.data);
    if (response.status === 200 && status === 'ok') return 'ok';
    if (response.status === 503 && status === 'unavailable') return 'unhealthy';
    return 'no-answer';
  } catch {
    return 'no-answer';
  }
}
