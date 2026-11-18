// Issue #21: on a machine with neither a sqlite3 command nor node:sqlite, the
// OpenCode store cannot be read. That must never hide the other agents'
// sessions, and must say so when OpenCode itself was asked for.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { collectSessions, locateSessions, performAdoptQuery } from "../adopt/adopt-core";
import { OPENCODE_SKIPPED_NOTICE } from "../adopt/agents/opencode";
import { runAdoptCli } from "../adopt/cli";
import { CWD, seedOpencodeStore, V2_ID } from "./opencode-fixture";

vi.mock("node:sqlite", () => {
  throw new Error("No such built-in module: node:sqlite");
});

const CLAUDE_ID = "9ace2fd5-d8ae-4946-a0a0-9ff58a6795df";
const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-no-reader-"));
const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-no-sqlite3-"));
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
const bb = { sdk: { projects: { list: async () => [] } } } as unknown as BbPluginApi;

beforeAll(() => {
  seedOpencodeStore(home, "mixed");
  const dir = path.join(home, ".claude", "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${CLAUDE_ID}.jsonl`),
    [
      { type: "user", sessionId: CLAUDE_ID, cwd: CWD, message: { role: "user", content: "Rename the config key." } },
      { type: "assistant", sessionId: CLAUDE_ID, cwd: CWD, message: { role: "assistant", content: [{ type: "text", text: "Renamed it." }] } },
    ].map((line) => JSON.stringify(line)).join("\n"),
  );
  process.env.HOME = home;
  process.env.PATH = emptyBin;
});

afterAll(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  for (const dir of [home, emptyBin]) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OpenCode store with no sqlite3 command and no node:sqlite", () => {
  it("lists every other agent and leaves a one-line notice for OpenCode", async () => {
    const notices: string[] = [];
    const sessions = await collectSessions(CWD, undefined, notices);
    expect(Array.isArray(sessions) && sessions.map((s) => `${s.agent}:${s.sessionId}`)).toEqual([`claude:${CLAUDE_ID}`]);
    expect(notices).toEqual([OPENCODE_SKIPPED_NOTICE]);
  });

  it("fails with a clear error when OpenCode is asked for by name", async () => {
    expect(await collectSessions(CWD, "opencode")).toEqual({
      error: expect.stringContaining("needs the sqlite3 command on PATH or a Node.js runtime with node:sqlite"),
      code: "read-failed",
    });
  });

  it("fails with a clear error when adopting an OpenCode session id", async () => {
    expect(await performAdoptQuery(bb, { query: V2_ID, dryRun: true })).toMatchObject({
      ok: false,
      code: "read-failed",
      message: expect.stringContaining("needs the sqlite3 command"),
    });
  });

  it("still finds another agent's session by id across every store", async () => {
    const found = await locateSessions(bb, CLAUDE_ID, null);
    expect(found.map((s) => `${s.agent}:${s.sessionId}`)).toEqual([`claude:${CLAUDE_ID}`]);
  });

  it("prints the notice under `bb handoff adopt list`, and the error for --agent opencode", async () => {
    const all = await runAdoptCli(bb, ["list", "--cwd", CWD], {});
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain(CLAUDE_ID);
    expect(all.stdout).toContain(OPENCODE_SKIPPED_NOTICE);
    const named = await runAdoptCli(bb, ["list", "--cwd", CWD, "--agent", "opencode"], {});
    expect(named.exitCode).toBe(1);
    expect(named.stderr).toContain("needs the sqlite3 command on PATH");
  });
});
