// Shared transcript model: agent adapters produce Blocks, this module renders
// them to markdown with a size budget. Pure logic, no bb API.

export type AgentId = "claude" | "codex" | "gemini";

export interface SessionSummary {
  agent: AgentId;
  sessionId: string;
  filePath: string;
  modifiedAtMs: number;
  sizeBytes: number;
  title: string | null;
}

export interface ParsedSession {
  agent: AgentId;
  agentLabel: string;
  sessionId: string;
  filePath: string;
  cwd: string | null;
  gitBranch: string | null;
  title: string | null;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  userMessageCount: number;
  assistantMessageCount: number;
  /** Markdown transcript, possibly truncated to the requested budget. */
  transcript: string;
  truncated: boolean;
}

/** A session located by id — carries its working directory when recoverable. */
export interface FoundSession extends SessionSummary {
  cwd: string | null;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** Preferred bb provider for the continued thread. */
  bbProviderId: string;
  list(cwd: string, home?: string): SessionSummary[];
  /**
   * Locate sessions by id or id prefix across ALL directories this agent has
   * sessions for. `cwdCandidates` helps agents whose session files don't
   * record a working directory (Gemini keys directories by hash).
   */
  find(idOrPrefix: string, options?: { home?: string; cwdCandidates?: string[] }): FoundSession[];
  parse(filePath: string, options?: { maxChars?: number }): ParsedSession;
}

export interface Block {
  role: "user" | "assistant" | "summary";
  text: string;
  tools: string[];
}

/** Accumulates blocks, merging consecutive assistant output into one block. */
export class BlockBuilder {
  readonly blocks: Block[] = [];

  addText(role: Block["role"], text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const previous = this.blocks[this.blocks.length - 1];
    if (previous && role === "assistant" && previous.role === "assistant") {
      previous.text = [previous.text, trimmed].filter(Boolean).join("\n\n");
    } else {
      this.blocks.push({ role, text: trimmed, tools: [] });
    }
  }

  addTool(tool: string): void {
    const previous = this.blocks[this.blocks.length - 1];
    if (previous && previous.role === "assistant") {
      previous.tools.push(tool);
    } else {
      this.blocks.push({ role: "assistant", text: "", tools: [tool] });
    }
  }
}

export function snippet(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function formatToolCall(name: string, input: unknown): string {
  let brief = "";
  try {
    brief = snippet(typeof input === "string" ? input : JSON.stringify(input ?? {}), 100);
  } catch {
    brief = "…";
  }
  return `${name}(${brief})`;
}

function renderBlock(block: Block): string {
  const heading =
    block.role === "user" ? "### User" : block.role === "assistant" ? "### Assistant" : "### Earlier session summary";
  const parts = [heading];
  if (block.text.trim()) parts.push(block.text.trim());
  if (block.tools.length > 0) parts.push(`_Tools used: ${block.tools.join(", ")}_`);
  return parts.join("\n\n");
}

export interface RenderedTranscript {
  transcript: string;
  truncated: boolean;
  userMessageCount: number;
  assistantMessageCount: number;
}

export function renderTranscript(blocks: Block[], maxChars: number): RenderedTranscript {
  const userMessageCount = blocks.filter((b) => b.role === "user" && b.text.trim()).length;
  const assistantMessageCount = blocks.filter((b) => b.role === "assistant").length;
  const rendered = blocks.map(renderBlock);
  const full = rendered.join("\n\n");
  if (full.length <= maxChars) {
    return { transcript: full, truncated: false, userMessageCount, assistantMessageCount };
  }

  // Keep the opening block (usually the original request) plus as much of the
  // tail as fits — recent context matters most for continuing the session.
  const headBudget = Math.min(rendered[0]?.length ?? 0, Math.floor(maxChars * 0.15));
  const head = (rendered[0] ?? "").slice(0, headBudget);
  const tail: string[] = [];
  let used = head.length;
  for (let i = rendered.length - 1; i >= 1; i -= 1) {
    const candidate = rendered[i]!;
    if (used + candidate.length + 2 > maxChars) break;
    tail.unshift(candidate);
    used += candidate.length + 2;
  }
  const omitted = rendered.length - 1 - tail.length;
  const marker = `\n\n_[… ${omitted} earlier message${omitted === 1 ? "" : "s"} omitted to fit the context budget …]_\n\n`;
  return {
    transcript: head + marker + tail.join("\n\n"),
    truncated: true,
    userMessageCount,
    assistantMessageCount,
  };
}

/**
 * Per-file cache keyed by mtime, for expensive header/title peeks during
 * discovery. Session files are append-mostly, so an unchanged mtime means the
 * cached peek is still valid; the whole cache resets rather than evicting.
 */
export class MtimeCache<T> {
  private readonly entries = new Map<string, { mtimeMs: number; value: T }>();
  constructor(private readonly maxEntries = 4096) {}

  get(filePath: string, mtimeMs: number, compute: () => T): T {
    const hit = this.entries.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = compute();
    if (this.entries.size >= this.maxEntries) this.entries.clear();
    this.entries.set(filePath, { mtimeMs, value });
    return value;
  }
}

/** Read the first `bytes` of a file as UTF-8 without loading the whole file. */
export function readHead(filePath: string, bytes: number, fsModule: typeof import("node:fs")): string | null {
  try {
    const fd = fsModule.openSync(filePath, "r");
    try {
      const buf = new Uint8Array(bytes);
      const read = fsModule.readSync(fd, buf, 0, buf.length, 0);
      return Buffer.from(buf.subarray(0, read)).toString("utf8");
    } finally {
      fsModule.closeSync(fd);
    }
  } catch {
    return null;
  }
}
