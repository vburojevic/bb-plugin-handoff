import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { piSessionSlug } from "../adopt/agents/pi";
import { buildListScript, findRemoteSession, parseListOutput, readRemoteSession, REMOTE_AGENTS, shellQuote } from "../adopt/remote";

const HOME = "/Users/mini";
const CWD = "/Users/mini/Git/aurora";

describe("shellQuote", () => {
  it("wraps plain values", () => {
    expect(shellQuote("/Users/mini")).toBe("'/Users/mini'");
  });

  it("survives embedded single quotes", () => {
    expect(shellQuote("/Users/mini/O'Brien")).toBe("'/Users/mini/O'\\''Brien'");
  });

  it("neutralises shell metacharacters in a directory name", () => {
    const quoted = shellQuote("/tmp/x; rm -rf ~");
    expect(quoted).toBe("'/tmp/x; rm -rf ~'");
    // Everything dangerous stays inside the quotes.
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });
});

describe("buildListScript", () => {
  const script = buildListScript(HOME, CWD);

  it("probes both stat dialects before using one", () => {
    expect(script).toContain("stat -f %m .");
    expect(script).toContain("-c %Y|%s|%n");
  });

  it("addresses Claude by the project slug", () => {
    expect(script).toContain("'/Users/mini/.claude/projects/-Users-mini-Git-aurora'");
  });

  it("addresses Gemini by the cwd hash, not by scanning", () => {
    // sha256("/Users/mini/Git/aurora")
    expect(script).toMatch(/\.gemini\/tmp\/[0-9a-f]{64}\/chats/);
  });

  it("filters Codex rollouts by the cwd recorded in session_meta", () => {
    expect(script).toContain(`'"cwd":"${CWD}"'`);
    expect(script).toContain("sort -r");
  });

  it("addresses Pi by its cwd slug, without using the server's Pi environment", () => {
    expect(script).toContain("'/Users/mini/.pi/agent/sessions/--Users-mini-Git-aurora--'");
    expect(script).toContain("printf 'pi\\t\\t'");
    expect(REMOTE_AGENTS).toContain("pi");
  });

  it("only queries OpenCode when the db and sqlite3 are both present", () => {
    expect(script).toContain("command -v sqlite3");
    expect(script).toContain(".local/share/opencode/opencode.db");
  });

  it("quotes an adversarial cwd instead of interpolating it raw", () => {
    const nasty = buildListScript(HOME, "/tmp/a'; touch /tmp/pwned; '");
    expect(nasty).not.toContain("; touch /tmp/pwned; ;");
    expect(nasty).toContain("'\\''");
  });
});

describe("remote Pi sessions", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const file = `2026-10-01T10-00-00-000Z_${id}.jsonl`;

  it("executes directory discovery on POSIX sh with spaces and quotes in paths", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-remote-pi-"));
    try {
      const cwd = "/Users/dev/It's a repo";
      const dir = path.join(home, ".pi/agent/sessions", piSessionSlug(cwd));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), "{}");
      const output = execFileSync("sh", ["-c", buildListScript(home, cwd)], { encoding: "utf8" });
      expect(parseListOutput(output, cwd)).toEqual([
        expect.objectContaining({ agent: "pi", sessionId: id, filePath: path.join(dir, file), cwd }),
      ]);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("keeps all matching Pi ids but rejects fuzzy path-only matches", async () => {
    const list = vi.fn(async () => [
      `--example--/2026-10-01T10-00-00-000Z_${id}.jsonl`,
      "--example--/2026-10-01T10-00-00-000Z_11111111-other.jsonl",
      "--11111111--/2026-10-01T10-00-00-000Z_unrelated.jsonl",
      "--example--/11111111.txt",
    ]);
    const bb = { sdk: { files: { list } } } as unknown as BbPluginApi;
    const found = await findRemoteSession({ bb, hostId: "remote", hostName: "Mini", home: HOME }, "11111111", "pi");
    expect(found.map((session) => session.sessionId)).toEqual([id, "11111111-other"]);
    expect(found.every((session) => session.agent === "pi")).toBe(true);
  });

  it("finds Pi by filename and parses the remote header and active branch", async () => {
    const filePath = `${HOME}/.pi/agent/sessions/--example--/${file}`;
    const list = vi.fn(async () => [`--example--/${file}`]);
    const raw = [
      { type: "session", version: 3, id, cwd: CWD, timestamp: "2026-10-01T10:00:00Z" },
      { type: "message", id: "u", parentId: null, message: { role: "user", content: "Continue remotely" } },
      { type: "message", id: "old", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "Abandoned" }] } },
      { type: "message", id: "new", parentId: "u", message: { role: "assistant", content: [{ type: "text", text: "Current branch" }] } },
    ].map((row) => JSON.stringify(row)).join("\n");
    const read = vi.fn(async () => ({ content: Buffer.from(raw).toString("base64"), contentEncoding: "base64" }));
    const bb = { sdk: { files: { list, read } } } as unknown as BbPluginApi;
    const ctx = { bb, hostId: "host_remote", hostName: "Mini", home: HOME };
    const found = await findRemoteSession(ctx, id, "pi");
    expect(found).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ path: `${HOME}/.pi/agent/sessions`, query: id }));
    const parsed = await readRemoteSession(ctx, found[0]!);
    expect(read).toHaveBeenCalledWith({ hostId: "host_remote", path: filePath });
    expect(parsed).toMatchObject({ agent: "pi", sessionId: id, cwd: CWD });
    expect(parsed.transcript).toContain("Current branch");
    expect(parsed.transcript).not.toContain("Abandoned");
  });
});

