/**
 * Type guards for the specific error shapes body-parser (used internally
 * by express.json()) throws for request-body problems, so the global
 * error handler can surface the correct status code instead of
 * flattening every error into a generic 500.
 *
 * Verified empirically against the installed body-parser version:
 *   - oversized body   → { status: 413, type: 'entity.too.large' }   (PayloadTooLargeError)
 *   - malformed JSON   → { status: 400, type: 'entity.parse.failed' } (SyntaxError)
 */

interface BodyParserError {
  type?: string;
  status?: number;
  statusCode?: number;
}

const hasBodyParserType = (error: unknown): error is BodyParserError =>
  typeof error === 'object' && error !== null && 'type' in error;

export function isPayloadTooLargeError(error: unknown): boolean {
  return hasBodyParserType(error) && error.type === 'entity.too.large';
}

export function isMalformedJsonBodyError(error: unknown): boolean {
  return hasBodyParserType(error) && error.type === 'entity.parse.failed';
}
