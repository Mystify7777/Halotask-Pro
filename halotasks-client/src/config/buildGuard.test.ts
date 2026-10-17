// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from 'vite';

// Issue #36: `vite build` must fail when VITE_API_BASE_URL is missing or invalid.
//
// This resolves the REAL vite.config.ts the way `vite build` does (resolveConfig runs every plugin's
// configResolved hook, which is where the guard lives) without bundling anything. VITE_API_BASE_URL is supplied the
// way Vercel supplies it, through the process environment. envDir points at a folder with no .env files so a
// developer's own client/.env cannot change the outcome. Vitest runs from the client package directory (its
// config and setup file are resolved relative to it), which is also where the config file is discovered.

const resolveBuild = () => resolveConfig({ mode: 'production', envDir: 'src/config', logLevel: 'silent' }, 'build');

const withApiUrl = (value: string | undefined) => vi.stubEnv('VITE_API_BASE_URL', value);

afterEach(() => vi.unstubAllEnvs());

describe('vite build guard', () => {
  it('passes with a valid HTTPS API origin', async () => {
    withApiUrl('https://api.example.com');
    const config = await resolveBuild();
    expect(config.command).toBe('build');
    expect(config.env.VITE_API_BASE_URL).toBe('https://api.example.com');
  });

  it('passes with a valid HTTP API origin', async () => {
    withApiUrl('http://api.example.com:5000');
    await expect(resolveBuild()).resolves.toBeDefined();
  });

  it('fails clearly when the variable is missing', async () => {
    withApiUrl(undefined);
    await expect(resolveBuild()).rejects.toThrow(/VITE_API_BASE_URL .*required for production/);
  });

  it('fails clearly when the variable is blank', async () => {
    withApiUrl('   ');
    await expect(resolveBuild()).rejects.toThrow(/VITE_API_BASE_URL .*required for production/);
  });

  it.each(['/api', 'api.example.com', 'ftp://api.example.com', 'https://user:pass@api.example.com', 'http://'])(
    'fails for an invalid value: %s',
    async (value) => {
      withApiUrl(value);
      await expect(resolveBuild()).rejects.toThrow(/^VITE_API_BASE_URL /);
    },
  );

  it('does not expose other environment values in the failure', async () => {
    withApiUrl(undefined);
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'UNRELATED-ENV-VALUE');
    const failure = await resolveBuild().then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(failure).not.toBeNull();
    expect(failure?.message).not.toContain('UNRELATED-ENV-VALUE');
  });

  it('does not run for the dev server or Vitest, which keep the localhost default', async () => {
    withApiUrl(undefined);
    const config = await resolveConfig({ mode: 'development', envDir: 'src/config', logLevel: 'silent' }, 'serve');
    expect(config.command).toBe('serve');
  });
});