describe("parseListOutput", () => {
  it("reads a claude row, deriving the id from the filename", () => {
    const line = "claude\t\t1786297183|23353|/Users/mini/.claude/projects/-Users-mini/003fe107-474a-4215-8a53-879db8bb9efd.jsonl";
    expect(parseListOutput(line, CWD)).toEqual([
      {
        agent: "claude",
        sessionId: "003fe107-474a-4215-8a53-879db8bb9efd",
        filePath:
          "/Users/mini/.claude/projects/-Users-mini/003fe107-474a-4215-8a53-879db8bb9efd.jsonl",
        modifiedAtMs: 1786297183000,
        sizeBytes: 23353,
        title: null,
        cwd: CWD,
      },
    ]);
  });

  it("pulls the uuid out of a codex rollout filename", () => {
    const line =
      "codex\t\t1783695147|53808|/Users/mini/.codex/sessions/2026/07/10/rollout-2026-07-10T16-52-22-019f4c83-f023-7e22-9a2b-f1a3d1c9f566.jsonl";
    expect(parseListOutput(line, CWD)[0]).toMatchObject({
      agent: "codex",
      sessionId: "019f4c83-f023-7e22-9a2b-f1a3d1c9f566",
    });
  });

  it("removes Pi's timestamp prefix without truncating custom ids", () => {
    const line = "pi\t\t1783695147|53808|/Users/mini/.pi/agent/sessions/--Users-mini--/2026-10-01T10-00-00-000Z_parser_repair.jsonl";
    expect(parseListOutput(line, CWD)[0]).toMatchObject({ agent: "pi", sessionId: "parser_repair" });
  });

  it("prefers the id the script read out of a gemini file", () => {
    const line =
      "gemini\taa11bb22-cc33-dd44-ee55-ff6677889900\t1786300000|1200|/Users/mini/.gemini/tmp/abc/chats/session-2026-08-09T10-00-89900.json";
    expect(parseListOutput(line, CWD)[0]).toMatchObject({
      agent: "gemini",
      sessionId: "aa11bb22-cc33-dd44-ee55-ff6677889900",
    });
  });

  it("expands the opencode json row set", () => {
    const rows = JSON.stringify([
      { id: "ses_a", directory: "/Users/mini", title: "Trim the retry backoff", time_updated: 1786300600000 },
      { id: "ses_b", directory: "/Users/mini", title: "New session - 2026", time_updated: 1786300000000 },
    ]);
    const parsed = parseListOutput(`opencode\t\t${rows}`, CWD);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ sessionId: "ses_a", title: "Trim the retry backoff", cwd: "/Users/mini" });
    // OpenCode's placeholder titles are not titles.
    expect(parsed[1]!.title).toBeNull();
  });

  it("keeps a path containing the field separator intact", () => {
    const line = "claude\t\t1786297183|100|/Users/mini/.claude/projects/-Users-mini/we|ird.jsonl";
    expect(parseListOutput(line, CWD)[0]).toMatchObject({
      filePath: "/Users/mini/.claude/projects/-Users-mini/we|ird.jsonl",
      sizeBytes: 100,
    });
  });

  it("tolerates the leading whitespace some stat builds emit", () => {
    const line = "claude\t\t 1786297183|23353|/Users/mini/.claude/projects/-Users-mini/x.jsonl";
    expect(parseListOutput(line, CWD)[0]!.modifiedAtMs).toBe(1786297183000);
  });

  it("sorts every store together, newest first", () => {
    const output = [
      "claude\t\t1000|1|/Users/mini/.claude/projects/-Users-mini/old.jsonl",
      "claude\t\t3000|1|/Users/mini/.claude/projects/-Users-mini/new.jsonl",
      "codex\t\t2000|1|/Users/mini/.codex/sessions/2026/07/10/rollout-x.jsonl",
    ].join("\n");
    expect(parseListOutput(output, CWD).map((s) => s.modifiedAtMs)).toEqual([
      3000000, 2000000, 1000000,
    ]);
  });

  it("skips blank lines, malformed rows, and unparseable opencode json", () => {
    const output = ["", "claude\t\tnonsense", "garbage", "opencode\t\t{oops"].join("\n");
    expect(parseListOutput(output, CWD)).toEqual([]);
  });
});
