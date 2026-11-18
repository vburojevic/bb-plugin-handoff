// Issue #21: a current OpenCode keeps sessions in `session_v2` and their
// messages in `session_message`, and Windows has no sqlite3 command.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { opencodeAdapter } from "../adopt/agents/opencode";
import { CWD, LEGACY_ID, MIGRATED_ID, seedOpencodeStore, V2_ID } from "./opencode-fixture";

function hasSqlite3(): boolean {
  try {
    execFileSync("sqlite3", ["-version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterAll(() => roots.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

function store(shape: "v2-only" | "mixed"): { home: string; dbPath: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `handoff-opencode-${shape}-`));
  roots.push(home);
  return { home, dbPath: seedOpencodeStore(home, shape) };
}

/** Run with PATH pointing at an empty directory, so no sqlite3 command exists. */
async function withoutSqlite3<T>(run: () => Promise<T>): Promise<T> {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-no-sqlite3-"));
  roots.push(empty);
  const previous = process.env.PATH;
  process.env.PATH = empty;
  try {
    return await run();
  } finally {
    process.env.PATH = previous;
  }
}

function expectV2Transcript(session: Awaited<ReturnType<typeof opencodeAdapter.parse>>) {
  expect(session.sessionId).toBe(V2_ID);
  expect(session.cwd).toBe(CWD);
  expect(session.userMessageCount).toBe(2);
  expect(session.assistantMessageCount).toBe(2);
  expect(session.transcript).toContain("Please make the retry test deterministic.");
  expect(session.transcript).toContain("fake the clock");
  expect(session.transcript).toContain("shell(");
  expect(session.transcript).toContain("npm test -- retry");
  expect(session.transcript).toContain("Also cover the backoff cap.");
  expect(session.transcript).toContain("Added a test for the cap.");
  // OpenCode's own bookkeeping rows are not conversation.
  for (const noise of ["available tools have changed", "Continue if you have next steps", "Summary of the work so far", "real clock"]) {
    expect(session.transcript).not.toContain(noise);
  }
  // No title yet: fall back to the first prompt, as for "New session - …".
  expect(session.title).toBe("Please make the retry test deterministic.");
  expect(session.firstTimestamp).toBeTruthy();
}

describe.skipIf(!hasSqlite3())("OpenCode session_v2 store via the sqlite3 command", () => {
  it("lists a session that only exists in session_v2", async () => {
    const { home, dbPath } = store("v2-only");
    const sessions = await opencodeAdapter.list(CWD, home);
    expect(sessions.map((s) => s.sessionId)).toEqual([V2_ID]);
    expect(sessions[0]).toMatchObject({ agent: "opencode", filePath: `${dbPath}#${V2_ID}`, title: null });
  });

  it("finds it by id prefix with its directory, and reads its session_message rows", async () => {
    const { home } = store("v2-only");
    const found = await opencodeAdapter.find("ses_v2conv", { home });
    expect(found.map((s) => s.sessionId)).toEqual([V2_ID]);
    expect(found[0]!.cwd).toBe(CWD);
    expectV2Transcript(await opencodeAdapter.parse(found[0]!.filePath));
  });

  it("reads an upgraded store: new, migrated and legacy-only sessions, each once", async () => {
    const { home, dbPath } = store("mixed");
    const sessions = await opencodeAdapter.list(CWD, home);
    expect(sessions.map((s) => s.sessionId)).toEqual([V2_ID, MIGRATED_ID, LEGACY_ID]);

    expectV2Transcript(await opencodeAdapter.parse(`${dbPath}#${V2_ID}`));
    const migrated = await opencodeAdapter.parse(`${dbPath}#${MIGRATED_ID}`);
    expect(migrated).toMatchObject({ title: "Fix the flaky tests", userMessageCount: 1, assistantMessageCount: 1 });
    expect(migrated.transcript).toContain("The retry helper races.");
    const legacy = await opencodeAdapter.parse(`${dbPath}#${LEGACY_ID}`);
    expect(legacy.transcript).toContain("Renamed it.");
    expect((await opencodeAdapter.find("ses_legacyonly", { home }))[0]!.cwd).toBe(CWD);
  });
});

describe("OpenCode store without the sqlite3 command", () => {
  it("lists, finds and reads sessions in process", async () => {
    const { home, dbPath } = store("mixed");
    await withoutSqlite3(async () => {
      expect((await opencodeAdapter.list(CWD, home)).map((s) => s.sessionId)).toEqual([V2_ID, MIGRATED_ID, LEGACY_ID]);
      expect((await opencodeAdapter.find("ses_v2conv", { home }))[0]!.cwd).toBe(CWD);
      expectV2Transcript(await opencodeAdapter.parse(`${dbPath}#${V2_ID}`));
      expect((await opencodeAdapter.parse(`${dbPath}#${MIGRATED_ID}`)).transcript).toContain("The retry helper races.");
    });
  });

  it("still returns nothing when OpenCode has no db", async () => {
    await withoutSqlite3(async () => {
      expect(await opencodeAdapter.list(CWD, "/nonexistent-home")).toEqual([]);
    });
  });
});
