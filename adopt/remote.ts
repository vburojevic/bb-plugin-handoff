// Reading another machine's agent sessions. Locally the adapters use fs and a
// sqlite3 subprocess directly; across machines the only primitives bb gives a
// plugin are the host file API and a host terminal, so every store gets a
// reader here that speaks those two.
//
// Discovery is deliberately one round trip: a single POSIX-sh script stats the
// stores that are addressable by path (Claude, Gemini), greps Codex rollouts
// for the working directory, and queries OpenCode's SQLite — all writing one
// TSV stream that the file API reads back.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { claudeProjectSlug } from "../capture";
import { parseClaudeContent } from "./agents/claude";
import { parseCodexContent } from "./agents/codex";
import { geminiChatsDir, parseGeminiContent } from "./agents/gemini";
import {
  opencodeDbPath,
  opencodeFindSql,
  opencodeListSql,
  opencodeSql,
  parseOpencodeRows,
  type SessionRow,
} from "./agents/opencode";
import type { AgentId, FoundSession, ParsedSession, SessionSummary } from "./transcript";

export interface RemoteContext {
  bb: BbPluginApi;
  hostId: string;
  hostName: string;
  home: string;
}

/** Stores that a remote adopt can read at all, and how it reads them. */
export const REMOTE_AGENTS: readonly AgentId[] = ["claude", "codex", "gemini", "opencode"];

// --- Remote execution -------------------------------------------------------

/** Single-quote a value for POSIX sh. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const EXEC_TIMEOUT_MS = 30_000;
const EXEC_POLL_MS = 150;
let execCounter = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one shell script on an enrolled machine and return what it printed.
 *
 * bb's only remote-execution primitive is a terminal, so the script's stdout
 * is redirected to a temp file and read back through the file API — no PTY
 * scraping, no ANSI, no prompt noise. The redirect is written to `.part` and
 * moved into place so a partial read is impossible.
 */
export async function hostExec(
  bb: BbPluginApi,
  hostId: string,
  script: string,
  options: { timeoutMs?: number } = {},
): Promise<string | null> {
  execCounter += 1;
  const out = `/tmp/bb-handoff-remote-${Date.now()}-${execCounter}.out`;
  const command = `{ ${script} ; } > ${shellQuote(`${out}.part`)} 2>/dev/null; mv ${shellQuote(`${out}.part`)} ${shellQuote(out)}`;
  let terminalId: string | null = null;
  try {
    const terminal = await bb.sdk.terminals.create({
      cols: 120,
      rows: 30,
      scope: { kind: "host_path", hostId, cwd: null },
      start: { mode: "command", command },
      title: "handoff: read agent sessions",
    });
    terminalId = terminal.id;
    const deadline = Date.now() + (options.timeoutMs ?? EXEC_TIMEOUT_MS);
    for (;;) {
      const session = await bb.sdk.terminals.get({ terminalId: terminal.id });
      if (session.status === "exited") break;
      if (Date.now() > deadline) return null;
      await sleep(EXEC_POLL_MS);
    }
    const file = await bb.sdk.files.read({ hostId, path: out });
    return file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  } catch {
    return null;
  } finally {
    if (terminalId) {
      await bb.sdk.terminals.close({ terminalId, mode: "force" }).catch(() => {});
    }
    // On a timeout the redirect never got moved into place, so the `.part`
    // file is the one that would otherwise be left behind.
    await bb.sdk.files.remove({ hostId, path: out }).catch(() => {});
    await bb.sdk.files.remove({ hostId, path: `${out}.part` }).catch(() => {});
  }
}

/** stat(1) differs between BSD and GNU; probe once, then emit `mtime|size|path`. */
const STAT_PRELUDE =
  'if stat -f %m . >/dev/null 2>&1; then S="-f %m|%z|%N"; else S="-c %Y|%s|%n"; fi; ' +
  'emit() { stat $S "$1"; }';

// --- Discovery --------------------------------------------------------------

