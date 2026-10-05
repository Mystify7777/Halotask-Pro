import { describe, expect, it } from 'vitest';
import { JWT_ALGORITHM, parseTokenPayload } from '../src/utils/authToken';

// The runtime shape check that replaces the `as TokenPayload` cast (Issue #21). Pure function, no JWT or
// database involved. That a malformed payload is refused BEFORE any database read is asserted against the
// real middleware in authBoundary.test.ts.

const valid = { userId: '665f1c2e9b1e8a00000000aa', email: 'a@x.test', name: 'A' };

describe('parseTokenPayload', () => {
  it('pins HS256', () => {
    expect(JWT_ALGORITHM).toBe('HS256');
  });

  it('accepts a payload with no tv as generation 0 (tokens issued before Issue #27)', () => {
    expect(parseTokenPayload(valid)).toEqual({ ...valid, tokenVersion: 0 });
  });

  it.each([0, 1, 7, 1_000_000])('accepts tv = %d', (tv) => {
    expect(parseTokenPayload({ ...valid, tv })).toEqual({ ...valid, tokenVersion: tv });
  });

  it('ignores claims it does not use (iat, exp, anything else)', () => {
    expect(parseTokenPayload({ ...valid, tv: 2, iat: 1, exp: 2, role: 'admin' })).toEqual({ ...valid, tokenVersion: 2 });
  });

  it('accepts empty email and name strings (the type is the contract, not the content)', () => {
    expect(parseTokenPayload({ userId: 'u', email: '', name: '' })).toEqual({ userId: 'u', email: '', name: '', tokenVersion: 0 });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string payload', 'just-a-string'],
    ['a number payload', 42],
    ['an array', [valid]],
    ['an empty object', {}],
  ])('rejects a payload that is not an object with claims (%s)', (_label, payload) => {
    expect(parseTokenPayload(payload)).toBeNull();
  });

  it.each([
    ['userId missing', { email: 'a@x.test', name: 'A' }],
    ['userId empty', { ...valid, userId: '' }],
    ['userId number', { ...valid, userId: 5 }],
    ['userId object', { ...valid, userId: { $ne: null } }],
    ['userId array', { ...valid, userId: ['u'] }],
    ['userId null', { ...valid, userId: null }],
    ['email missing', { userId: 'u', name: 'A' }],
    ['email number', { ...valid, email: 5 }],
    ['email null', { ...valid, email: null }],
    ['name missing', { userId: 'u', email: 'a@x.test' }],
    ['name object', { ...valid, name: {} }],
    ['name null', { ...valid, name: null }],
  ])('rejects a wrongly shaped identity claim (%s)', (_label, payload) => {
    expect(parseTokenPayload(payload)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', '1'],
    ['a numeric string', '0'],
    ['a fraction', 1.5],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['true', true],
    ['an object', {}],
    ['an array', [0]],
  ])('rejects a malformed tv claim (%s)', (_label, tv) => {
    expect(parseTokenPayload({ ...valid, tv })).toBeNull();
  });
});
