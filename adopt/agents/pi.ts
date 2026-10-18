// Pi sessions: ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl.
// The file is an append-only tree, NOT a linear transcript. Follow the last
// persisted entry's parent chain, as Pi does when reopening a session.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BlockBuilder,
  MtimeCache,
  formatToolCall,
  parseJsonLine,
  readHead,
  renderTranscript,
  snippet,
  type AgentAdapter,
  type FoundSession,
  type ParsedSession,
  type SessionSummary,
} from "../transcript";

export function piSessionSlug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** The environment belongs to the machine reading the store, never its peer. */
export function piSessionsRoot(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const expand = (value: string) => value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  if (env.PI_CODING_AGENT_SESSION_DIR) return path.resolve(expand(env.PI_CODING_AGENT_SESSION_DIR));
  const agentDir = env.PI_CODING_AGENT_DIR
    ? path.resolve(expand(env.PI_CODING_AGENT_DIR))
    : path.join(home, ".pi", "agent");
  return path.join(agentDir, "sessions");
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) =>
    block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
  ).join("\n\n");
}

interface PiInfo {
  sessionId: string;
  cwd: string;
  title: string | null;
}

const INFO_BYTES = 64 * 1024;
const infoCache = new MtimeCache<Promise<PiInfo | null>>();

async function readInfo(filePath: string, mtimeMs: number): Promise<PiInfo | null> {
  return infoCache.get(filePath, mtimeMs, async () => {
    const head = await readHead(filePath, INFO_BYTES, fs);
    if (head === null) return null;
    const rows = head.split("\n").map(parseJsonLine);
    const header = rows[0];
    if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
      return null;
    }
    let title: string | null = null;
    for (const row of rows) {
      const message = row?.message as Record<string, unknown> | undefined;
      if (row?.type === "message" && message?.role === "user") {
        const text = contentText(message.content);
        if (text.trim()) { title = snippet(text, 80); break; }
      }
    }
    // /name appends session_info, often far beyond the initial messages. Peek
    // at the tail too, without loading a multi-megabyte transcript per row.
    let tail = head;
    try {
      const file = await fs.promises.open(filePath, "r");
      try {
        const { size } = await file.stat();
        if (size > INFO_BYTES) {
          const buffer = Buffer.alloc(INFO_BYTES);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, size - INFO_BYTES);
          tail = buffer.subarray(0, bytesRead).toString("utf8");
        }
      } finally { await file.close(); }
    } catch { /* A live session can disappear during discovery. */ }
    for (const line of tail.split("\n")) {
      const row = parseJsonLine(line);
      if (row?.type === "session_info" && typeof row.name === "string" && row.name.trim()) {
        title = row.name;
      }
    }
    return { sessionId: header.id, cwd: header.cwd, title };
  });
}

/** One level of cwd directories, plus flat --session-dir stores. No symlinks. */
async function sessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.promises.readdir(root, { withFileTypes: true }).catch(() => [])) {
    const filePath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(filePath);
    else if (entry.isDirectory()) {
      for (const child of await fs.promises.readdir(filePath, { withFileTypes: true }).catch(() => [])) {
        if (child.isFile() && child.name.endsWith(".jsonl")) files.push(path.join(filePath, child.name));
      }
    }
  }
  return files;
}

async function discover(root: string, options: { cwd?: string; prefix?: string } = {}): Promise<FoundSession[]> {
  const out: FoundSession[] = [];
  for (const filePath of await sessionFiles(root)) {
    // Pi also allows custom ids, so don't assume UUIDs or derive identity from
    // the timestamp-prefixed filename. The header is authoritative.
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(filePath); } catch { continue; }
    if (!stat.isFile() || stat.size === 0) continue;
    const info = await readInfo(filePath, stat.mtimeMs);
    if (!info || (options.cwd && info.cwd !== options.cwd)) continue;
    if (options.prefix && !info.sessionId.toLowerCase().startsWith(options.prefix.toLowerCase())) continue;
    out.push({
      agent: "pi",
      sessionId: info.sessionId,
      filePath,
      cwd: info.cwd,
      title: info.title,
      modifiedAtMs: stat.mtimeMs,
      sizeBytes: stat.size,
    });
  }
  return out.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
}