export interface RemoteListing {
  sessions: FoundSession[];
  /** Stores that could not be read, for honest "nothing found" messages. */
  unavailable: string[];
}

/**
 * Build the discovery script for one working directory. Every store that can
 * be addressed from the cwd alone is listed by path; Codex, whose layout is by
 * date, is filtered by grepping each recent rollout's session_meta.
 */
export function buildListScript(home: string, cwd: string, codexScanLimit = 400): string {
  const claudeDir = `${home}/.claude/projects/${claudeProjectSlug(cwd)}`;
  const geminiDir = geminiChatsDir(cwd, home);
  const codexDir = `${home}/.codex/sessions`;
  const db = opencodeDbPath(home);
  // Every line is `agent \t sessionId \t <stat or payload>`; an empty id means
  // "derive it from the path", which only Gemini cannot do.
  return [
    STAT_PRELUDE,
    `d=${shellQuote(claudeDir)}; if [ -d "$d" ]; then for f in "$d"/*.jsonl; do [ -f "$f" ] && { printf 'claude\\t\\t'; emit "$f"; }; done; fi`,
    `d=${shellQuote(geminiDir)}; if [ -d "$d" ]; then for f in "$d"/session-*.json; do [ -f "$f" ] || continue; i=$(head -c 400 "$f" | tr -d '\\n' | sed -n 's/.*"sessionId"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1); printf 'gemini\\t%s\\t' "$i"; emit "$f"; done; fi`,
    `d=${shellQuote(codexDir)}; if [ -d "$d" ]; then find "$d" -type f -name 'rollout-*.jsonl' | sort -r | head -n ${codexScanLimit} | while read -r f; do head -c 65536 "$f" | grep -qF ${shellQuote(`"cwd":"${cwd}"`)} && { printf 'codex\\t\\t'; emit "$f"; }; done; fi`,
    `db=${shellQuote(db)}; if [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then printf 'opencode\\t\\t'; sqlite3 -readonly -json "$db" ${shellQuote(opencodeListSql(cwd))} | tr -d '\\n'; printf '\\n'; fi`,
  ].join("; ");
}

/** Session id from a store path, for the stores whose filenames carry one. */
function idFromPath(agent: AgentId, filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (agent === "claude") return base.replace(/\.jsonl$/, "");
  if (agent === "codex") {
    const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return match ? match[1]!.toLowerCase() : base.replace(/\.jsonl$/, "");
  }
  // Gemini's real id lives inside the file; the name holds a timestamp and the
  // id's last 8 characters, which is enough to identify a row for adoption.
  return base.replace(/^session-/, "").replace(/\.json$/, "");
}

/** Parse the discovery script's TSV back into session rows. */
export function parseListOutput(output: string, cwd: string): FoundSession[] {
  const sessions: FoundSession[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const agent = line.slice(0, tab) as AgentId;
    const afterAgent = line.slice(tab + 1);
    const idTab = afterAgent.indexOf("\t");
    if (idTab === -1) continue;
    const emittedId = afterAgent.slice(0, idTab).trim();
    const rest = afterAgent.slice(idTab + 1);
    if (agent === "opencode") {
      let rows: SessionRow[] = [];
      try {
        const parsed = JSON.parse(rest.trim() || "[]");
        if (Array.isArray(parsed)) rows = parsed as SessionRow[];
      } catch {
        continue;
      }
      for (const row of rows) {
        sessions.push({
          agent: "opencode",
          sessionId: row.id,
          filePath: `${row.id}`,
          modifiedAtMs: Number(row.time_updated) || 0,
          sizeBytes: 0,
          title: row.title?.startsWith("New session - ") ? null : (row.title ?? null),
          cwd: row.directory ?? cwd,
        });
      }
      continue;
    }
    // `mtimeSeconds|sizeBytes|absolutePath` — the path may contain "|", so the
    // first two separators are the only ones that count.
    const first = rest.indexOf("|");
    const second = rest.indexOf("|", first + 1);
    if (first === -1 || second === -1) continue;
    const mtime = Number(rest.slice(0, first));
    const size = Number(rest.slice(first + 1, second));
    const filePath = rest.slice(second + 1).trim();
    if (!filePath || !Number.isFinite(mtime)) continue;
    sessions.push({
      agent,
      sessionId: emittedId || idFromPath(agent, filePath),
      filePath,
      modifiedAtMs: mtime * 1000,
      sizeBytes: Number.isFinite(size) ? size : 0,
      title: null, // titles need the file's content; the list stays one round trip
      cwd,
    });
  }
  sessions.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return sessions;
}

