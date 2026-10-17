import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #36: the API client's baseURL comes from the shared resolver, so a production bundle cannot fall back to
// localhost. api.ts reads import.meta.env at module load, so each case re-imports it with the environment stubbed.
// (The build itself is covered by src/config/buildGuard.test.ts; the pure rules by src/config/apiBaseUrl.test.ts.)

vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

const loadApi = async (env: { value: string | undefined; prod: boolean }) => {
  vi.resetModules();
  vi.stubEnv('VITE_API_BASE_URL', env.value);
  vi.stubEnv('PROD', env.prod);
  vi.stubEnv('DEV', !env.prod);
  return import('./api');
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('apiClient baseURL', () => {
  it('development without the variable uses the localhost default', async () => {
    const { apiClient } = await loadApi({ value: undefined, prod: false });
    expect(apiClient.defaults.baseURL).toBe('http://localhost:5000');
  });

  it('development with a valid configured URL uses it', async () => {
    const { apiClient } = await loadApi({ value: 'https://staging-api.example.com', prod: false });
    expect(apiClient.defaults.baseURL).toBe('https://staging-api.example.com');
  });

  it('production with a valid HTTPS URL uses it', async () => {
    const { apiClient } = await loadApi({ value: 'https://api.example.com', prod: true });
    expect(apiClient.defaults.baseURL).toBe('https://api.example.com');
  });

  it('production with a valid HTTP URL uses it', async () => {
    const { apiClient } = await loadApi({ value: 'http://api.example.com', prod: true });
    expect(apiClient.defaults.baseURL).toBe('http://api.example.com');
  });

  it('production without the variable refuses to load instead of targeting localhost', async () => {
    await expect(loadApi({ value: undefined, prod: true })).rejects.toThrow(/VITE_API_BASE_URL .*required for production/);
  });

  it('production with an invalid value refuses to load', async () => {
    await expect(loadApi({ value: '/api', prod: true })).rejects.toThrow(/VITE_API_BASE_URL .*absolute URL/);
  });

  it('keeps the request and response interceptors installed', async () => {
    const { apiClient } = await loadApi({ value: undefined, prod: false });
    // axios exposes its interceptor managers; both must still carry the session-aware handlers.
    const request = apiClient.interceptors.request as unknown as { handlers: unknown[] };
    const response = apiClient.interceptors.response as unknown as { handlers: unknown[] };
    expect(request.handlers.length).toBeGreaterThan(0);
    expect(response.handlers.length).toBeGreaterThan(0);
  });
});
