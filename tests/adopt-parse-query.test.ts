import { describe, expect, it } from "vitest";
import { parseAdoptQuery } from "../adopt/adopt-core";

const UUID = "9ace2fd5-d8ae-4946-a0a0-9ff58a6795df";

describe("parseAdoptQuery", () => {
  it("extracts a bare uuid", () => {
    expect(parseAdoptQuery(UUID)).toEqual({ sessionId: UUID, agentHint: null, newest: false });
  });

  it("extracts a hex id prefix", () => {
    expect(parseAdoptQuery("9ace2fd5")).toMatchObject({ sessionId: "9ace2fd5", newest: false });
  });

  it("parses claude resume commands in all spellings", () => {
    for (const command of [
      `claude --resume ${UUID}`,
      `claude --resume=${UUID}`,
      `claude -r ${UUID}`,
    ]) {
      expect(parseAdoptQuery(command)).toEqual({
        sessionId: UUID,
        agentHint: "claude",
        newest: false,
      });
    }
  });

  it("parses codex resume commands", () => {
    expect(parseAdoptQuery("codex resume 019fd95c-907f-7eb1-8dfc-2aad427ffc09")).toEqual({
      sessionId: "019fd95c-907f-7eb1-8dfc-2aad427ffc09",
      agentHint: "codex",
      newest: false,
    });
  });

  it("treats continue/last flags as newest-session requests", () => {
    expect(parseAdoptQuery("claude --continue")).toEqual({
      sessionId: null,
      agentHint: "claude",
      newest: true,
    });
    expect(parseAdoptQuery("claude -c")).toMatchObject({ newest: true });
  });

  it("strips surrounding quotes from pasted commands", () => {
    expect(parseAdoptQuery(`"claude --resume ${UUID}"`)).toMatchObject({ sessionId: UUID });
  });

  it("hints gemini and gemini-cli", () => {
    expect(parseAdoptQuery(`gemini --resume ${UUID}`)).toMatchObject({ agentHint: "gemini" });
  });

  it("recognizes opencode ses_ ids, bare and in commands", () => {
    expect(parseAdoptQuery("ses_01a059472ffefF56y48oAPfer2")).toEqual({
      sessionId: "ses_01a059472ffefF56y48oAPfer2",
      agentHint: "opencode",
      newest: false,
    });
    expect(parseAdoptQuery("opencode --session ses_abc1234")).toMatchObject({
      sessionId: "ses_abc1234",
      agentHint: "opencode",
    });
  });

  it("returns no id for prose and short tokens", () => {
    expect(parseAdoptQuery("hello world")).toEqual({
      sessionId: null,
      agentHint: null,
      newest: false,
    });
    expect(parseAdoptQuery("abc")).toMatchObject({ sessionId: null });
    expect(parseAdoptQuery("")).toMatchObject({ sessionId: null, newest: false });
  });
});
