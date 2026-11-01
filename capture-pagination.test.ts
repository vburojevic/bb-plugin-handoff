import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { captureThread } from "./capture";

describe("captureThread event pagination", () => {
  it("fails a repeated page instead of looping or claiming a complete capture", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ seq: i + 1, type: "turn/started", data: {} }));
    const bb = { sdk: { threads: { get: async () => ({}), events: { list: async () => page } } } } as unknown as BbPluginApi;
    await expect(captureThread(bb, "t")).rejects.toThrow(/did not advance/);
  });
  it("cuts both the document and the archive at the selected sequence", async () => {
    const page = [
      { seq: 1, type: "item/completed", data: { item: { id: "a", type: "agentMessage", text: "before" } } },
      { seq: 2, type: "item/completed", data: { item: { id: "b", type: "agentMessage", text: "future" } } },
    ];
    const bb = { sdk: { threads: { get: async () => ({}), events: { list: async () => page },
      output: async () => { throw new Error("Must not read future thread output"); } } } } as unknown as BbPluginApi;
    const capture = await captureThread(bb, "t", { untilSeq: 1 });
    expect(capture.latestOutput).toBe("before");
    expect(capture.rawEvents).toEqual([page[0]]);
  });
  it.each([100, 251])("captures all %i events within the BB page limit", async (count) => {
    const rows = Array.from({ length: count }, (_, i) => ({
      seq: i + 1, type: "turn/started", data: {},
    }));
    const cursors: number[] = [];
    const bb = { sdk: { threads: {
      get: async () => ({ providerId: "unknown", projectId: "p" }),
      output: async () => ({ output: null }),
      events: { list: async ({ afterSeq, limit }: { afterSeq?: string; limit: string }) => {
        const size = Number(limit);
        if (size > 100) throw new Error("Thread event limit cannot exceed 100");
        const after = Number(afterSeq ?? 0);
        cursors.push(after);
        return rows.filter(row => row.seq > after).slice(0, size);
      } },
    } } } as unknown as BbPluginApi;
    const result = await captureThread(bb, "t");
    expect(result.eventCount).toBe(count);
    expect(result.turns).toBe(count);
    expect(cursors).toEqual(count === 100 ? [0, 100] : [0, 100, 200]);
  });
});
