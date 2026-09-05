// Claude Code sessions: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl
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

function projectDir(cwd: string, home: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(home, ".claude", "projects", slug);
}

/** The session's cwd is recorded on its message rows. */
async function peekCwd(filePath: string): Promise<string | null> {
  const head = await readHead(filePath, 256 * 1024, fs);
  if (head === null) return null;
  for (const line of head.split("\n")) {
    const row = parseJsonLine(line);
    if (row && typeof row.cwd === "string") return row.cwd;
  }
  return null;
}

function extractContent(content: unknown): { text: string; tools: string[] } {
  if (typeof content === "string") return { text: content, tools: [] };
  if (!Array.isArray(content)) return { text: "", tools: [] };
  const texts: string[] = [];
  const tools: string[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block.type === "tool_use" && typeof block.name === "string") {
      tools.push(formatToolCall(block.name, block.input));
    }
    // thinking and tool_result blocks are intentionally omitted
  }
  return { text: texts.join("\n\n"), tools };
}

async function peekTitle(filePath: string): Promise<string | null> {
  const head = await readHead(filePath, 64 * 1024, fs);
  if (head === null) return null;
  let fallback: string | null = null;
  for (const line of head.split("\n")) {
    const row = parseJsonLine(line);
    if (!row) continue;
    if (row.type === "ai-title" && typeof row.aiTitle === "string") return row.aiTitle;
    if (fallback === null && row.type === "user" && row.isMeta !== true && row.isSidechain !== true) {
      const { text } = extractContent((row.message as { content?: unknown } | undefined)?.content);
      if (text.trim() && !text.trimStart().startsWith("<")) fallback = snippet(text, 80);
    }
  }
  return fallback;
}

const titleCache = new MtimeCache<Promise<string | null>>();
const cwdCache = new MtimeCache<Promise<string | null>>();

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  label: "Claude Code",
  bbProviderId: "claude-code",

  async list(cwd: string, home: string = os.homedir()): Promise<SessionSummary[]> {
    const dir = projectDir(cwd, home);
    const out: SessionSummary[] = [];
    for (const entry of await fs.promises.readdir(dir).catch(() => [])) {
      if (!entry.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, entry);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size === 0) continue;
      out.push({
        agent: "claude",
        sessionId: entry.slice(0, -".jsonl".length),
        filePath,
        modifiedAtMs: stat.mtimeMs,
        sizeBytes: stat.size,
        title: await titleCache.get(filePath, stat.mtimeMs, () => peekTitle(filePath)),
      });
    }
    out.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    return out;
  },

  async find(idOrPrefix: string, options: { home?: string; cwdCandidates?: string[] } = {}): Promise<FoundSession[]> {
    const home = options.home ?? os.homedir();
    const root = path.join(home, ".claude", "projects");
    const needle = idOrPrefix.toLowerCase();
    const out: FoundSession[] = [];
    for (const dir of await fs.promises.readdir(root).catch(() => [])) {
      const dirPath = path.join(root, dir);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(dirPath);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl") || !entry.toLowerCase().startsWith(needle)) continue;
        const filePath = path.join(dirPath, entry);
        let stat: fs.Stats;
        try {
          stat = await fs.promises.stat(filePath);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.size === 0) continue;
        out.push({
          agent: "claude",
          sessionId: entry.slice(0, -".jsonl".length),
          filePath,
          modifiedAtMs: stat.mtimeMs,
          sizeBytes: stat.size,
          title: await titleCache.get(filePath, stat.mtimeMs, () => peekTitle(filePath)),
          cwd: await cwdCache.get(filePath, stat.mtimeMs, () => peekCwd(filePath)),
        });
      }
    }
    out.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
    return out;
  },

  async parse(filePath: string, options: { maxChars?: number } = {}): Promise<ParsedSession> {
    return parseClaudeContent(await fs.promises.readFile(filePath, "utf8"), filePath, options);
  },
};

/** Parse a Claude Code session from its JSONL content (local or remote read). */
export function parseClaudeContent(
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
    let title: string | null = null;
    let firstTimestamp: string | null = null;
    let lastTimestamp: string | null = null;

    for (const line of raw.split("\n")) {
      const row = parseJsonLine(line);
      if (!row) continue;
      if (typeof row.sessionId === "string") sessionId = row.sessionId;
      if (typeof row.timestamp === "string") {
        firstTimestamp ??= row.timestamp;
        lastTimestamp = row.timestamp;
      }
      if (row.type === "ai-title" && typeof row.aiTitle === "string") {
        title = row.aiTitle;
        continue;
      }
      if (row.type === "summary" && typeof row.summary === "string") {
        builder.addText("summary", row.summary);
        continue;
      }
      if (row.type !== "user" && row.type !== "assistant") continue;
      if (row.isSidechain === true || row.isMeta === true) continue;
      if (typeof row.cwd === "string") cwd ??= row.cwd;
      if (typeof row.gitBranch === "string" && row.gitBranch) gitBranch = row.gitBranch;

      const { text, tools } = extractContent(
        (row.message as { content?: unknown } | undefined)?.content,
      );
      if (row.type === "user") {
        builder.addText("user", text);
      } else {
        builder.addText("assistant", text);
        for (const tool of tools) builder.addTool(tool);
      }
    }

    const rendered = renderTranscript(builder.blocks, maxChars);
    if (title === null) {
      const firstUser = builder.blocks.find((b) => b.role === "user" && b.text.trim());
      if (firstUser) title = snippet(firstUser.text, 80);
    }
    return {
      agent: "claude",
      agentLabel: "Claude Code",
      sessionId,
      filePath,
      cwd,
      gitBranch,
      title,
      firstTimestamp,
      lastTimestamp,
      userMessageCount: rendered.userMessageCount,
      assistantMessageCount: rendered.assistantMessageCount,
      transcript: rendered.transcript,
      truncated: rendered.truncated,
    };
  }
}
