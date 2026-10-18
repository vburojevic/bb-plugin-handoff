import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectSessions, performAdoptQuery } from "../adopt/adopt-core";
import { getAdapter, resolveAgentId } from "../adopt/agents";
import { parsePiContent, piAdapter, piSessionSlug, piSessionsRoot } from "../adopt/agents/pi";

const ID = "11111111-2222-4333-8444-555555555555";
const CWD = "/Users/dev/Git/example";
const FILE = `2026-10-01T10-00-00-000Z_${ID}.jsonl`;
const TIMESTAMP = "2026-10-01T10:00:00.000Z";
const header = { type: "session", version: 3, id: ID, cwd: CWD, timestamp: TIMESTAMP };
const encode = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message", id, parentId, timestamp: TIMESTAMP, message: { role, content },
});
const rows = [
  header,
  message("system", null, "system", "private system prompt"),
  message("user", "system", "user", [
    { type: "text", text: "Fix the parser" },
    { type: "image", data: "private-image-bytes", mimeType: "image/png" },
  ]),
  message("assistant", "user", "assistant", [
    { type: "thinking", thinking: "private reasoning", thinkingSignature: "private signature" },
    { type: "text", text: "I will inspect it." },
    { type: "toolCall", name: "read", arguments: { path: "parser.ts" } },
  ]),
  message("tool", "assistant", "toolResult", [{ type: "text", text: "private tool output" }]),
  { type: "custom", id: "state", parentId: "tool", customType: "extension", data: "private extension state" },
  { type: "session_info", id: "name", parentId: "state", name: "Parser repair" },
];
const dirs: string[] = [];

beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-pi-"));
  dirs.push(dir);
  return dir;
}
function writeSession(root: string, content: unknown[] = rows, file = FILE): string {
  fs.mkdirSync(root, { recursive: true });
  const filePath = path.join(root, file);
  fs.writeFileSync(filePath, encode(content));
  return filePath;
}

