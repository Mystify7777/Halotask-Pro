import { describe, expect, it } from 'vitest';
import { isMalformedJsonBodyError, isPayloadTooLargeError } from '../src/utils/httpErrors';

describe('isPayloadTooLargeError', () => {
  it('returns true for body-parser\'s entity.too.large error shape', () => {
    expect(isPayloadTooLargeError({ type: 'entity.too.large', status: 413 })).toBe(true);
  });

  it('returns false for other error types', () => {
    expect(isPayloadTooLargeError({ type: 'entity.parse.failed', status: 400 })).toBe(false);
  });

  it('returns false for a plain Error without a type field', () => {
    expect(isPayloadTooLargeError(new Error('boom'))).toBe(false);
  });

  it('returns false for null, undefined, and non-object values', () => {
    expect(isPayloadTooLargeError(null)).toBe(false);
    expect(isPayloadTooLargeError(undefined)).toBe(false);
    expect(isPayloadTooLargeError('entity.too.large')).toBe(false);
  });
});

describe('isMalformedJsonBodyError', () => {
  it('returns true for body-parser\'s entity.parse.failed error shape', () => {
    expect(isMalformedJsonBodyError({ type: 'entity.parse.failed', status: 400 })).toBe(true);
  });

  it('returns false for other error types', () => {
    expect(isMalformedJsonBodyError({ type: 'entity.too.large', status: 413 })).toBe(false);
  });

  it('returns false for a plain Error without a type field', () => {
    expect(isMalformedJsonBodyError(new Error('bad json'))).toBe(false);
  });

  it('returns false for null, undefined, and non-object values', () => {
    expect(isMalformedJsonBodyError(null)).toBe(false);
    expect(isMalformedJsonBodyError(undefined)).toBe(false);
    expect(isMalformedJsonBodyError(42)).toBe(false);
  });
});
