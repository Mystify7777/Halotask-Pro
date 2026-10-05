import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TEST_JWT_SECRET } from './testConfig';

const serverRoot = path.resolve(__dirname, '..');

const listSourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(ts|js|json)$/.test(entry.name) ? [full] : [];
  });

describe('test-only configuration isolation', () => {
  it('the test secret is unmistakably a placeholder', () => {
    expect(TEST_JWT_SECRET).toContain('TEST-ONLY');
  });

  const srcFiles = listSourceFiles(path.join(serverRoot, 'src'));

  it('finds source files to scan (guards against a vacuous pass)', () => {
    expect(srcFiles.length).toBeGreaterThan(10);
  });

  it('no file under src/ contains the test secret', () => {
    const offenders = srcFiles.filter((f) => fs.readFileSync(f, 'utf8').includes(TEST_JWT_SECRET));
    expect(offenders).toEqual([]);
  });

  it('no file under src/ imports from tests/ or testConfig', () => {
    const offenders = srcFiles.filter((f) =>
      /from\s+['"][^'"]*(\/tests\/|testConfig)[^'"]*['"]|require\(['"][^'"]*(\/tests\/|testConfig)/.test(
        fs.readFileSync(f, 'utf8')
      )
    );
    expect(offenders).toEqual([]);
  });

  it('.env.example leaves JWT_SECRET blank and never contains the test secret', () => {
    const env = fs.readFileSync(path.join(serverRoot, '.env.example'), 'utf8');
    expect(env).not.toContain(TEST_JWT_SECRET);
    expect(env).toMatch(/^JWT_SECRET=\s*$/m);
  });
});
