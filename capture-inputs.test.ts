import { describe, expect, it } from "vitest";
import { projectEvents, type EventRowLike } from "./capture";

const request = (seq: number, id: string, text: string, initiator = "user"): EventRowLike => ({
  seq, type: "client/turn/requested", data: { requestId: id, initiator, input: [{ type: "text", text }] },
});
const accepted = (seq: number, id: string): EventRowLike => ({
  seq, type: "turn/input/accepted", data: { clientRequestId: id },
});
const echo = (seq: number, id: string, text: string): EventRowLike => ({
  seq, type: "item/completed", data: { item: { id, type: "userMessage", content: [{ type: "text", text }] } },
});

describe("BB accepted inputs", () => {
  it("groups accepted retry chains without duplicating user requirements", () => {
    const retry = request(4, "r2", "continue"); retry.data.retryOfRequestId = "r1";
    const retryAgain = request(7, "r3", "continue"); retryAgain.data.retryOfRequestId = "r2";
    const entries = projectEvents([request(1, "r1", "continue"), accepted(2, "r1"), echo(3, "u1", "continue"),
      retry, accepted(5, "r2"), echo(6, "u2", "continue"), retryAgain, accepted(8, "r3"), echo(9, "u3", "continue")]).entries;
    expect(entries.filter(e => e.kind === "user").map(e => e.body)).toEqual(["continue"]);
    expect(entries.filter(e => e.body.startsWith("[Retry"))).toHaveLength(2);
  });
  it("keeps the first accepted retry when the original request was unconfirmed", () => {
    const retry = request(3, "r2", "continue"); retry.data.retryOfRequestId = "r1";
    const entries = projectEvents([request(1, "r1", "continue"), retry, accepted(4, "r2"), echo(5, "u2", "continue")]).entries;
    expect(entries.filter(e => e.kind === "user").map(e => e.body)).toEqual(["continue"]);
  });
  it("restores Claude user requests and retains long requirements verbatim", () => {
    const text = "Русский текст🙂".repeat(2500);
    expect(projectEvents([request(1, "r1", text), accepted(2, "r1")]).entries)
      .toMatchObject([{ kind: "user", body: text, seq: 1 }]);
  });
  it("deduplicates an echo without deleting a later identical user request", () => {
    const entries = projectEvents([
      request(1, "r1", "continue"), accepted(2, "r1"), echo(3, "u1", "continue"),
      request(4, "r2", "continue"), accepted(5, "r2"), echo(6, "u2", "continue"),
    ]).entries;
    expect(entries.filter(e => e.kind === "user").map(e => e.body)).toEqual(["continue", "continue"]);
  });
  it("does not promote rejected, pending, or agent requests into user instructions", () => {
    const entries = projectEvents([
      request(1, "rejected", "wrong"), { seq: 2, type: "client/turn/rejected", data: { requestId: "rejected" } },
      request(3, "pending", "not yet delivered"),
      request(4, "agent", "agent report", "agent"), accepted(5, "agent"),
    ]).entries;
    expect(entries.filter(e => e.kind === "user")).toHaveLength(0);
    expect(entries.some(e => e.body.includes("agent report") && e.kind === "note")).toBe(true);
  });
  it("keeps legacy provider-only user messages", () => {
    expect(projectEvents([echo(1, "u1", "legacy")]).entries[0]).toMatchObject({ kind: "user", body: "legacy" });
  });
  it("retains file reads and the final delegation result", () => {
    const entries = projectEvents([
      { seq: 1, type: "item/completed", data: { item: { id: "f", type: "fileRead", path: "/repo/rules.md", content: "important rule" } } },
      { seq: 2, type: "item/started", data: { item: { id: "d", type: "delegation", status: "pending" } } },
      { seq: 3, type: "item/delegation/completed", data: { item: { id: "d", type: "delegation", status: "failed", summary: "failed to start" } } },
    ]).entries;
    expect(entries).toHaveLength(2);
    expect(entries[0].body).toContain("important rule");
    expect(entries[1].body).toContain("failed to start");
    expect(entries[1].body).not.toContain('"pending"');
  });
});