/** Every adoptable session for one directory on another machine. */
export async function listRemoteSessions(
  ctx: RemoteContext,
  cwd: string,
  agentFilter?: AgentId | null,
): Promise<{ sessions: FoundSession[]; execFailed: boolean }> {
  const output = await hostExec(ctx.bb, ctx.hostId, buildListScript(ctx.home, cwd));
  if (output === null) return { sessions: [], execFailed: true };
  const sessions = parseListOutput(output, cwd);
  return {
    sessions: agentFilter ? sessions.filter((s) => s.agent === agentFilter) : sessions,
    execFailed: false,
  };
}

// --- Locating one session by id ---------------------------------------------

function pathsOfListing(listing: unknown): string[] {
  // deno-lint-ignore no-explicit-any
  const entries: any[] = Array.isArray(listing)
    ? listing
    : // deno-lint-ignore no-explicit-any
      ((listing as any)?.files ?? (listing as any)?.entries ?? []);
  const out: string[] = [];
  for (const entry of entries) {
    const p = typeof entry === "string" ? entry : (entry?.path ?? entry?.relativePath);
    if (typeof p === "string") out.push(p);
  }
  return out;
}

/**
 * Claude and Codex put the session id in the filename, so bb's remote fuzzy
 * file listing finds them without running anything on the machine.
 */
async function findByFilename(
  ctx: RemoteContext,
  agent: "claude" | "codex",
  sessionId: string,
): Promise<string | null> {
  const root = agent === "claude" ? `${ctx.home}/.claude/projects` : `${ctx.home}/.codex/sessions`;
  try {
    const listing = await ctx.bb.sdk.files.list({
      hostId: ctx.hostId,
      path: root,
      query: sessionId,
      limit: 5,
    });
    const hit = pathsOfListing(listing).find(
      (p) => p.endsWith(".jsonl") && p.toLowerCase().includes(sessionId.toLowerCase()),
    );
    return hit ? `${root}/${hit}` : null;
  } catch {
    return null;
  }
}

