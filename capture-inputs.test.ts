import { describe, expect, it } from "vitest";
import { projectEvents, type EventRowLike } from "./capture";

const request = (seq: number, id: string, text: string, initiator = "user"): EventRowLike => ({
  seq, type: "client/turn/requested", data: { requestId: id, initiator, senderThreadId: null, input: [{ type: "text", text }] },
});
const accepted = (seq: number, id: string): EventRowLike => ({
  seq, type: "turn/input/accepted", data: { clientRequestId: id, providerThreadId: "p1" },
});
const echo = (seq: number, id: string, text: string): EventRowLike => ({
  seq, type: "item/completed", data: { item: { id, type: "userMessage", content: [{ type: "text", text }] } },
});
const reply = (seq: number, id: string, text: string): EventRowLike => ({
  seq, type: "item/completed", data: { item: { id, type: "agentMessage", text } },
});
const users = (rows: EventRowLike[]) =>
  projectEvents(rows).entries.filter((e) => e.kind === "user").map((e) => e.body);

describe("accepted inputs", () => {
  it("keeps an accepted input the provider never echoed (Claude Code)", () => {
    // Shape of a real bb 0.49 Claude Code thread: no userMessage item at all.
    const entries = projectEvents([
      request(1, "creq_1", "Rename the login button to Sign in"),
      { seq: 14, type: "turn/started", data: { providerThreadId: "p1" } },
      accepted(15, "creq_1"),
      reply(20, "a1", "Done."),
    ]).entries;
    expect(entries.map((e) => [e.kind, e.body])).toEqual([
      ["user", "Rename the login button to Sign in"],
      ["assistant", "Done."],
    ]);
  });

  it("shows an accepted input once when the provider echoes it (Codex)", () => {
    expect(users([request(1, "r1", "fix the bug"), accepted(2, "r1"), echo(3, "u1", "fix the bug")]))
      .toEqual(["fix the bug"]);
  });

  it("keeps a later identical request as its own instruction", () => {
    expect(users([
      request(1, "r1", "continue"), accepted(2, "r1"), echo(3, "u1", "continue"),
      request(4, "r2", "continue"), accepted(5, "r2"), echo(6, "u2", "continue"),
    ])).toEqual(["continue", "continue"]);
  });

  it("keeps the provider's user message when no acceptance names the request", () => {
    // The acceptance never names creq_1, so the request is unconfirmed. The
    // provider's own user message proves delivery: it stays a user message,
    // and no "Unconfirmed input" note is added for it.
    const entries = projectEvents([
      request(1, "creq_1", "ship it"),
      { seq: 2, type: "turn/input/accepted", data: { providerThreadId: "p1" } },
      echo(3, "u1", "ship it"),
    ]).entries;
    expect(entries.map((e) => [e.kind, e.body])).toEqual([["user", "ship it"]]);
  });

  it("marks unconfirmed and rejected requests as notes, not user instructions", () => {
    const entries = projectEvents([
      request(1, "rejected", "wrong"),
      { seq: 2, type: "client/turn/rejected", data: { requestId: "rejected", reason: "busy", message: "busy" } },
      request(3, "pending", "not yet delivered"),
    ]).entries;
    expect(entries.filter((e) => e.kind === "user")).toHaveLength(0);
    expect(entries.map((e) => e.body.split("\n")[0])).toEqual([
      "[Rejected input: not known to have reached the source model]",
      "[Unconfirmed input: not known to have reached the source model]",
    ]);
  });

  it("labels accepted agent input as a note with its sender", () => {
    const row = request(1, "agent", "child report", "agent");
    row.data.senderThreadId = "thr_child";
    const entries = projectEvents([row, accepted(2, "agent")]).entries;
    expect(entries).toEqual([{ seq: 1, kind: "note", body: "[agent input from thr_child]\nchild report" }]);
  });

  it("does not repeat a requirement for an accepted retry chain", () => {
    const retry = request(4, "r2", "continue");
    retry.data.retryOfRequestId = "r1";
    const again = request(7, "r3", "continue");
    again.data.retryOfRequestId = "r2";
    const entries = projectEvents([
      request(1, "r1", "continue"), accepted(2, "r1"), echo(3, "u1", "continue"),
      retry, accepted(5, "r2"), echo(6, "u2", "continue"),
      again, accepted(8, "r3"), echo(9, "u3", "continue"),
    ]).entries;
    expect(entries.filter((e) => e.kind === "user").map((e) => e.body)).toEqual(["continue"]);
    expect(entries.filter((e) => e.body.startsWith("[Retry of an already accepted input"))).toHaveLength(2);
  });

  it("keeps the first accepted retry when the original was unconfirmed", () => {
    const retry = request(3, "r2", "continue");
    retry.data.retryOfRequestId = "r1";
    expect(users([request(1, "r1", "continue"), retry, accepted(4, "r2"), echo(5, "u2", "continue")]))
      .toEqual(["continue"]);
  });

  it("survives a cyclic retry chain instead of failing the capture", () => {
    const a = request(1, "a", "x");
    a.data.retryOfRequestId = "b";
    const b = request(2, "b", "x");
    b.data.retryOfRequestId = "a";
    expect(() => projectEvents([a, accepted(3, "a"), b, accepted(4, "b")])).not.toThrow();
  });

  it("keeps provider-only user messages from threads without request events", () => {
    expect(users([echo(1, "u1", "legacy")])).toEqual(["legacy"]);
  });

  it("applies the user message cap to reconstructed inputs", () => {
    const body = users([request(1, "r1", "a".repeat(25_000)), accepted(2, "r1")])[0]!;
    expect(body.startsWith("a".repeat(20_000))).toBe(true);
    expect(body).toContain("[truncated 5000 chars]");
  });
});