describe("Pi discovery", () => {
  it("registers the Pi adapter and preferred provider", () => {
    expect(resolveAgentId("Pi")).toBe("pi");
    expect(getAdapter("pi")).toBe(piAdapter);
    expect(piAdapter.bbProviderId).toBe("pi");
  });

  it("matches Pi's POSIX and Windows directory encoding", () => {
    expect(piSessionSlug(CWD)).toBe("--Users-dev-Git-example--");
    expect(piSessionSlug("C:\\Users\\dev\\repo")).toBe("--C--Users-dev-repo--");
    expect(piSessionSlug("/")).toBe("----");
  });

  it("lists timestamp-prefixed sessions with header identity, cwd and name", async () => {
    const home = makeHome();
    const root = path.join(home, ".pi/agent/sessions", piSessionSlug(CWD));
    const filePath = writeSession(root);
    writeSession(root, [{ ...header, cwd: "/other" }], "wrong-cwd.jsonl");
    fs.writeFileSync(path.join(root, "empty.jsonl"), "");
    fs.writeFileSync(path.join(root, "broken.jsonl"), "not json");
    const sessions = await piAdapter.list(CWD, home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ agent: "pi", sessionId: ID, title: "Parser repair", filePath });
    expect(await piAdapter.list("/elsewhere", home)).toEqual([]);
  });

  it("finds exact ids and prefixes across cwd directories, newest first", async () => {
    const home = makeHome();
    const root = path.join(home, ".pi/agent/sessions");
    const older = writeSession(path.join(root, "--one--"));
    writeSession(path.join(root, "--two--"), [{ ...header, id: "11111111-other", cwd: "/other" }]);
    fs.utimesSync(older, 1, 1);
    const found = await piAdapter.find("11111111", { home });
    expect(found.map((s) => s.sessionId)).toEqual(["11111111-other", ID]);
    expect((await piAdapter.find(ID.toUpperCase(), { home }))[0]).toMatchObject({ sessionId: ID, cwd: CWD });
    expect(await piAdapter.find("ffffffff", { home })).toEqual([]);
  });

  it("respects PI_CODING_AGENT_DIR and flat PI_CODING_AGENT_SESSION_DIR stores", async () => {
    const home = makeHome();
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(home, "profile"));
    writeSession(path.join(home, "profile/sessions", piSessionSlug(CWD)));
    expect(await piAdapter.list(CWD, home)).toHaveLength(1);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", path.join(home, "flat"));
    writeSession(path.join(home, "flat"));
    writeSession(path.join(home, "flat"), [{ ...header, cwd: "/other" }], "other.jsonl");
    expect(await piAdapter.list(CWD, home)).toHaveLength(1);
    expect(await piAdapter.find(ID, { home })).toHaveLength(2);
    expect(piSessionsRoot(home, { PI_CODING_AGENT_DIR: "~/profile" })).toBe(path.join(home, "profile/sessions"));
    expect(piSessionsRoot(home, {})).toBe(path.join(home, ".pi/agent/sessions"));
  });

  it("reads late session names without loading the whole file during discovery", async () => {
    const home = makeHome();
    writeSession(path.join(home, ".pi/agent/sessions", piSessionSlug(CWD)), [
      ...rows.slice(0, -1),
      { type: "custom", id: "large", parentId: "state", data: "x".repeat(200_000) },
      { type: "session_info", id: "name", parentId: "large", name: "Late name" },
    ]);
    expect((await piAdapter.list(CWD, home))[0]?.title).toBe("Late name");
  });

  it("treats missing stores as empty and never writes into them", async () => {
    const home = makeHome();
    expect(await piAdapter.list(CWD, home)).toEqual([]);
    expect(await piAdapter.find(ID, { home })).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe("Pi transcript", () => {
  it("parses messages and tool calls without importing reasoning, prompts or binary data", () => {
    const session = parsePiContent(encode(rows), FILE);
    expect(session).toMatchObject({
      agent: "pi", agentLabel: "Pi", sessionId: ID, cwd: CWD, title: "Parser repair",
      gitBranch: null, firstTimestamp: TIMESTAMP, lastTimestamp: TIMESTAMP,
      userMessageCount: 1, assistantMessageCount: 1, truncated: false,
    });
    expect(session.transcript).toContain("Fix the parser");
    expect(session.transcript).toContain("I will inspect it.");
    expect(session.transcript).toContain('read({"path":"parser.ts"})');
    expect(session.transcript).not.toContain("private");
  });

  it("walks only the last persisted branch, not abandoned alternatives", () => {
    const session = parsePiContent(encode([
      header,
      message("u", null, "user", "Original request"),
      message("abandoned", "u", "assistant", "Discard this approach"),
      message("abandoned-user", "abandoned", "user", "Old alternative"),
      { type: "branch_summary", id: "summary", parentId: "u", fromId: "abandoned-user", summary: "Tried a different approach" },
      message("active", "summary", "assistant", [{ type: "text", text: "Use this approach" }]),
    ]), FILE);
    expect(session.transcript).toContain("Original request");
    expect(session.transcript).toContain("Tried a different approach");
    expect(session.transcript).toContain("Use this approach");
    expect(session.transcript).not.toContain("Discard this");
    expect(session.transcript).not.toContain("Old alternative");
    expect(session.userMessageCount).toBe(1);
  });

  it("supports a reset to a new root and ignores summaries on abandoned branches", () => {
    const session = parsePiContent(encode([
      ...rows,
      { type: "compaction", id: "old-summary", parentId: "name", summary: "Abandoned summary" },
      message("fresh", null, "user", "New root"),
    ]), FILE);
    expect(session.transcript).toContain("New root");
    expect(session.transcript).not.toContain("Fix the parser");
    expect(session.transcript).not.toContain("Abandoned summary");
  });

  it("retains compaction summaries and recent messages", () => {
    const session = parsePiContent(encode([
      ...rows,
      { type: "compaction", id: "compact", parentId: "name", summary: "Parser changes are complete", firstKeptEntryId: "user" },
      message("next", "compact", "user", "Run the tests next"),
    ]), FILE);
    expect(session.transcript).toContain("Earlier session summary");
    expect(session.transcript).toContain("Parser changes are complete");
    expect(session.transcript).toContain("Run the tests next");
  });

  it("honors context edits on the selected branch", () => {
    const session = parsePiContent(encode([
      header,
      message("u", null, "user", "Original text"),
      message("a", "u", "assistant", [{ type: "text", text: "Remove this" }]),
      { type: "context_edit", id: "edit1", parentId: "a", targetId: "u", replacement: "Replacement text" },
      { type: "context_edit", id: "edit2", parentId: "edit1", targetId: "a", replacement: null },
    ]), FILE);
    expect(session.transcript).toContain("Replacement text");
    expect(session.transcript).not.toContain("Original text");
    expect(session.transcript).not.toContain("Remove this");
  });

  it("accepts legacy linear sessions and skips partial final lines", () => {
    const session = parsePiContent(encode([
      { ...header, version: 1 },
      { type: "message", message: { role: "user", content: "Legacy request" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Legacy reply" }] } },
    ]) + '\n{"type":"message",', FILE);
    expect(session.transcript).toContain("Legacy request");
    expect(session.transcript).toContain("Legacy reply");
  });

  it("rejects invalid headers, unknown versions and broken trees rather than mixing branches", () => {
    expect(() => parsePiContent("{}", FILE)).toThrow("Invalid Pi session header");
    expect(() => parsePiContent(encode([{ ...header, version: 99 }]), FILE)).toThrow("Unsupported Pi session version");
    expect(() => parsePiContent(encode([header, message("a", "missing", "user", "x")]), FILE)).toThrow("Missing parent");
    expect(() => parsePiContent(encode([header, message("a", "b", "user", "x"), message("b", "a", "user", "y")]), FILE)).toThrow("Cycle");
    expect(() => parsePiContent(encode([header, message("a", null, "user", "x"), message("a", null, "user", "y")]), FILE)).toThrow("Duplicate");
  });

  it("uses the shared transcript budget", () => {
    const session = parsePiContent(encode([
      header,
      message("u", null, "user", "First request"),
      message("a", "u", "assistant", [{ type: "text", text: "x".repeat(10_000) }]),
      message("last", "a", "user", "Latest request"),
    ]), FILE, { maxChars: 1000 });
    expect(session.truncated).toBe(true);
    expect(session.transcript).toContain("Latest request");
    expect(session.transcript).toContain("omitted");
  });
});

describe("Pi adoption engine", () => {
  it("locates an id and spawns a Pi thread using a read-only copy of the conversation", async () => {
    const home = makeHome();
    const cwd = path.join(home, "repo");
    fs.mkdirSync(cwd);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    const filePath = writeSession(path.join(home, ".pi/agent/sessions", piSessionSlug(cwd)), [
      { ...header, cwd }, ...rows.slice(1),
    ]);
    const original = fs.readFileSync(filePath, "utf8");
    const spawn = vi.fn(async () => ({ id: "thr_pi" }));
    const set = vi.fn();
    const bb = {
      sdk: {
        projects: { list: async () => [{ id: "proj_pi", name: "Example", sources: [{ hostId: "host_local", path: cwd }] }] },
        system: { config: async () => ({ primaryHostId: "host_local" }) },
        providers: { list: async () => [{ id: "pi", available: true }], models: async () => ({ models: [{ model: "example/model", isDefault: true }] }) },
        threads: { spawn },
      },
      storage: { kv: { get: async () => null, set } },
      log: { info: vi.fn() },
    } as unknown as BbPluginApi;
    expect(await collectSessions(cwd, "pi")).toHaveLength(1);
    const result = await performAdoptQuery(bb, { query: `pi --session ${ID}` });
    expect(result).toMatchObject({ ok: true, dryRun: false, threadId: "thr_pi", plan: { agent: "pi", providerId: "pi", cwd } });
    const input = spawn.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(input[0]).toMatchObject({ providerId: "pi", environment: { workspace: { path: cwd } } });
    expect(JSON.stringify(input[0])).toContain("Fix the parser");
    expect(JSON.stringify(input[0])).not.toContain("private");
    expect(set).toHaveBeenCalledWith(`adopted:pi:${ID}`, expect.objectContaining({ threadId: "thr_pi" }));
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });
});
