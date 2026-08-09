import { describe, expect, it } from "vitest";
import { buildListScript, parseListOutput, shellQuote } from "../adopt/remote";

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
