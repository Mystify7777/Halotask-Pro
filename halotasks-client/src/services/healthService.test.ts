import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #12: one real readiness probe, and what it makes of each kind of answer. axios.get is the only thing replaced
// (and IndexedDB, which the auth store reaches for and jsdom does not have).
vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

import { useAuthStore } from '../store/authStore';
import { apiClient } from './api';
import { HEALTH_PROBE_TIMEOUT_MS, probeBackendHealth } from './healthService';

const answer = (status: number, data: unknown) => vi.spyOn(axios, 'get').mockResolvedValue({ status, data });

afterEach(() => vi.restoreAllMocks());

describe('probeBackendHealth: classifying the answer', () => {
  it('200 { status: "ok" } is ok', async () => {
    answer(200, { status: 'ok' });
    expect(await probeBackendHealth()).toBe('ok');
  });

  it('the backend\'s own { status: "unavailable" } is unhealthy (it answered, and it is not well)', async () => {
    answer(503, { status: 'unavailable' });
    expect(await probeBackendHealth()).toBe('unhealthy');
  });

  it.each([
    ['a gateway error page while a host wakes (HTML)', 502, '<html>Bad gateway</html>'],
    ['a gateway 503 with no backend body', 503, ''],
    ['a gateway 504', 504, undefined],
    ['a 200 that is not the backend\'s answer', 200, 'HaloTasks API running'],
    ['a 200 with another status value', 200, { status: 'starting' }],
    ['a 200 with no status at all', 200, {}],
    ['an array body', 200, [{ status: 'ok' }]],
    ['a null body', 200, null],
    ['"ok" with a non-200 status', 500, { status: 'ok' }],
    ['"ok" with the unhealthy status (503), a body that contradicts its status', 503, { status: 'ok' }],
    ['"unavailable" with a 200, a body that contradicts its status (a misconfigured proxy, not the backend\'s own signal)', 200, { status: 'unavailable' }],
    ['"unavailable" with another error status (500)', 500, { status: 'unavailable' }],
    ['"unavailable" with a gateway status (502)', 502, { status: 'unavailable' }],
    ['a 404 from a backend that does not have the endpoint', 404, { message: 'Route /api/health not found' }],
  ])('%s is no-answer, never ready', async (_label, status, data) => {
    answer(status, data);
    expect(await probeBackendHealth()).toBe('no-answer');
  });

  it.each([
    ['a network error', new Error('Network Error')],
    ['a timeout', Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' })],
    ['an aborted request', Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })],
  ])('%s is no-answer', async (_label, error) => {
    vi.spyOn(axios, 'get').mockRejectedValue(error);
    expect(await probeBackendHealth()).toBe('no-answer');
  });
});

describe('probeBackendHealth: what it sends', () => {
  it('asks /api/health on the API base URL, accepts every status as an answer, gives up after its timeout, and honours the abort signal', async () => {
    const get = answer(200, { status: 'ok' });
    const controller = new AbortController();

    await probeBackendHealth(controller.signal);

    expect(get).toHaveBeenCalledTimes(1);
    const [url, config] = get.mock.calls[0];
    expect(url).toBe('/api/health');
    expect(config).toMatchObject({ baseURL: apiClient.defaults.baseURL, timeout: HEALTH_PROBE_TIMEOUT_MS, signal: controller.signal });
    expect(config?.validateStatus?.(503)).toBe(true);
  });

  it('carries no credentials and never goes through the session-aware client, even while someone is signed in', async () => {
    useAuthStore.setState({ token: 'secret-token' });
    const get = answer(200, { status: 'ok' });
    const viaClient = vi.spyOn(apiClient, 'get');
    const clientRequest = vi.spyOn(apiClient, 'request');

    await probeBackendHealth();

    const config = get.mock.calls[0][1] as { headers?: Record<string, unknown> } | undefined;
    expect(JSON.stringify(config?.headers ?? {})).not.toMatch(/authorization|secret-token/i);
    expect(viaClient).not.toHaveBeenCalled();
    expect(clientRequest).not.toHaveBeenCalled();
    useAuthStore.setState({ token: null });
  });
});
