// OpenCode sessions: ~/.local/share/opencode/opencode.db (SQLite), in one of
// two schemas, often both in one db:
// - legacy: `session` rows (directory = cwd), conversation in `message`
//   (role, timing) + `part` (text/tool payloads) rows;
// - current: `session_v2` rows, conversation in `session_message`, one row per
//   message whose `type` is the role and whose `data.content[]` holds the
//   parts inline. An upgraded db copies legacy sessions into `session_v2` but
//   leaves their messages in `message`/`part`.
// The db is read via the system `sqlite3` CLI in -readonly -json mode, so the
// plugin needs no native sqlite binding of its own; without that command
// (stock Windows) it falls back to the runtime's node:sqlite. filePath for this
// adapter is "<db-path>#<session-id>".
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
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

type Rows = Record<string, unknown>[];

/** Neither a sqlite3 command nor node:sqlite: this machine cannot read the store. */
export class OpencodeReaderMissing extends Error {
  constructor() {
    super(
      "Reading OpenCode sessions needs the sqlite3 command on PATH or a Node.js runtime with node:sqlite (22.5 or newer).",
    );
    this.name = "OpencodeReaderMissing";
  }
}

/** What a listing of every agent says when it had to leave OpenCode out. */
export const OPENCODE_SKIPPED_NOTICE = "OpenCode sessions skipped: no sqlite3 or node:sqlite available";

/**
 * Run a read-only query; returns [] when the db is absent or the query fails.
 * Without a sqlite3 command it reads in process, and says so when it cannot.
 */
async function query(dbPath: string, sql: string): Promise<Rows> {
  try {
    await access(dbPath);
  } catch {
    return [];
  }
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", dbPath, sql], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed) return [];
    const rows = JSON.parse(trimmed);
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return [];
    return queryInProcess(dbPath, sql);
  }
}

/**
 * The fallback for machines without a sqlite3 command. node:sqlite ships with
 * Node 22.5+, which bb's plugin host has; it runs synchronously, so it is kept
 * for that case rather than replacing the subprocess.
 */
async function queryInProcess(dbPath: string, sql: string): Promise<Rows> {
  let sqlite: typeof import("node:sqlite");
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new OpencodeReaderMissing();
  }
  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return db.prepare(sql).all() as Rows;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Which of OpenCode's two schemas a db holds; an upgraded db holds both. */
export interface OpencodeSchema {
  v2: boolean;
  legacy: boolean;
}

/** One row of two 0/1 flags, `v2` and `legacy`. */
export const OPENCODE_SCHEMA_SQL =
  "SELECT (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('session_v2','session_message')) = 2 AS v2, " +
  "(SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('session','message','part')) = 3 AS legacy";

async function readSchema(dbPath: string): Promise<OpencodeSchema> {
  const row = (await query(dbPath, OPENCODE_SCHEMA_SQL))[0];
  return { v2: Number(row?.v2) === 1, legacy: Number(row?.legacy) === 1 };
}

export interface SessionRow {
  id: string;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
}

export const SESSION_COLUMNS = "id, directory, title, time_created, time_updated";

/**
 * Every session row the db holds: `session_v2`, plus the legacy `session` rows
 * an upgrade did not copy over. null when the db holds neither schema.
 */
function sessionTable(schema: OpencodeSchema): string | null {
  const columns = `${SESSION_COLUMNS}, parent_id`;
  if (schema.v2 && schema.legacy) {
    return `(SELECT ${columns} FROM session_v2 UNION ALL SELECT ${columns} FROM session WHERE id NOT IN (SELECT id FROM session_v2))`;
  }
  if (schema.v2) return "session_v2";
  if (schema.legacy) return "session";
  return null;
}

/**
 * The queries a full session read needs, as SQL a remote sqlite3 can run; a
 * query is null when the db lacks its tables.
 */
export function opencodeSql(sessionId: string, schema: OpencodeSchema): {
  session: string | null;
  sessionMessages: string | null;
  messages: string | null;
  parts: string | null;
} {
  const id = escapeSqlLiteral(sessionId);
  const table = sessionTable(schema);
  return {
    session: table && `SELECT ${SESSION_COLUMNS} FROM ${table} WHERE id='${id}'`,
    sessionMessages: schema.v2
      ? `SELECT id, type, time_created, data FROM session_message WHERE session_id='${id}' ORDER BY seq, id`
      : null,
    messages: schema.legacy
      ? `SELECT id, data FROM message WHERE session_id='${id}' ORDER BY time_created, id`
      : null,
    parts: schema.legacy
      ? `SELECT message_id, data FROM part WHERE session_id='${id}' ORDER BY time_created, id`
      : null,
  };
}

export function opencodeListSql(cwd: string, schema: OpencodeSchema): string | null {
  const table = sessionTable(schema);
  return table && `SELECT ${SESSION_COLUMNS} FROM ${table} WHERE directory='${escapeSqlLiteral(cwd)}' AND parent_id IS NULL ORDER BY time_updated DESC LIMIT 50`;
}

