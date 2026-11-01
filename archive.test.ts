import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { buildEventArchive, fidelitySummary } from "./archive";
import type { CapturedSession } from "./capture";

it("roundtrips every event including unknown payloads and respects UTF-8 part limits", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, type: "future/event", data: { text: "🙂Русский".repeat(15) } }));
  const captured = { threadId: "t", untilSeq: 17, rawEvents: rows, entries: [] } as unknown as CapturedSession;
  const parts = buildEventArchive(captured, 1300);
  expect(parts.length).toBeGreaterThan(1);
  const decoded = parts.flatMap(p => new TextDecoder().decode(p.bytes).trim().split("\n").map(line => JSON.parse(line)));
  expect(decoded).toEqual(rows);
  for (const part of parts) {
    expect(part.bytes.byteLength).toBeLessThanOrEqual(1300);
    expect(part.sha256).toBe(createHash("sha256").update(part.bytes).digest("hex"));
  }
});

it("refuses an oversized event rather than silently truncating archive bytes", () => {
  const captured = { threadId: "t", rawEvents: [{ seq: 1, type: "x", data: { text: "x".repeat(300) } }] } as unknown as CapturedSession;
  expect(() => buildEventArchive(captured, 100)).toThrow(/exceeds/);
});

it("gives different snapshots different filenames so later exports cannot replace earlier archives", () => {
  const base = { threadId: "t", rawEvents: [{ seq: 1, type: "x", data: {} }] } as unknown as CapturedSession;
  const later = { ...base, rawEvents: [...base.rawEvents!, { seq: 2, type: "y", data: {} }] };
  expect(buildEventArchive(base)[0].name).not.toBe(buildEventArchive(later)[0].name);
});

it("reports rendering losses without claiming that attachment bytes or model state were copied", () => {
  const captured = { entries: [{ seq: 1, kind: "user", body: "hello" }, { seq: 2, kind: "tool", body: "… [truncated 120 chars]" }], rawEvents: [], untilSeq: null } as unknown as CapturedSession;
  const report = fidelitySummary(captured);
  expect(report).toContain("1 user");
  expect(report).toContain("120");
  expect(report).toContain("Attachment references");
  expect(report).toContain("not a native resume");
});
