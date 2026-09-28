import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePagination } from '../src/utils/pagination';

describe('parsePagination', () => {
  it('defaults to page 1 and the default page size when no params are given', () => {
    const result = parsePagination({});
    expect(result).toEqual({ ok: true, value: { page: 1, limit: DEFAULT_PAGE_SIZE, skip: 0 } });
  });

  it('accepts explicit valid page and limit', () => {
    const result = parsePagination({ page: '3', limit: '10' });
    expect(result).toEqual({ ok: true, value: { page: 3, limit: 10, skip: 20 } });
  });

  it(`caps limit at ${MAX_PAGE_SIZE} rather than rejecting an oversized request`, () => {
    const result = parsePagination({ limit: String(MAX_PAGE_SIZE + 500) });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.limit).toBe(MAX_PAGE_SIZE);
    }
  });

  it('rejects a non-numeric page', () => {
    const result = parsePagination({ page: 'abc' });
    expect(result).toEqual({ ok: false, message: 'page must be a positive integer' });
  });

  it('rejects a zero or negative page', () => {
    expect(parsePagination({ page: '0' }).ok).toBe(false);
    expect(parsePagination({ page: '-1' }).ok).toBe(false);
  });

  it('rejects a fractional page', () => {
    expect(parsePagination({ page: '1.5' }).ok).toBe(false);
  });

  it('rejects a page number beyond Number.isSafeInteger range', () => {
    expect(parsePagination({ page: '99999999999999999999' }).ok).toBe(false);
    expect(parsePagination({ page: String(Number.MAX_SAFE_INTEGER + 1) }).ok).toBe(false);
  });

  it('accepts a page number at exactly Number.MAX_SAFE_INTEGER', () => {
    const result = parsePagination({ page: String(Number.MAX_SAFE_INTEGER) });
    expect(result.ok).toBe(true);
  });

  it('rejects a repeated page query param instead of silently taking the first value', () => {
    const result = parsePagination({ page: ['2', '999'] });
    expect(result).toEqual({ ok: false, message: 'page must be a positive integer' });
  });

  it('rejects a repeated limit query param instead of silently taking the first value', () => {
    const result = parsePagination({ limit: ['10', '9999'] });
    expect(result).toEqual({ ok: false, message: 'limit must be a positive integer' });
  });

  it('rejects a non-numeric limit', () => {
    const result = parsePagination({ limit: 'lots' });
    expect(result).toEqual({ ok: false, message: 'limit must be a positive integer' });
  });

  it('rejects a zero or negative limit', () => {
    expect(parsePagination({ limit: '0' }).ok).toBe(false);
    expect(parsePagination({ limit: '-5' }).ok).toBe(false);
  });
});
