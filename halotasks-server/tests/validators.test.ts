import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  isValidEmail,
  isValidName,
  isValidPassword,
  normalizeEmail,
  normalizeName,
} from '../src/utils/validators';

describe('normalizeEmail', () => {
  it('trims whitespace and lowercases the email', () => {
    expect(normalizeEmail('  User@Example.COM  ')).toBe('user@example.com');
  });
});

describe('isValidEmail', () => {
  it('accepts well-formed addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('first.last+tag@sub.example.co')).toBe(true);
  });

  it('rejects obviously malformed addresses', () => {
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('missing-domain@')).toBe(false);
    expect(isValidEmail('@missing-local.com')).toBe(false);
    expect(isValidEmail('no-tld@example')).toBe(false);
    expect(isValidEmail('spaces in@example.com')).toBe(false);
  });
});

describe('normalizeName', () => {
  it('trims ends and collapses internal whitespace runs', () => {
    expect(normalizeName('  Aryan   K  ')).toBe('Aryan K');
  });
});

describe('isValidName', () => {
  it('rejects an empty (post-normalization) name', () => {
    expect(isValidName('')).toBe(false);
  });

  it('accepts a normal name', () => {
    expect(isValidName('Aryan K')).toBe(true);
  });

  it('rejects a name over the max length', () => {
    expect(isValidName('a'.repeat(101))).toBe(false);
  });

  it('accepts a name at exactly the max length', () => {
    expect(isValidName('a'.repeat(100))).toBe(true);
  });
});

describe('isValidPassword', () => {
  it(`rejects passwords shorter than ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toBe(false);
  });

  it(`accepts passwords at least ${PASSWORD_MIN_LENGTH} characters`, () => {
    expect(isValidPassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBe(true);
  });
});
