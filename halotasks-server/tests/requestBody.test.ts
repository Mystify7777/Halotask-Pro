import { describe, expect, it } from 'vitest';
import { BODY_MUST_BE_OBJECT, isPlainObject, readRequiredStrings } from '../src/utils/requestBody';

// The shared request-body helpers (Issue #21), in isolation. Route-level behaviour is covered by
// authInput.test.ts and bodyBoundaries.test.ts.

describe('isPlainObject', () => {
  it.each([[{}], [{ a: 1 }], [Object.create(null)]])('accepts a JSON object (%j)', (value) => {
    expect(isPlainObject(value)).toBe(true);
  });

  it.each([[undefined], [null], [[]], [[{}]], ['text'], [''], [0], [1], [true], [() => ({})]])(
    'rejects %j',
    (value) => {
      expect(isPlainObject(value)).toBe(false);
    },
  );
});

describe('readRequiredStrings', () => {
  const messages = { required: 'a and b are required', notStrings: 'a and b must be strings' };

  it('returns the fields untouched (no trimming or normalising here)', () => {
    expect(readRequiredStrings({ a: ' x ', b: 'y', extra: 1 }, ['a', 'b'], messages)).toEqual({
      ok: true,
      value: { a: ' x ', b: 'y' },
    });
  });

  it.each([[undefined], [null], [[]], ['text'], [5]])('a non-object body (%j) is "Request body must be a JSON object."', (body) => {
    expect(readRequiredStrings(body, ['a', 'b'], messages)).toEqual({ ok: false, message: BODY_MUST_BE_OBJECT });
    expect(BODY_MUST_BE_OBJECT).toBe('Request body must be a JSON object.');
  });

  it.each([
    ['a missing', { b: 'y' }],
    ['b missing', { a: 'x' }],
    ['empty string', { a: 'x', b: '' }],
    ['null', { a: null, b: 'y' }],
    ['false', { a: 'x', b: false }],
    ['zero', { a: 0, b: 'y' }],
  ])('a missing or empty field (%s) keeps the existing "required" message', (_label, body) => {
    expect(readRequiredStrings(body, ['a', 'b'], messages)).toEqual({ ok: false, message: messages.required });
  });

  it.each([
    ['number', { a: 5, b: 'y' }],
    ['true', { a: 'x', b: true }],
    ['object', { a: { $ne: null }, b: 'y' }],
    ['array', { a: ['x'], b: 'y' }],
  ])('a present non-string (%s) is a 400-class failure, not a crash', (_label, body) => {
    expect(readRequiredStrings(body, ['a', 'b'], messages)).toEqual({ ok: false, message: messages.notStrings });
  });

  it('checks "required" before types, so {a: 5} with b missing reports the missing field', () => {
    expect(readRequiredStrings({ a: 5 }, ['a', 'b'], messages)).toEqual({ ok: false, message: messages.required });
  });
});
