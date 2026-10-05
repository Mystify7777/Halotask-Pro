// Runtime checks for the request body (Issue #21). Express 5 leaves `req.body` undefined when no JSON body
// was sent, and a JSON body can hold any type in any field, so a TypeScript cast (`req.body as {...}`) says
// nothing about what is actually there. These helpers make the check real. They are deliberately tiny
// functions, not a schema framework: three validators used to carry private copies of `isPlainObject`, and
// four auth handlers plus task create/update and tree patch had no check at all.

export const BODY_MUST_BE_OBJECT = 'Request body must be a JSON object.';

/** A JSON object: not null, not an array, not a primitive. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type StringFieldsResult<K extends string> =
  | { ok: true; value: Record<K, string> }
  | { ok: false; message: string };

/**
 * Reads required string fields from a request body.
 *   - body is not a JSON object            -> `Request body must be a JSON object.`
 *   - any field missing, null or empty     -> `messages.required`   (the pre-existing message, unchanged)
 *   - any field present but not a string   -> `messages.notStrings` (previously a 500 from `.trim()`/crypto)
 * Values are returned untouched: trimming and normalising stay with the caller's existing rules.
 */
export function readRequiredStrings<K extends string>(
  body: unknown,
  keys: readonly K[],
  messages: { required: string; notStrings: string },
): StringFieldsResult<K> {
  if (!isPlainObject(body)) {
    return { ok: false, message: BODY_MUST_BE_OBJECT };
  }

  if (keys.some((key) => !body[key])) {
    return { ok: false, message: messages.required };
  }

  const value = {} as Record<K, string>;
  for (const key of keys) {
    const field = body[key];
    if (typeof field !== 'string') {
      return { ok: false, message: messages.notStrings };
    }
    value[key] = field;
  }

  return { ok: true, value };
}
