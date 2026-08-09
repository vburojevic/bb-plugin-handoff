// Codex CLI sessions: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// Files are organized by date, not directory — the session's cwd lives in the
// first line's session_meta payload, so discovery scans newest files first.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BlockBuilder,
  MtimeCache,
  parseJsonLine,
  readHead,
  renderTranscript,
  snippet,
  formatToolCall,
  type AgentAdapter,
  type FoundSession,
  type ParsedSession,
  type SessionSummary,
} from "../transcript";

const SCAN_LIMIT = 1500; // newest rollout files whose session_meta we inspect

function sessionsRoot(home: string): string {
  return path.join(home, ".codex", "sessions");
}

function walkJsonlFiles(dir: string): { filePath: string; mtimeMs: number; sizeBytes: number }[] {
  const out: { filePath: string; mtimeMs: number; sizeBytes: number }[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.size > 0) out.push({ filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
        } catch {
          // ignore files that vanish mid-scan
        }
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

interface RolloutInfo {
  sessionId: string | null;
  cwd: string | null;
  title: string | null;
}

// The session_meta first line embeds the agent's full base instructions and
// can be tens of KB — read generously so it and the first messages fit.
const INFO_HEAD_BYTES = 512 * 1024;
const infoCache = new MtimeCache<RolloutInfo>();

/** One cached head-read per file: session_meta (id + cwd) and the title. */
function readInfo(filePath: string, mtimeMs: number): RolloutInfo {
  return infoCache.get(filePath, mtimeMs, () => {
    const head = readHead(filePath, INFO_HEAD_BYTES, fs);
    if (head === null) return { sessionId: null, cwd: null, title: null };
    const lines = head.split("\n");
    const info: RolloutInfo = { sessionId: null, cwd: null, title: null };
    const meta = parseJsonLine(lines[0] ?? "");
    if (meta && meta.type === "session_meta") {
      const payload = meta.payload as Record<string, unknown> | undefined;
      if (typeof payload?.id === "string") info.sessionId = payload.id;
      else if (typeof payload?.session_id === "string") info.sessionId = payload.session_id;
      if (typeof payload?.cwd === "string") info.cwd = payload.cwd;
    }
    for (let i = 1; i < lines.length && info.title === null; i += 1) {
      const row = parseJsonLine(lines[i]!);
      if (!row || row.type !== "response_item") continue;
      const payload = row.payload as Record<string, unknown> | undefined;
      if (!payload || payload.type !== "message" || payload.role !== "user") continue;
      const text = messageText(payload);
      if (text.trim() && !isInjectedUserText(text)) info.title = snippet(text, 80);
    }
    return info;
  });
}

/**
 * Injected context arrives as user-role messages wrapped in XML-ish tags
 * (<user_instructions>, <environment_context>, <recommended_plugins>, …) —
 * real user prompts don't start with a bare snake_case tag.
 */
function isInjectedUserText(text: string): boolean {
  return /^<[a-z][a-z0-9_]*>/.test(text.trimStart());
}

function messageText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if ((block.type === "input_text" || block.type === "output_text") && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  return texts.join("\n\n");
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  label: "Codex",
  bbProviderId: "codex",

  list(cwd: string, home: string = os.homedir()): SessionSummary[] {
    const root = sessionsRoot(home);
    if (!fs.existsSync(root)) return [];
    const out: SessionSummary[] = [];
    const files = walkJsonlFiles(root).slice(0, SCAN_LIMIT);
    for (const file of files) {
      const info = readInfo(file.filePath, file.mtimeMs);
      if (info.cwd !== cwd || !info.sessionId) continue;
      out.push({
        agent: "codex",
        sessionId: info.sessionId,
        filePath: file.filePath,
        modifiedAtMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
        title: info.title,
      });
    }
    return out;
  },

  find(idOrPrefix: string, options: { home?: string; cwdCandidates?: string[] } = {}): FoundSession[] {
    const root = sessionsRoot(options.home ?? os.homedir());
    if (!fs.existsSync(root)) return [];
    // Rollout filenames embed the session id: rollout-<timestamp>-<id>.jsonl
    const needle = idOrPrefix.toLowerCase();
    const out: FoundSession[] = [];
    for (const file of walkJsonlFiles(root)) {
      const base = path.basename(file.filePath, ".jsonl");
      const idPart = base.replace(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "");
      if (!idPart.toLowerCase().startsWith(needle)) continue;
      const info = readInfo(file.filePath, file.mtimeMs);
      if (!info.sessionId) continue;
      out.push({
        agent: "codex",
        sessionId: info.sessionId,
        filePath: file.filePath,
        modifiedAtMs: file.mtimeMs,
        sizeBytes: file.sizeBytes,
        title: info.title,
        cwd: info.cwd,
      });
    }
    return out;
  },

  parse(filePath: string, options: { maxChars?: number } = {}): ParsedSession {
    return parseCodexContent(fs.readFileSync(filePath, "utf8"), filePath, options);
  },
};

/** Parse a Codex rollout session from its JSONL content (local or remote read). */
export function parseCodexContent(
  raw: string,
  filePath: string,
  options: { maxChars?: number } = {},
): ParsedSession {
  {
    const maxChars = options.maxChars ?? 150_000;
    const builder = new BlockBuilder();
    let sessionId = path.basename(filePath, ".jsonl");
    let cwd: string | null = null;
    let gitBranch: string | null = null;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;

    for (const line of raw.split("\n")) {
      const row = parseJsonLine(line);
      if (!row) continue;
      if (typeof row.timestamp === "string") {
        firstTimestamp ??= row.timestamp;
        lastTimestamp = row.timestamp;
      }
      const payload = row.payload as Record<string, unknown> | undefined;
      if (!payload) continue;

      if (row.type === "session_meta") {
        if (typeof payload.id === "string") sessionId = payload.id;
        else if (typeof payload.session_id === "string") sessionId = payload.session_id;
        if (typeof payload.cwd === "string") cwd ??= payload.cwd;
        const git = payload.git as Record<string, unknown> | undefined;
        if (git && typeof git.branch === "string") gitBranch = git.branch;
        continue;
      }
      if (row.type !== "response_item") continue;

      if (payload.type === "message") {
        const text = messageText(payload);
        if (payload.role === "user") {
          if (!isInjectedUserText(text)) builder.addText("user", text);
        } else if (payload.role === "assistant") {
          builder.addText("assistant", text);
        }
        // developer messages are injected instructions/context — skipped
      } else if (payload.type === "function_call" && typeof payload.name === "string") {
        builder.addTool(formatToolCall(payload.name, payload.arguments));
      } else if (payload.type === "local_shell_call") {
        const action = payload.action as Record<string, unknown> | undefined;
        const command = Array.isArray(action?.command) ? action.command.join(" ") : "";
        builder.addTool(formatToolCall("shell", command));
      }
      // reasoning / function_call_output rows are omitted from the transcript
    }

    const rendered = renderTranscript(builder.blocks, maxChars);
    const firstUser = builder.blocks.find((b) => b.role === "user" && b.text.trim());
    return {
      agent: "codex",
      agentLabel: "Codex",
      sessionId,
      filePath,
      cwd,
      gitBranch,
      title: firstUser ? snippet(firstUser.text, 80) : null,
      firstTimestamp,
      lastTimestamp,
      userMessageCount: rendered.userMessageCount,
      assistantMessageCount: rendered.assistantMessageCount,
      transcript: rendered.transcript,
      truncated: rendered.truncated,
    };
  }
}
