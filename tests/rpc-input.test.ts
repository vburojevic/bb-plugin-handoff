import { describe, expect, it } from "vitest";
import { omitUndefined } from "../lib/rpc-input";

/**
 * Faithful copy of bb's client-side `serializePluginRpcInput`
 * (apps/app/src/lib/plugin-sdk-hooks.ts). Every `rpc.call` input goes through
 * this before it hits the wire, so a shape it rejects can never reach the
 * server — the panel just renders the thrown message.
 */
function serializePluginRpcInput(value: unknown): string {
  const ancestors = new Set<object>();
  function assertJson(current: unknown, path: string): void {
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`rpc input at ${path} contains a non-finite number`);
      }
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`rpc input at ${path} is not a JSON value`);
    }
    if (ancestors.has(current)) throw new Error(`rpc input at ${path} is cyclic`);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        current.forEach((item, index) => assertJson(item, `${path}[${index}]`));
        return;
      }
      const prototype = Object.getPrototypeOf(current) as object | null;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(`rpc input at ${path} must be a plain JSON object`);
      }
      for (const key of Reflect.ownKeys(current)) {
        if (typeof key === "symbol") throw new Error(`rpc input at ${path} contains a symbol key`);
      }
      for (const [key, child] of Object.entries(current)) assertJson(child, `${path}.${key}`);
    } finally {
      ancestors.delete(current);
    }
  }
  assertJson(value, "$input");
  return JSON.stringify(value);
}

describe("bb rpc input validation", () => {
  it("rejects a present-but-undefined optional field", () => {
    // The regression: the Hand off panel opened with no message scope built
    // `{ threadId, upToSeq: undefined }`, which fails before the request is
    // sent and surfaces as "Couldn't read this session".
    const threadId = "thr_abc";
    const upToSeq: number | undefined = undefined;
    expect(() => serializePluginRpcInput({ threadId, upToSeq })).toThrow(
      "rpc input at $input.upToSeq is not a JSON value",
    );
  });
});

describe("omitUndefined", () => {
  it("drops unset optional fields so an unscoped call serializes", () => {
    const threadId = "thr_abc";
    const upToSeq: number | undefined = undefined;
    const input = omitUndefined({ threadId, upToSeq });

    expect(Object.hasOwn(input, "upToSeq")).toBe(false);
    expect(serializePluginRpcInput(input)).toBe('{"threadId":"thr_abc"}');
  });

  it("preserves a real scope cutoff", () => {
    const input = omitUndefined({ threadId: "thr_abc", upToSeq: 42 });

    expect(input).toEqual({ threadId: "thr_abc", upToSeq: 42 });
    expect(serializePluginRpcInput(input)).toBe('{"threadId":"thr_abc","upToSeq":42}');
  });

  it("keeps null, which is a valid JSON value", () => {
    // The adopt calls lean on this: they pass explicit nulls, not undefined.
    const input = omitUndefined({ query: null, agent: "codex", sessionId: undefined });

    expect(input).toEqual({ query: null, agent: "codex" });
    expect(serializePluginRpcInput(input)).toBe('{"query":null,"agent":"codex"}');
  });

  it("keeps falsy values that are not undefined", () => {
    const input = omitUndefined({ force: false, count: 0, name: "" });

    expect(input).toEqual({ force: false, count: 0, name: "" });
  });
});
