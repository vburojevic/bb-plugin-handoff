// Gemini CLI sessions: ~/.gemini/tmp/<sha256(cwd)>/chats/session-*.json
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  BlockBuilder,
  MtimeCache,
  renderTranscript,
  snippet,
  formatToolCall,
  type AgentAdapter,
  type FoundSession,
  type ParsedSession,
  type SessionSummary,
} from "../transcript";

function chatsDir(cwd: string, home: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex");
  return path.join(home, ".gemini", "tmp", hash, "chats");
}

interface GeminiMessage {
  type?: unknown;
  content?: unknown;
  toolCalls?: unknown;
  timestamp?: unknown;
}

interface GeminiSessionFile {
  sessionId?: unknown;
  startTime?: unknown;
  lastUpdated?: unknown;
  messages?: unknown;
}

function readSessionFile(filePath: string): GeminiSessionFile | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return typeof value === "object" && value !== null ? (value as GeminiSessionFile) : null;
  } catch {
    return null;
  }
}

function firstUserSnippet(data: GeminiSessionFile): string | null {
  if (!Array.isArray(data.messages)) return null;
  for (const message of data.messages as GeminiMessage[]) {
    if (message?.type === "user" && typeof message.content === "string" && message.content.trim()) {
      return snippet(message.content, 80);
    }
  }
  return null;
}

/** Discovery needs only id + title; cache them so list/find skip re-parsing. */
const summaryCache = new MtimeCache<{ sessionId: string | null; title: string | null } | null>();

function readSummary(
  filePath: string,
  mtimeMs: number,
): { sessionId: string | null; title: string | null } | null {
  return summaryCache.get(filePath, mtimeMs, () => {
    const data = readSessionFile(filePath);
    if (!data) return null;
    return {
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      title: firstUserSnippet(data),
    };
  });
}

export const geminiAdapter: AgentAdapter = {
  id: "gemini",
  label: "Gemini CLI",
  // bb has no Gemini provider; the continued thread runs on claude-code unless
  // overridden with --thread-provider.
  bbProviderId: "claude-code",

  list(cwd: string, home: string = os.homedir()): SessionSummary[] {
    const dir = chatsDir(cwd, home);
    if (!fs.existsSync(dir)) return [];
    const out: SessionSummary[] = [];
    for (const entry of fs.readdirSync(dir)) {
      if (!entry.startsWith("session-") || !entry.endsWith(".json")) continue;
      const filePath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      const summary = readSummary(filePath, stat.mtimeMs);
      if (!summary) continue;
      out.push({
        agent: "gemini",
        sessionId: summary.sessionId ?? entry.slice("session-".length, -".json".length),
        filePath,
        modifiedAtMs: stat.mtimeMs,
        sizeBytes: stat.size,
        title: summary.title,
      });
    }
    out.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    return out;
  },

  find(idOrPrefix: string, options: { home?: string; cwdCandidates?: string[] } = {}): FoundSession[] {
    const home = options.home ?? os.homedir();
    const tmpRoot = path.join(home, ".gemini", "tmp");
    if (!fs.existsSync(tmpRoot)) return [];
    // Session files don't record a cwd; the parent directory is sha256(cwd),
    // so recover it by hashing candidate directories.
    const hashToCwd = new Map<string, string>();
    for (const candidate of options.cwdCandidates ?? []) {
      hashToCwd.set(createHash("sha256").update(candidate).digest("hex"), candidate);
    }
    const needle = idOrPrefix.toLowerCase();
    const out: FoundSession[] = [];
    for (const hashDir of fs.readdirSync(tmpRoot)) {
      const dir = path.join(tmpRoot, hashDir, "chats");
      if (!fs.existsSync(dir)) continue;
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.startsWith("session-") || !entry.endsWith(".json")) continue;
        const filePath = path.join(dir, entry);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(filePath);
        } catch {
          continue;
        }
        const summary = readSummary(filePath, stat.mtimeMs);
        if (!summary?.sessionId) continue;
        if (!summary.sessionId.toLowerCase().startsWith(needle)) continue;
        out.push({
          agent: "gemini",
          sessionId: summary.sessionId,
          filePath,
          modifiedAtMs: stat.mtimeMs,
          sizeBytes: stat.size,
          title: summary.title,
          cwd: hashToCwd.get(hashDir) ?? null,
        });
      }
    }
    out.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    return out;
  },

  parse(filePath: string, options: { maxChars?: number } = {}): ParsedSession {
    const maxChars = options.maxChars ?? 150_000;
    const data = readSessionFile(filePath);
    if (!data) throw new Error(`Not a Gemini CLI session file: ${filePath}`);
    const builder = new BlockBuilder();
    const messages = Array.isArray(data.messages) ? (data.messages as GeminiMessage[]) : [];
    for (const message of messages) {
      const content = typeof message.content === "string" ? message.content : "";
      if (message.type === "user") {
        builder.addText("user", content);
      } else if (message.type === "gemini") {
        builder.addText("assistant", content);
        if (Array.isArray(message.toolCalls)) {
          for (const call of message.toolCalls) {
            if (typeof call !== "object" || call === null) continue;
            const tool = call as Record<string, unknown>;
            if (typeof tool.name === "string") builder.addTool(formatToolCall(tool.name, tool.args));
          }
        }
      }
    }

    const rendered = renderTranscript(builder.blocks, maxChars);
    const firstUser = builder.blocks.find((b) => b.role === "user" && b.text.trim());
    return {
      agent: "gemini",
      agentLabel: "Gemini CLI",
      sessionId: typeof data.sessionId === "string" ? data.sessionId : path.basename(filePath, ".json"),
      filePath,
      cwd: null, // not recorded in the session file; discovery already scoped it by cwd hash
      gitBranch: null,
      title: firstUser ? snippet(firstUser.text, 80) : null,
      firstTimestamp: typeof data.startTime === "string" ? data.startTime : null,
      lastTimestamp: typeof data.lastUpdated === "string" ? data.lastUpdated : null,
      userMessageCount: rendered.userMessageCount,
      assistantMessageCount: rendered.assistantMessageCount,
      transcript: rendered.transcript,
      truncated: rendered.truncated,
    };
  },
};