export function opencodeFindSql(idOrPrefix: string, schema: OpencodeSchema): string | null {
  const table = sessionTable(schema);
  const needle = escapeSqlLiteral(idOrPrefix.replaceAll("%", "").replaceAll("_", "\\_"));
  return table && `SELECT ${SESSION_COLUMNS} FROM ${table} WHERE id LIKE '${needle}%' ESCAPE '\\' ORDER BY time_updated DESC LIMIT 10`;
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

  async list(cwd: string, home: string = os.homedir()): Promise<SessionSummary[]> {
    const dbPath = opencodeDbPath(home);
    const sql = opencodeListSql(cwd, await readSchema(dbPath));
    const rows = sql ? await query(dbPath, sql) as unknown as SessionRow[] : [];
    return rows.map((row) => toSummary(dbPath, row));
  },

  async find(idOrPrefix: string, options: { home?: string; cwdCandidates?: string[] } = {}): Promise<FoundSession[]> {
    const dbPath = opencodeDbPath(options.home ?? os.homedir());
    const sql = opencodeFindSql(idOrPrefix, await readSchema(dbPath));
    const rows = sql ? await query(dbPath, sql) as unknown as SessionRow[] : [];
    return rows.map((row) => ({ ...toSummary(dbPath, row), cwd: row.directory ?? null }));
  },

  async parse(filePath: string, options: { maxChars?: number } = {}): Promise<ParsedSession> {
    const separator = filePath.lastIndexOf("#");
    const dbPath = separator === -1 ? filePath : filePath.slice(0, separator);
    const sessionId = separator === -1 ? "" : filePath.slice(separator + 1);
    const sql = opencodeSql(sessionId, await readSchema(dbPath));
    const read = (statement: string | null): Promise<Rows> =>
      statement ? query(dbPath, statement) : Promise.resolve([]);

    const sessionRows = await read(sql.session) as unknown as SessionRow[];
    const session = sessionRows[0];
    if (!session) throw new Error(`No OpenCode session ${sessionId} in ${dbPath}`);
    const [sessionMessages, messages, parts] = await Promise.all([
      read(sql.sessionMessages),
      read(sql.messages),
      read(sql.parts),
    ]);
    return parseOpencodeRows(
      { session, sessionMessages, messages, parts },
      filePath,
      options,
    );
  },
};

export interface OpencodeRows {
  session: SessionRow;
  /** `session_message` rows; when there are any, they are the conversation. */
  sessionMessages?: Record<string, unknown>[];
  /** Legacy `message` and `part` rows, read when `session_message` has none. */
  messages: Record<string, unknown>[];
  parts: Record<string, unknown>[];
}

/** One message of either schema, reduced to what the transcript shows. */
interface Turn {
  role: unknown;
  parts: Record<string, unknown>[];
  time: unknown;
  cwd: unknown;
}

function legacyTurns(messageRows: Record<string, unknown>[], partRows: Record<string, unknown>[]): Turn[] {
  const partsByMessage = new Map<string, Record<string, unknown>[]>();
  for (const row of partRows) {
    const messageId = typeof row.message_id === "string" ? row.message_id : "";
    const data = parseData(row.data);
    if (!messageId || !data) continue;
    const bucket = partsByMessage.get(messageId);
    if (bucket) bucket.push(data);
    else partsByMessage.set(messageId, [data]);
  }
  const turns: Turn[] = [];
  for (const row of messageRows) {
    const data = parseData(row.data);
    if (!data) continue;
    turns.push({
      role: data.role,
      parts: partsByMessage.get(typeof row.id === "string" ? row.id : "") ?? [],
      time: (data.time as { created?: number } | undefined)?.created,
      cwd: (data.path as { cwd?: string } | undefined)?.cwd,
    });
  }
  return turns;
}

/**
 * `session_message` rows. The row type is the role; a user prompt keeps its
 * text in `data.text`, other content in `data.content[]`. Rows of any other
 * type (synthetic, system, compaction, idle, model-switched, agent-switched)
 * are OpenCode's own bookkeeping, not conversation, so they are left out, as
 * the legacy reader leaves out the parts it does not show.
 */
function sessionMessageTurns(rows: Record<string, unknown>[]): Turn[] {
  const turns: Turn[] = [];
  for (const row of rows) {
    if (row.type !== "user" && row.type !== "assistant") continue;
    const data = parseData(row.data);
    if (!data) continue;
    const parts = Array.isArray(data.content)
      ? data.content.filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
      : [];
    if (typeof data.text === "string") parts.unshift({ type: "text", text: data.text });
    turns.push({
      role: row.type,
      parts,
      time: (data.time as { created?: number } | undefined)?.created ?? row.time_created,
      cwd: undefined,
    });
  }
  return turns;
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
  const { session } = rows;
  const turns = rows.sessionMessages?.length
    ? sessionMessageTurns(rows.sessionMessages)
    : legacyTurns(rows.messages, rows.parts);

  const builder = new BlockBuilder();
  let cwd: string | null = session.directory ?? null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  for (const { role, parts, time, cwd: messageCwd } of turns) {
    if (typeof time === "number") {
      const iso = new Date(time).toISOString();
      firstTimestamp ??= iso;
      lastTimestamp = iso;
    }
    if (typeof messageCwd === "string") cwd ??= messageCwd;

    const texts: string[] = [];
    const tools: string[] = [];
    for (const part of parts) {
      // Legacy tool parts name the tool in `tool`, session_message ones in `name`.
      const tool = part.tool ?? part.name;
      if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
      else if (part.type === "tool" && typeof tool === "string") {
        tools.push(formatToolCall(tool, (part.state as { input?: unknown } | undefined)?.input));
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
  // A current OpenCode leaves the title empty until it names the session.
  const title = !session.title || session.title.startsWith("New session - ")
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
