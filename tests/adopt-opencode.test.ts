// The adapter reads via the system `sqlite3` CLI; the fixture db is written
// with better-sqlite3 (a devDependency). Skipped when sqlite3 is missing.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { opencodeAdapter, opencodeDbPath } from "../adopt/agents/opencode";

function hasSqlite3(): boolean {
  try {
    execFileSync("sqlite3", ["-version"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-opencode-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

function seedFixture(): string {
  const dbPath = opencodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  const now = 1_700_000_100_000;
  db.prepare(
    "INSERT INTO session VALUES ('ses_abc123', 'prj_1', NULL, 'fix-tests', '/tmp/work/repo', 'Fix the flaky tests', '1.0', ?, ?)",
  ).run(now - 60_000, now);
  const insertMessage = db.prepare("INSERT INTO message VALUES (?, 'ses_abc123', ?, ?, ?)");
  const insertPart = db.prepare("INSERT INTO part VALUES (?, ?, 'ses_abc123', ?, ?, ?)");
  insertMessage.run("msg_1", now - 50_000, now - 50_000, JSON.stringify({ role: "user", time: { created: now - 50_000 } }));
  insertPart.run("prt_1", "msg_1", now - 50_000, now - 50_000, JSON.stringify({ type: "text", text: "Please fix the flaky tests." }));
  insertMessage.run("msg_2", now - 40_000, now - 40_000, JSON.stringify({ role: "assistant", time: { created: now - 40_000 }, path: { cwd: "/tmp/work/repo" } }));
  insertPart.run("prt_2", "msg_2", now - 40_000, now - 40_000, JSON.stringify({ type: "text", text: "On it — the retry helper races." }));
  insertPart.run("prt_3", "msg_2", now - 39_000, now - 39_000, JSON.stringify({ type: "tool", tool: "bash", state: { input: { command: "npm test" } } }));
  db.close();
  return dbPath;
}

describe.skipIf(!hasSqlite3())("opencodeAdapter", () => {
  const dbPath = seedFixture();

  it("lists sessions for a directory", () => {
    const sessions = opencodeAdapter.list("/tmp/work/repo", home);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      agent: "opencode",
      sessionId: "ses_abc123",
      title: "Fix the flaky tests",
      filePath: `${dbPath}#ses_abc123`,
    });
    expect(opencodeAdapter.list("/tmp/other", home)).toHaveLength(0);
  });

  it("finds by id prefix with the recovered cwd", () => {
    const found = opencodeAdapter.find("ses_abc", { home });
    expect(found).toHaveLength(1);
    expect(found[0]!.cwd).toBe("/tmp/work/repo");
  });

  it("parses the transcript with roles and tool calls", () => {
    const session = opencodeAdapter.parse(`${dbPath}#ses_abc123`);
    expect(session.sessionId).toBe("ses_abc123");
    expect(session.cwd).toBe("/tmp/work/repo");
    expect(session.userMessageCount).toBe(1);
    expect(session.assistantMessageCount).toBe(1);
    expect(session.transcript).toContain("Please fix the flaky tests.");
    expect(session.transcript).toContain("the retry helper races");
    expect(session.transcript).toContain("bash(");
    expect(session.firstTimestamp).toBeTruthy();
  });

  it("returns empty results when the db is absent", () => {
    expect(opencodeAdapter.list("/tmp/work/repo", "/nonexistent-home")).toHaveLength(0);
    expect(opencodeAdapter.find("ses_abc", { home: "/nonexistent-home" })).toHaveLength(0);
  });
});