export const piAdapter: AgentAdapter = {
  id: "pi",
  label: "Pi",
  bbProviderId: "pi",

  async list(cwd: string, home = os.homedir()): Promise<SessionSummary[]> {
    const root = piSessionsRoot(home);
    // Default stores are directly addressable by cwd. Overrides can be flat,
    // shared across projects, and must be filtered by the recorded cwd.
    return discover(process.env.PI_CODING_AGENT_SESSION_DIR ? root : path.join(root, piSessionSlug(cwd)), { cwd });
  },

  async find(idOrPrefix: string, options = {}): Promise<FoundSession[]> {
    return discover(piSessionsRoot(options.home ?? os.homedir()), { prefix: idOrPrefix });
  },

  async parse(filePath: string, options = {}): Promise<ParsedSession> {
    return parsePiContent(await fs.promises.readFile(filePath, "utf8"), filePath, options);
  },
};

function activeEntries(rows: Record<string, unknown>[], version: number): Record<string, unknown>[] {
  if (version === 1) return rows; // Legacy sessions were linear.
  const entries = new Map<string, Record<string, unknown>>();
  let leaf: Record<string, unknown> | undefined;
  for (const row of rows) {
    if (typeof row.id !== "string") continue;
    if (entries.has(row.id)) throw new Error(`Duplicate Pi session entry: ${row.id}`);
    entries.set(row.id, row);
    leaf = row;
  }
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (leaf) {
    const id = leaf.id as string;
    if (seen.has(id)) throw new Error(`Cycle in Pi session tree at ${id}`);
    seen.add(id);
    branch.push(leaf);
    if (leaf.parentId === null) break;
    if (typeof leaf.parentId !== "string" || !entries.has(leaf.parentId)) {
      throw new Error(`Missing parent in Pi session tree at ${id}`);
    }
    leaf = entries.get(leaf.parentId);
  }
  return branch.reverse();
}

/** Parse the same read-only transcript for both local and remote adoption. */
export function parsePiContent(raw: string, filePath: string, options: { maxChars?: number } = {}): ParsedSession {
  const rows = raw.split("\n").map(parseJsonLine).filter((row) => row !== null);
  const header = rows.shift();
  if (header?.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
    throw new Error(`Invalid Pi session header: ${filePath}`);
  }
  const version = header.version ?? 1;
  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`Unsupported Pi session version: ${String(version)}`);
  }
  const branch = activeEntries(rows, version);
  // Edits affect future context only. Honor the latest one on this branch so
  // an intentionally omitted/replaced message isn't resurrected by adoption.
  const edits = new Map<string, unknown>();
  for (const row of branch) {
    if (row.type === "context_edit" && typeof row.targetId === "string") {
      edits.set(row.targetId, row.replacement);
    }
  }
  const builder = new BlockBuilder();
  let title: string | null = null;
  let lastTimestamp = typeof header.timestamp === "string" ? header.timestamp : null;
  for (const row of branch) {
    if (typeof row.timestamp === "string") lastTimestamp = row.timestamp;
    if (row.type === "session_info" && typeof row.name === "string" && row.name.trim()) title = row.name;
    if ((row.type === "compaction" || row.type === "branch_summary") && typeof row.summary === "string") {
      builder.addText("summary", row.summary);
    }
    if (row.type !== "message") continue;
    const message = row.message as Record<string, unknown> | null;
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
    const replacement = edits.get(row.id as string);
    if (replacement === null) continue;
    const content = edits.has(row.id as string) ? replacement : message.content;
    builder.addText(message.role, contentText(content));
    if (message.role === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "toolCall" && typeof block.name === "string") {
          builder.addTool(formatToolCall(block.name, block.arguments));
        }
      }
    }
    // System prompts, thinking, tool output, extension state, and image bytes
    // aren't portable conversation text and must not leak into the handoff.
  }
  const rendered = renderTranscript(builder.blocks, options.maxChars ?? 150_000);
  const firstUser = builder.blocks.find((block) => block.role === "user");
  return {
    agent: "pi",
    agentLabel: "Pi",
    sessionId: header.id,
    filePath,
    cwd: header.cwd,
    gitBranch: null, // Pi headers do not record the git branch.
    title: title ?? (firstUser ? snippet(firstUser.text, 80) : null),
    firstTimestamp: typeof header.timestamp === "string" ? header.timestamp : null,
    lastTimestamp,
    ...rendered,
  };
}
