/**
 * bb validates every `rpc.call` input before it serializes it, and it walks the
 * object with `Object.entries` — which yields keys that are *present but
 * undefined*. `undefined` is not a JSON value, so `{ threadId, upToSeq }` with
 * an unset `upToSeq` is rejected client-side with
 * "rpc input at $input.upToSeq is not a JSON value" and the request never
 * leaves the panel.
 *
 * TypeScript cannot catch this: a zod `.optional()` field infers as
 * `upToSeq?: number | undefined`, which an explicit `undefined` satisfies. So
 * route optional fields through this helper (or omit the key entirely) rather
 * than trusting the type checker.
 */
export function omitUndefined<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}
