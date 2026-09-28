// Documented contract for GET /api/tasks:
//   - `page` (optional, 1-indexed, default 1)
//   - `limit` (optional, default DEFAULT_PAGE_SIZE, hard-capped at MAX_PAGE_SIZE
//     regardless of what's requested — this is the bounded-maximum protection
//     against accidental or malicious unbounded responses)
// Omitting both params entirely preserves the existing client's behavior for
// any realistic task count, since the default page size is generous.
export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 200;

export type ParsedPagination = { page: number; limit: number; skip: number };
export type PaginationResult = { ok: true; value: ParsedPagination } | { ok: false; message: string };

const parsePositiveInt = (raw: unknown): number | null => {
  // Repeated query keys (e.g. ?page=2&page=999) parse as arrays — treat
  // that as malformed input rather than silently picking one value.
  if (Array.isArray(raw)) {
    return null;
  }

  const parsed = Number(raw);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
};

export function parsePagination(query: Record<string, unknown>): PaginationResult {
  let page = 1;
  if (query.page !== undefined) {
    const parsedPage = parsePositiveInt(query.page);
    if (parsedPage === null) {
      return { ok: false, message: 'page must be a positive integer' };
    }
    page = parsedPage;
  }

  let limit = DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const parsedLimit = parsePositiveInt(query.limit);
    if (parsedLimit === null) {
      return { ok: false, message: 'limit must be a positive integer' };
    }
    // Requesting more than the max isn't an error — it's just capped, the
    // same way most paginated APIs behave.
    limit = Math.min(parsedLimit, MAX_PAGE_SIZE);
  }

  return { ok: true, value: { page, limit, skip: (page - 1) * limit } };
}
