import { describe, expect, it } from "vitest";
import {
  CAPS,
  claudeProjectSlug,
  clip,
  deriveHomeDir,
  projectEvents,
  type EventRowLike,
} from "./capture";
import { fitTranscript, renderHandoff } from "./handoff";
import type { CapturedSession } from "./capture";

function claudeStyleEvents(): EventRowLike[] {
  return [
    { seq: 1, type: "client/turn/requested", data: {} },
    { seq: 2, type: "thread/identity", data: { providerThreadId: "2eadbd16-9104" } },
    { seq: 3, type: "turn/started", data: { providerThreadId: "2eadbd16-9104" } },
    {
      seq: 4,
      type: "item/completed",
      data: {
        item: {
          type: "userMessage",
          id: "u1",
          content: [
            { type: "text", text: "Please fix the login bug" },
            { type: "localFile", path: "spec.md" },
          ],
        },
      },
    },
    {
      seq: 5,
      type: "item/started",
      data: {
        item: { type: "toolCall", id: "t1", tool: "Read", arguments: { file: "auth.ts" }, status: "pending" },
      },
    },
    {
      seq: 6,
      type: "item/completed",
      data: {
        item: {
          type: "toolCall",
          id: "t1",
          tool: "Read",
          arguments: { file: "auth.ts" },
          status: "completed",
          result: "const login = () => {}",
        },
      },
    },
    {
      seq: 7,
      type: "item/completed",
      data: {
        item: {
          type: "commandExecution",
          id: "c1",
          command: "npm test",
          cwd: "/tmp",
          status: "completed",
          exitCode: 1,
          aggregatedOutput: "1 failing",
        },
      },
    },
    {
      seq: 8,
      type: "item/completed",
      data: { item: { type: "reasoning", id: "r1", summary: ["The bug is a typo"], content: [] } },
    },
    {
      seq: 9,
      type: "item/completed",
      data: { item: { type: "agentMessage", id: "a1", text: "Fixed the typo in auth.ts." } },
    },
    { seq: 10, type: "turn/completed", data: { status: "completed" } },
    { seq: 11, type: "turn/started", data: { providerThreadId: "2eadbd16-9104" } },
    { seq: 12, type: "turn/completed", data: { status: "failed", error: { message: "rate limited" } } },
  ];
}

describe("projectEvents", () => {
  it("projects a full session into ordered transcript entries", () => {
    const { entries, providerThreadId, turns } = projectEvents(claudeStyleEvents());
    expect(providerThreadId).toBe("2eadbd16-9104");
    expect(turns).toBe(2);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "tool",
      "command",
      "reasoning",
      "assistant",
      "note",
    ]);
    const user = entries[0]!;
    expect(user.body).toContain("Please fix the login bug");
    expect(user.body).toContain("[attached file: spec.md]");
    const tool = entries[1]!;
    expect(tool.title).toBe("Read");
    expect(tool.body).toContain("const login");
    const command = entries[2]!;
    expect(command.body).toContain("$ npm test");
    expect(command.body).toContain("[exit 1]");
    expect(entries[5]!.body).toContain("rate limited");
  });

  it("merges item/started with item/completed by id, keeping first-seen order", () => {
    const rows = claudeStyleEvents();
    const { entries } = projectEvents(rows);
    const toolEntries = entries.filter((entry) => entry.kind === "tool");
    expect(toolEntries).toHaveLength(1);
    expect(toolEntries[0]!.body).toContain("result");
  });

  it("handles out-of-order rows and unknown event types", () => {
    const rows = [...claudeStyleEvents()].reverse();
    rows.push({ seq: 99, type: "provider/unhandled", data: { whatever: true } });
    const { entries } = projectEvents(rows);
    expect(entries[0]!.kind).toBe("user");
  });

  it("clips oversized bodies", () => {
    const big = "x".repeat(CAPS.commandOutput + 5_000);
    const { entries } = projectEvents([
      {
        seq: 1,
        type: "item/completed",
        data: {
          item: { type: "commandExecution", id: "c", command: "cat big", cwd: "/", status: "completed", aggregatedOutput: big },
        },
      },
    ]);
    expect(entries[0]!.body.length).toBeLessThan(CAPS.commandOutput + 200);
    expect(entries[0]!.body).toContain("truncated");
  });
});

describe("native session discovery helpers", () => {
  it("derives home directories on macOS and Linux", () => {
    expect(deriveHomeDir("/Users/dev/.bb/x/y")).toBe("/Users/dev");
    expect(deriveHomeDir("/home/ci/work")).toBe("/home/ci");
    expect(deriveHomeDir("/srv/data")).toBeNull();
    expect(deriveHomeDir(null)).toBeNull();
  });

  it("slugifies workspace paths the way Claude Code does", () => {
    expect(claudeProjectSlug("/Users/dev/.bb/personal-workspaces/env_d699ce8g2z")).toBe(
      "-Users-dev--bb-personal-workspaces-env-d699ce8g2z",
    );
  });
});

describe("renderHandoff", () => {
  const captured: CapturedSession = {
    threadId: "thr_1",
    title: "Fix login",
    providerId: "claude-code",
    projectId: "proj_1",
    environmentId: "env_1",
    hostId: "host_1",
    workspacePath: "/Users/dev/work",
    branchName: "main",
    providerThreadId: "abc",
    entries: projectEvents(claudeStyleEvents()).entries,
    turns: 2,
    eventCount: 12,
    latestOutput: "All tests green.",
    nativeSessionPath: "/Users/dev/.claude/projects/-Users-dev-work/abc.jsonl",
  };

  it("renders header, latest result, and transcript", () => {
    const doc = renderHandoff(captured, new Date("2026-08-08T12:00:00Z"));
    expect(doc).toContain("# Session handoff");
    expect(doc).toContain("Fix login");
    expect(doc).toContain("claude-code");
    expect(doc).toContain("branch `main`");
    expect(doc).toContain("abc.jsonl");
    expect(doc).toContain("All tests green.");
    expect(doc).toContain("### User");
    expect(doc).toContain("### Assistant (claude-code)");
    expect(doc).toContain("$ npm test");
  });

  it("notes a missing native session file", () => {
    const doc = renderHandoff({ ...captured, nativeSessionPath: null }, new Date());
    expect(doc).toContain("(not found)");
  });
});

describe("fitTranscript", () => {
  it("returns everything when under budget", () => {
    expect(fitTranscript(["a", "b"], 1000)).toBe("a\n\n---\n\nb");
  });

  it("keeps head and tail and reports the dropped count", () => {
    const blocks = Array.from({ length: 20 }, (_, i) => `block-${i}-${"y".repeat(50)}`);
    const result = fitTranscript(blocks, 500);
    expect(result).toContain("block-0");
    expect(result).toContain("block-1");
    expect(result).toContain("block-19");
    expect(result).toMatch(/\[\d+ earlier entries omitted/);
    expect(result.length).toBeLessThan(800);
  });
});

describe("clip", () => {
  it("passes short strings through untouched", () => {
    expect(clip("short", 100)).toBe("short");
  });
});
