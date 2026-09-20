import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeAdapter, claudeProjectRoots } from "../adopt/agents/claude";

const CWD = "/Users/someone/Git/example-repo";
const SLUG = CWD.replace(/[^a-zA-Z0-9]/g, "-");
const DEFAULT_ID = "11111111-1111-1111-1111-111111111111";
const WORK_ID = "22222222-2222-2222-2222-222222222222";

const homes: string[] = [];
let savedConfigDir: string | undefined;

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-store-"));
  homes.push(home);
  return home;
}

/** A session file under `<home>/<configDir>/projects/<slug>/<id>.jsonl`. */
function writeSession(home: string, configDir: string, id: string): string {
  const dir = path.join(home, configDir, "projects", SLUG);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(
    filePath,
    JSON.stringify({ type: "user", sessionId: id, cwd: CWD, message: { content: "hello" } }),
  );
  return filePath;
}

beforeEach(() => {
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe("claudeProjectRoots", () => {
  it("is just the default store when no profile directory exists", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
    expect(claudeProjectRoots(home)).toEqual([path.join(home, ".claude", "projects")]);
  });

  it("picks up sibling profile directories without CLAUDE_CONFIG_DIR", () => {
    const home = makeHome();
    writeSession(home, ".claude", DEFAULT_ID);
    writeSession(home, ".claude-work", WORK_ID);
    expect(claudeProjectRoots(home)).toEqual([
      path.join(home, ".claude", "projects"),
      path.join(home, ".claude-work", "projects"),
    ]);
  });

  it("puts CLAUDE_CONFIG_DIR first and never repeats a root", () => {
    const home = makeHome();
    writeSession(home, ".claude", DEFAULT_ID);
    writeSession(home, ".claude-work", WORK_ID);
    process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude-work");
    const roots = claudeProjectRoots(home);
    expect(roots[0]).toBe(path.join(home, ".claude-work", "projects"));
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("ignores unrelated dotfiles next to the default store", () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, ".claudia"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude-notes"), "not a directory");
    writeSession(home, ".claude", DEFAULT_ID);
    expect(claudeProjectRoots(home)).toEqual([path.join(home, ".claude", "projects")]);
  });
});

describe("claudeAdapter across profiles", () => {
  it("lists sessions from every profile for the directory", async () => {
    const home = makeHome();
    const fromDefault = writeSession(home, ".claude", DEFAULT_ID);
    const fromWork = writeSession(home, ".claude-work", WORK_ID);
    const listed = await claudeAdapter.list(CWD, home);
    expect(listed.map((s) => s.filePath).sort()).toEqual([fromDefault, fromWork].sort());
  });

  it("finds a session that lives in a non-default profile", async () => {
    const home = makeHome();
    const fromWork = writeSession(home, ".claude-work", WORK_ID);
    const found = await claudeAdapter.find(WORK_ID.slice(0, 8), { home });
    expect(found).toHaveLength(1);
    expect(found[0].filePath).toBe(fromWork);
    expect(found[0].cwd).toBe(CWD);
  });

  it("reports one entry per session id when profiles are symlinked together", async () => {
    const home = makeHome();
    writeSession(home, ".claude", DEFAULT_ID);
    // A common workaround for this bug: link the profile store into the default
    // one. Both roots then resolve to the same file.
    fs.mkdirSync(path.join(home, ".claude-work", "projects"), { recursive: true });
    fs.symlinkSync(
      path.join(home, ".claude", "projects", SLUG),
      path.join(home, ".claude-work", "projects", SLUG),
      "dir",
    );
    const listed = await claudeAdapter.list(CWD, home);
    expect(listed).toHaveLength(1);
    expect(listed[0].sessionId).toBe(DEFAULT_ID);
  });
});
