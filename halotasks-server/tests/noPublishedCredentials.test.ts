import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard for Issue #33: a reusable demo login (email + password) must never be published in the repository's
// documentation. Visitors register their own account; see docs/DEMO_ACCESS.md.
//
// Scope: Markdown documentation and the changelog files, which are the public text. Test files legitimately
// contain throwaway passwords for accounts that exist only inside the test database, so they are not scanned.

const repoRoot = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage']);

const documentationFiles = (dir: string, found: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) documentationFiles(path.join(dir, entry.name), found);
    } else if (/\.(md)$/i.test(entry.name) || entry.name === '.logs') {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
};

// `password: hunter2`, `pass : \`hunter2\``, `pwd=hunter2`, `"password": "hunter2"` ...
const CREDENTIAL = /\b(?:pass(?:word)?|pwd)\b["'`*]*\s*[:=]\s*["'`]?([^\s"'`|,<>{}()\[\]]{3,})/gi;
// Values that are obviously not a real secret: placeholders, variable references, shell/ENV names, masked text.
const PLACEHOLDER =
  /^(?:your|my|the|a|an|<|\$|%|x{3,}|\*{2,}|\.{3}|changeme|example|placeholder|password|secret|redacted|none|null|unset|required|optional|hash|string|true|false|env|process)/i;

export const findCredentialPairs = (text: string): string[] => {
  const hits: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(CREDENTIAL)) {
      if (!PLACEHOLDER.test(match[1])) hits.push(`line ${index + 1}`);
    }
  });
  return hits;
};

describe('the detector itself (so the repository scan below cannot pass vacuously)', () => {
  it.each([
    'pass : `Hunter22x`',
    'Password: Hunter22x',
    '> **pwd** = hunter22',
    '"password": "hunter22x"',
    'login with password=correcthorse',
  ])('flags %s', (line) => {
    expect(findCredentialPairs(line)).not.toEqual([]);
  });

  it.each([
    'SMTP_PASS=<16-char-app-password>',
    'MONGO_URI=mongodb+srv://user:password@cluster.mongodb.net/db',
    'Password reset is single-use',
    'password: your-password-here',
    'passwordHash: $2a$10$abc',
    'Forgot password flow',
  ])('does not flag %s', (line) => {
    expect(findCredentialPairs(line)).toEqual([]);
  });
});

describe('published documentation contains no reusable credential pair', () => {
  const files = documentationFiles(repoRoot);

  it('scans the README and the docs folder', () => {
    const relative = files.map((f) => path.relative(repoRoot, f).replace(/\\/g, '/'));
    expect(relative).toContain('README.md');
    expect(relative.some((f) => f.startsWith('docs/'))).toBe(true);
  });

  it.each(files.map((f) => [path.relative(repoRoot, f).replace(/\\/g, '/'), f]))('%s', (_name, file) => {
    expect(findCredentialPairs(fs.readFileSync(file, 'utf8'))).toEqual([]);
  });
});