/** Gemini hides its id inside the file; grep for it, or match the name suffix. */
async function findGeminiByExec(ctx: RemoteContext, sessionId: string): Promise<string | null> {
  const root = `${ctx.home}/.gemini/tmp`;
  const script = [
    `r=${shellQuote(root)}; [ -d "$r" ] || exit 0`,
    `grep -rlF ${shellQuote(`"sessionId": "${sessionId}"`)} "$r" 2>/dev/null | head -n 3`,
    `find "$r" -type f -name ${shellQuote(`*${sessionId}*.json`)} 2>/dev/null | head -n 3`,
  ].join("; ");
  const output = await hostExec(ctx.bb, ctx.hostId, script);
  const hit = (output ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  return hit ?? null;
}

async function findOpencodeByExec(ctx: RemoteContext, sessionId: string): Promise<SessionRow[]> {
  const db = opencodeDbPath(ctx.home);
  const script = `db=${shellQuote(db)}; [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1 && sqlite3 -readonly -json "$db" ${shellQuote(opencodeFindSql(sessionId))} | tr -d '\\n'`;
  const output = await hostExec(ctx.bb, ctx.hostId, script);
  if (!output?.trim()) return [];
  try {
    const parsed = JSON.parse(output.trim());
    return Array.isArray(parsed) ? (parsed as SessionRow[]) : [];
  } catch {
    return [];
  }
}

/** Locate a session id across a machine's stores, newest match first. */
export async function findRemoteSession(
  ctx: RemoteContext,
  sessionId: string,
  agentHint: AgentId | null,
): Promise<FoundSession[]> {
  const wanted = (agent: AgentId) => !agentHint || agentHint === agent;
  const found: FoundSession[] = [];

  for (const agent of ["claude", "codex"] as const) {
    if (!wanted(agent)) continue;
    const path = await findByFilename(ctx, agent, sessionId);
    if (path) {
      found.push({
        agent,
        sessionId,
        filePath: path,
        modifiedAtMs: 0,
        sizeBytes: 0,
        title: null,
        cwd: null,
      });
    }
  }
  if (found.length === 0 && wanted("gemini")) {
    const path = await findGeminiByExec(ctx, sessionId);
    if (path) {
      found.push({
        agent: "gemini",
        sessionId,
        filePath: path,
        modifiedAtMs: 0,
        sizeBytes: 0,
        title: null,
        cwd: null,
      });
    }
  }
  if (found.length === 0 && wanted("opencode")) {
    for (const row of await findOpencodeByExec(ctx, sessionId)) {
      found.push({
        agent: "opencode",
        sessionId: row.id,
        filePath: row.id,
        modifiedAtMs: Number(row.time_updated) || 0,
        sizeBytes: 0,
        title: row.title ?? null,
        cwd: row.directory ?? null,
      });
    }
  }
  return found;
}

// --- Reading one session ----------------------------------------------------

async function readRemoteFile(ctx: RemoteContext, path: string): Promise<string> {
  const file = await ctx.bb.sdk.files.read({ hostId: ctx.hostId, path });
  return file.contentEncoding === "base64"
    ? Buffer.from(file.content, "base64").toString("utf8")
    : file.content;
}

/** Pull a session off the remote machine and parse it into a transcript. */
export async function readRemoteSession(
  ctx: RemoteContext,
  session: Pick<SessionSummary, "agent" | "filePath" | "sessionId">,
  options: { maxChars?: number } = {},
): Promise<ParsedSession> {
  const maxChars = options.maxChars ?? 150_000;
  if (session.agent === "opencode") {
    const db = opencodeDbPath(ctx.home);
    const sql = opencodeSql(session.sessionId);
    // One exec for all three queries; each result is a single JSON line.
    const script = [
      `db=${shellQuote(db)}`,
      `command -v sqlite3 >/dev/null 2>&1 || exit 0`,
      ...[sql.session, sql.messages, sql.parts].map(
        (statement) => `sqlite3 -readonly -json "$db" ${shellQuote(statement)} | tr -d '\\n'; printf '\\n'`,
      ),
    ].join("; ");
    const output = await hostExec(ctx.bb, ctx.hostId, script);
    const lines = (output ?? "").split("\n");
    const decode = (line: string | undefined): Record<string, unknown>[] => {
      try {
        const parsed = JSON.parse((line ?? "").trim() || "[]");
        return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
      } catch {
        return [];
      }
    };
    const sessions = decode(lines[0]) as unknown as SessionRow[];
    const row = sessions[0];
    if (!row) {
      throw new Error(
        `Could not read OpenCode session ${session.sessionId} on ${ctx.hostName} — is sqlite3 installed there?`,
      );
    }
    return parseOpencodeRows(
      { session: row, messages: decode(lines[1]), parts: decode(lines[2]) },
      `${db}#${row.id}`,
      { maxChars },
    );
  }

  const content = await readRemoteFile(ctx, session.filePath);
  if (session.agent === "claude") return parseClaudeContent(content, session.filePath, { maxChars });
  if (session.agent === "codex") return parseCodexContent(content, session.filePath, { maxChars });
  return parseGeminiContent(content, session.filePath, { maxChars });
}
