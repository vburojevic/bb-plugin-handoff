// OpenCode db fixtures in the store's current shape: `session_v2` holds the
// session rows and `session_message` the conversation, one JSON row per
// message with its parts inline. Columns follow OpenCode's own DDL, trimmed to
// the ones that are NOT NULL or that the adapter reads.
import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { opencodeDbPath } from "../adopt/agents/opencode";

export const V2_ID = "ses_v2conversation01";
export const MIGRATED_ID = "ses_migratedlegacy01";
export const LEGACY_ID = "ses_legacyonly000001";
export const CWD = "/tmp/work/repo";
const NOW = 1_790_000_000_000;

const LEGACY_DDL = `
  CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
    slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT NOT NULL, version TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;

const V2_DDL = `
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT,
    parent_id TEXT, fork_session_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL, title TEXT,
    version TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    time_suspended INTEGER);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
    data TEXT NOT NULL);
  CREATE TABLE session_part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
`;

/**
 * Write an OpenCode db under `home`. `v2-only` is a store created by a current
 * OpenCode; `mixed` is one that was upgraded: legacy sessions copied into
 * `session_v2` with their messages left in `message`/`part`, one session that
 * never made it into `session_v2`, and a new session in `session_message`.
 */
export function seedOpencodeStore(home: string, shape: "v2-only" | "mixed"): string {
  const dbPath = opencodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(V2_DDL);
  const insertV2 = db.prepare(
    "INSERT INTO session_v2 (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'prj_1', ?, ?, ?, ?, '2.0', ?, ?)",
  );
  // A current OpenCode leaves the title empty until it names the session.
  insertV2.run(V2_ID, null, "v2", CWD, null, NOW - 60_000, NOW);
  // A subagent session is a child; adopt list shows only top-level sessions.
  insertV2.run("ses_v2childsession01", V2_ID, "child", CWD, "Explore the repo", NOW - 50_000, NOW - 1_000);

  const insertMessage = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
  let seq = 0;
  const add = (type: string, data: Record<string, unknown>) => {
    const at = NOW - 40_000 + seq * 1_000;
    insertMessage.run(`msg_v2_${seq}`, V2_ID, type, seq, at, at, JSON.stringify({ time: { created: at }, ...data }));
    seq += 1;
  };
  add("model-switched", { model: { id: "big-model", providerID: "acme" } });
  add("system", { text: "The available tools have changed." });
  add("user", { text: "Please make the retry test deterministic." });
  add("assistant", {
    agent: "build",
    content: [
      { type: "reasoning", text: "The test sleeps on a real clock." },
      { type: "text", text: "The retry test waits on a real timer, so I will fake the clock." },
      { type: "tool", id: "call_1", name: "shell", state: { status: "completed", input: { command: "npm test -- retry" } } },
    ],
  });
  add("synthetic", { text: "Continue if you have next steps." });
  add("compaction", { status: "completed", reason: "auto", summary: "Summary of the work so far." });
  add("agent-switched", { agent: "plan" });
  add("idle", {});
  add("user", { content: [{ type: "text", text: "Also cover the backoff cap." }] });
  add("assistant", { content: [{ type: "text", text: "Added a test for the cap." }] });

  if (shape === "mixed") {
    db.exec(LEGACY_DDL);
    const insertLegacy = db.prepare(
      "INSERT INTO session VALUES (?, 'prj_1', NULL, 'old', ?, ?, '1.0', ?, ?)",
    );
    insertLegacy.run(MIGRATED_ID, CWD, "Fix the flaky tests", NOW - 900_000, NOW - 800_000);
    insertV2.run(MIGRATED_ID, null, "old", CWD, "Fix the flaky tests", NOW - 900_000, NOW - 800_000);
    insertLegacy.run(LEGACY_ID, CWD, "Rename the config key", NOW - 990_000, NOW - 950_000);
    const legacyMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const legacyPart = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    for (const [sessionId, prompt, answer] of [
      [MIGRATED_ID, "Please fix the flaky tests.", "The retry helper races."],
      [LEGACY_ID, "Rename the config key.", "Renamed it."],
    ] as const) {
      const at = NOW - 850_000;
      legacyMessage.run(`${sessionId}_u`, sessionId, at, at, JSON.stringify({ role: "user", time: { created: at } }));
      legacyPart.run(`${sessionId}_pu`, `${sessionId}_u`, sessionId, at, at, JSON.stringify({ type: "text", text: prompt }));
      legacyMessage.run(`${sessionId}_a`, sessionId, at + 1, at + 1, JSON.stringify({ role: "assistant", time: { created: at + 1 } }));
      legacyPart.run(`${sessionId}_pa`, `${sessionId}_a`, sessionId, at + 1, at + 1, JSON.stringify({ type: "text", text: answer }));
    }
  }
  db.close();
  return dbPath;
}
