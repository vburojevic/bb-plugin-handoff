import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeAdapter } from "../adopt/agents/claude";
import { codexAdapter } from "../adopt/agents/codex";
import { geminiAdapter } from "../adopt/agents/gemini";

const CWD = "/Users/someone/Git/example-repo";
const dirs: string[] = [];

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-agents-"));
  dirs.push(home);
  return home;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Claude Code

const CLAUDE_ID = "9ace2fd5-d8ae-4946-a0a0-9ff58a6795df";

function writeClaudeSession(home: string, lines: unknown[]): string {
  const slug = CWD.replace(/[^a-zA-Z0-9]/g, "-");
  const dir = path.join(home, ".claude", "projects", slug);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${CLAUDE_ID}.jsonl`);
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n"));
  return filePath;
}

const claudeRows = [
  { type: "ai-title", aiTitle: "Fix the flaky test" },
  {
    type: "user",
    sessionId: CLAUDE_ID,
    cwd: CWD,
    gitBranch: "main",
    timestamp: "2026-08-01T10:00:00Z",
    message: { content: "please fix the flaky test" },
  },
  { type: "user", isMeta: true, message: { content: "<system-injected>" } },
  {
    type: "assistant",
    timestamp: "2026-08-01T10:01:00Z",
    message: {
      content: [
        { type: "text", text: "On it." },
        { type: "tool_use", name: "Read", input: { file: "test.ts" } },
        { type: "thinking", thinking: "hidden reasoning" },
      ],
    },
  },
];

describe("claude adapter", () => {
  it("lists sessions for a cwd with the ai title", async () => {
    const home = makeHome();
    writeClaudeSession(home, claudeRows);
    const sessions = await claudeAdapter.list(CWD, home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "claude",
      sessionId: CLAUDE_ID,
      title: "Fix the flaky test",
    });
  });

  it("finds sessions globally by id prefix and recovers the cwd", async () => {
    const home = makeHome();
    writeClaudeSession(home, claudeRows);
    const found = await claudeAdapter.find("9ace2fd5", { home });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sessionId: CLAUDE_ID, cwd: CWD });
    expect(await claudeAdapter.find("ffffffff", { home })).toHaveLength(0);
  });

  it("parses the transcript, skipping meta rows and thinking blocks", async () => {
    const home = makeHome();
    const filePath = writeClaudeSession(home, claudeRows);
    const session = await claudeAdapter.parse(filePath);
    expect(session).toMatchObject({
      agent: "claude",
      sessionId: CLAUDE_ID,
      cwd: CWD,
      gitBranch: "main",
      title: "Fix the flaky test",
      userMessageCount: 1,
      assistantMessageCount: 1,
      truncated: false,
    });
    expect(session.transcript).toContain("please fix the flaky test");
    expect(session.transcript).toContain('Read({"file":"test.ts"})');
    expect(session.transcript).not.toContain("system-injected");
    expect(session.transcript).not.toContain("hidden reasoning");
  });
});

// ---------------------------------------------------------------------------
// Codex

const CODEX_ID = "019fd95c-907f-7eb1-8dfc-2aad427ffc09";

function writeCodexSession(home: string): string {
  const dir = path.join(home, ".codex", "sessions", "2026", "08", "01");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `rollout-2026-08-01T10-00-00-${CODEX_ID}.jsonl`);
  const rows = [
    {
      type: "session_meta",
      timestamp: "2026-08-01T10:00:00Z",
      payload: { id: CODEX_ID, cwd: CWD, git: { branch: "main" } },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<user_instructions>injected</user_instructions>" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "refactor the parser" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Refactoring now." }],
      },
    },
    {
      type: "response_item",
      payload: { type: "local_shell_call", action: { command: ["ls", "-la"] } },
    },
  ];
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
  return filePath;
}

describe("codex adapter", () => {
  it("lists sessions by matching the session_meta cwd", async () => {
    const home = makeHome();
    writeCodexSession(home);
    const sessions = await codexAdapter.list(CWD, home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "codex",
      sessionId: CODEX_ID,
      title: "refactor the parser", // injected <user_instructions> skipped
    });
    expect(await codexAdapter.list("/elsewhere", home)).toHaveLength(0);
  });

  it("finds sessions by filename id prefix with the recorded cwd", async () => {
    const home = makeHome();
    writeCodexSession(home);
    const found = await codexAdapter.find("019fd95c", { home });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sessionId: CODEX_ID, cwd: CWD });
  });

  it("parses messages and shell calls, skipping injected context", async () => {
    const home = makeHome();
    const filePath = writeCodexSession(home);
    const session = await codexAdapter.parse(filePath);
    expect(session).toMatchObject({
      agent: "codex",
      sessionId: CODEX_ID,
      cwd: CWD,
      gitBranch: "main",
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(session.transcript).toContain("refactor the parser");
    expect(session.transcript).toContain("shell(ls -la)");
    expect(session.transcript).not.toContain("user_instructions");
  });
});

// ---------------------------------------------------------------------------
// Gemini CLI

const GEMINI_ID = "5c1f2f7a-1111-2222-3333-444455556666";

function writeGeminiSession(home: string): string {
  const hash = createHash("sha256").update(CWD).digest("hex");
  const dir = path.join(home, ".gemini", "tmp", hash, "chats");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "session-1.json");
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      sessionId: GEMINI_ID,
      startTime: "2026-08-01T10:00:00Z",
      lastUpdated: "2026-08-01T10:05:00Z",
      messages: [
        { type: "user", content: "summarize the repo" },
        {
          type: "gemini",
          content: "Here is a summary.",
          toolCalls: [{ name: "read_file", args: { path: "README.md" } }],
        },
      ],
    }),
  );
  return filePath;
}

describe("gemini adapter", () => {
  it("lists sessions for a cwd via its hash directory", async () => {
    const home = makeHome();
    writeGeminiSession(home);
    const sessions = await geminiAdapter.list(CWD, home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "gemini",
      sessionId: GEMINI_ID,
      title: "summarize the repo",
    });
  });

  it("finds sessions by id and reverses the cwd hash from candidates", async () => {
    const home = makeHome();
    writeGeminiSession(home);
    const found = await geminiAdapter.find("5c1f2f7a", { home, cwdCandidates: [CWD, "/other"] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ sessionId: GEMINI_ID, cwd: CWD });
    const withoutCandidates = await geminiAdapter.find("5c1f2f7a", { home });
    expect(withoutCandidates[0]!.cwd).toBeNull();
  });

  it("parses messages and tool calls", async () => {
    const home = makeHome();
    const filePath = writeGeminiSession(home);
    const session = await geminiAdapter.parse(filePath);
    expect(session).toMatchObject({
      agent: "gemini",
      sessionId: GEMINI_ID,
      firstTimestamp: "2026-08-01T10:00:00Z",
      lastTimestamp: "2026-08-01T10:05:00Z",
      userMessageCount: 1,
      assistantMessageCount: 1,
    });
    expect(session.transcript).toContain("summarize the repo");
    expect(session.transcript).toContain('read_file({"path":"README.md"})');
  });
});
