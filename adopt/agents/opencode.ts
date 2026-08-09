// OpenCode sessions: ~/.local/share/opencode/opencode.db (SQLite).
// Sessions live in a `session` table (directory = cwd), conversation content
// in `message` (role, timing) + `part` (text/tool payloads) rows. The db is
// read via the system `sqlite3` CLI in -readonly -json mode, so the plugin
// needs no native sqlite binding of its own. filePath for this adapter is
// "<db-path>#<session-id>".
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BlockBuilder,
  formatToolCall,
  renderTranscript,
  snippet,
  type AgentAdapter,
  type FoundSession,
  type ParsedSession,
  type SessionSummary,
} from "../transcript";

export function opencodeDbPath(home: string = os.homedir()): string {
  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

/**
 * Injected context arrives as user-role messages wrapped in XML-ish tags
 * (<system_instructions>, <environment_context>, …) — real user prompts don't
 * start with a bare snake_case tag.
 */
function isInjectedUserText(text: string): boolean {
  return /^<[a-z][a-z0-9_]*>/.test(text.trimStart());
}

/** Run a read-only query; returns [] when sqlite3 or the db is unavailable. */
function query(dbPath: string, sql: string): Record<string, unknown>[] {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const stdout = execFileSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const rows = JSON.parse(trimmed);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export interface SessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

export const SESSION_COLUMNS = "id, directory, title, time_created, time_updated";

/** The three queries a full session read needs, as SQL a remote sqlite3 can run. */
export function opencodeSql(sessionId: string): {
  session: string;
  messages: string;
  parts: string;
} {
  const id = escapeSqlLiteral(sessionId);
  return {
    session: `SELECT ${SESSION_COLUMNS} FROM session WHERE id='${id}'`,
    messages: `SELECT id, data FROM message WHERE session_id='${id}' ORDER BY time_created, id`,
    parts: `SELECT message_id, data FROM part WHERE session_id='${id}' ORDER BY time_created, id`,
  };
}

export function opencodeListSql(cwd: string): string {
  return `SELECT ${SESSION_COLUMNS} FROM session WHERE directory='${escapeSqlLiteral(cwd)}' AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 50`;
}

export function opencodeFindSql(idOrPrefix: string): string {
  const needle = escapeSqlLiteral(idOrPrefix.replaceAll("%", "").replaceAll("_", "\\_"));
  return `SELECT ${SESSION_COLUMNS} FROM session WHERE id LIKE '${needle}%' ESCAPE '\\' ORDER BY time_updated DESC LIMIT 10`;
}

export function opencodeSummary(dbPath: string, row: SessionRow): SessionSummary {
  return toSummary(dbPath, row);
}

function toSummary(dbPath: string, row: SessionRow): SessionSummary {
  return {
    agent: "opencode",
    sessionId: row.id,
    filePath: `${dbPath}#${row.id}`,
    modifiedAtMs: row.time_updated,
    sizeBytes: 0, // sessions are db rows, not files; no meaningful byte size
    title: row.title?.startsWith("New session - ") ? null : (row.title ?? null),
  };
}

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  label: "OpenCode",
  bbProviderId: "acp-opencode",

  list(cwd: string, home: string = os.homedir()): SessionSummary[] {
    const dbPath = opencodeDbPath(home);
    const rows = query(dbPath, opencodeListSql(cwd)) as unknown as SessionRow[];
    return rows.map((row) => toSummary(dbPath, row));
  },

  find(idOrPrefix: string, options: { home?: string; cwdCandidates?: string[] } = {}): FoundSession[] {
    const dbPath = opencodeDbPath(options.home ?? os.homedir());
    const rows = query(dbPath, opencodeFindSql(idOrPrefix)) as unknown as SessionRow[];
    return rows.map((row) => ({ ...toSummary(dbPath, row), cwd: row.directory ?? null }));
  },

  parse(filePath: string, options: { maxChars?: number } = {}): ParsedSession {
    const separator = filePath.lastIndexOf("#");
    const dbPath = separator === -1 ? filePath : filePath.slice(0, separator);
    const sessionId = separator === -1 ? "" : filePath.slice(separator + 1);
    const sql = opencodeSql(sessionId);

    const sessionRows = query(dbPath, sql.session) as unknown as SessionRow[];
    const session = sessionRows[0];
    if (!session) throw new Error(`No OpenCode session ${sessionId} in ${dbPath}`);
    return parseOpencodeRows(
      { session, messages: query(dbPath, sql.messages), parts: query(dbPath, sql.parts) },
      filePath,
      options,
    );
  },
};

export interface OpencodeRows {
  session: SessionRow;
  messages: Record<string, unknown>[];
  parts: Record<string, unknown>[];
}

/**
 * Turn raw session/message/part rows into a transcript. Split from the query
 * layer so a remote sqlite3 can supply the same rows as JSON.
 */
export function parseOpencodeRows(
  rows: OpencodeRows,
  filePath: string,
  options: { maxChars?: number } = {},
): ParsedSession {
  const maxChars = options.maxChars ?? 150_000;
  const { session, messages: messageRows, parts: partRows } = rows;

  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const row of partRows) {
    const messageId = typeof row.message_id === "string" ? row.message_id : "";
    const data = parseData(row.data);
    if (!messageId || !data) continue;
    const bucket = partsByMessage.get(messageId);
    if (bucket) bucket.push(data);
    else partsByMessage.set(messageId, [data]);
  }

  const builder = new BlockBuilder();
  let cwd: string | null = session.directory ?? null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  for (const row of messageRows) {
    const messageId = typeof row.id === "string" ? row.id : "";
    const data = parseData(row.data);
    if (!data) continue;
    const role = data.role;
    const time = (data.time as { created?: number } | undefined)?.created;
    if (typeof time === "number") {
      const iso = new Date(time).toISOString();
      firstTimestamp ??= iso;
      lastTimestamp = iso;
    }
    const messageCwd = (data.path as { cwd?: string } | undefined)?.cwd;
    if (typeof messageCwd === "string") cwd ??= messageCwd;

    const parts = partsByMessage.get(messageId) ?? [];
    const texts: string[] = [];
    const tools: string[] = [];
    for (const part of parts) {
      if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (part.type === "tool" && typeof part.tool === "string") {
        tools.push(formatToolCall(part.tool, (part.state as { input?: unknown } | undefined)?.input));
      }
      // reasoning / step / snapshot / file parts are omitted
    }
    if (role === "user") {
      const joined = texts.join("\n\n");
      if (!isInjectedUserText(joined)) builder.addText("user", joined);
    } else if (role === "assistant") {
      builder.addText("assistant", texts.join("\n\n"));
      for (const tool of tools) builder.addTool(tool);
    }
  }

  const rendered = renderTranscript(builder.blocks, maxChars);
  const firstUser = builder.blocks.find((b) => b.role === "user" && b.text.trim());
  const title = session.title?.startsWith("New session - ")
    ? firstUser
      ? snippet(firstUser.text, 80)
      : null
    : (session.title ?? null);
  return {
    agent: "opencode",
    agentLabel: "OpenCode",
    sessionId: session.id,
    filePath,
    cwd,
    gitBranch: null,
    title,
    firstTimestamp,
    lastTimestamp: lastTimestamp ?? new Date(session.time_updated).toISOString(),
    userMessageCount: rendered.userMessageCount,
    assistantMessageCount: rendered.assistantMessageCount,
    transcript: rendered.transcript,
    truncated: rendered.truncated,
  };
}

function parseData(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
