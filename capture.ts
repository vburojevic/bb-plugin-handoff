// Session capture: page a thread's event log and project it into a
// provider-independent transcript, plus locate the provider's native session
// file (Claude Code / Codex) for raw-fidelity reference.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { projectInputs, renderInput } from "./capture-inputs";

export const CAPS = {
  reasoning: 2_000,
  commandOutput: 3_000,
  toolArguments: 1_500,
  toolResult: 2_500,
  webResult: 1_500,
  diff: 3_000,
  userMessage: 20_000,
  assistantMessage: 20_000,
  totalDocBytes: 4_000_000,
} as const;

export type EntryKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "command"
  | "files"
  | "web"
  | "plan"
  | "note";

export interface TranscriptEntry {
  seq: number;
  kind: EntryKind;
  title?: string;
  body: string;
  nested?: boolean;
}

/** Structural view of a thread event row — lets tests feed plain fixtures. */
export interface EventRowLike {
  seq: number;
  type: string;
  // deno-lint-ignore no-explicit-any
  data: any;
}

export interface ProjectedTranscript {
  entries: TranscriptEntry[];
  providerThreadId: string | null;
  turns: number;
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function stringifyUnknown(value: unknown, max: number): string {
  if (value == null) return "";
  if (typeof value === "string") return clip(value, max);
  try {
    return clip(JSON.stringify(value, null, 1), max);
  } catch {
    return clip(String(value), max);
  }
}

// deno-lint-ignore no-explicit-any
function renderItem(item: any): TranscriptEntry | null {
  const nested = Boolean(item.parentToolCallId);
  switch (item.type) {
    case "userMessage": {
      return { seq: 0, kind: "user", body: renderInput(item.content), nested };
    }
    case "agentMessage":
      return { seq: 0, kind: "assistant", body: clip(item.text ?? "", CAPS.assistantMessage), nested };
    case "reasoning": {
      const summary: string[] = item.summary ?? [];
      const content: string[] = item.content ?? [];
      const text = (summary.length > 0 ? summary : content).join("\n\n").trim();
      if (!text) return null;
      return { seq: 0, kind: "reasoning", body: clip(text, CAPS.reasoning), nested };
    }
    case "commandExecution": {
      const lines = [`$ ${item.command}`];
      if (item.aggregatedOutput) lines.push(clip(item.aggregatedOutput, CAPS.commandOutput));
      const meta: string[] = [];
      if (typeof item.exitCode === "number" && item.exitCode !== 0) meta.push(`exit ${item.exitCode}`);
      if (item.status && item.status !== "completed") meta.push(item.status);
      if (item.approvalStatus === "denied") meta.push("approval denied");
      if (meta.length > 0) lines.push(`[${meta.join(", ")}]`);
      return { seq: 0, kind: "command", title: firstLine(item.command), body: lines.join("\n"), nested };
    }
    case "toolCall": {
      const lines: string[] = [];
      if (item.arguments && Object.keys(item.arguments).length > 0) {
        lines.push(`arguments: ${stringifyUnknown(item.arguments, CAPS.toolArguments)}`);
      }
      if (item.result !== undefined) lines.push(`result: ${stringifyUnknown(item.result, CAPS.toolResult)}`);
      if (item.error) lines.push(`error: ${clip(item.error, CAPS.toolResult)}`);
      if (item.status && item.status !== "completed") lines.push(`[${item.status}]`);
      const server = item.server ? `${item.server}.` : "";
      return { seq: 0, kind: "tool", title: `${server}${item.tool}`, body: lines.join("\n"), nested };
    }
    case "fileChange": {
      const lines: string[] = [];
      let diffBudget = CAPS.diff;
      for (const change of item.changes ?? []) {
        const move = change.movePath ? ` → ${change.movePath}` : "";
        lines.push(`${change.kind}: ${change.path}${move}`);
        if (change.diff && diffBudget > 0) {
          const piece = clip(change.diff, diffBudget);
          diffBudget -= piece.length;
          lines.push("```diff", piece, "```");
        }
      }
      if (item.status && item.status !== "completed") lines.push(`[${item.status}]`);
      return { seq: 0, kind: "files", title: "File changes", body: lines.join("\n"), nested };
    }
    case "webSearch": {
      const lines = [`queries: ${(item.queries ?? []).join("; ")}`];
      if (item.resultText) lines.push(clip(item.resultText, CAPS.webResult));
      return { seq: 0, kind: "web", title: "Web search", body: lines.join("\n"), nested };
    }
    case "webFetch": {
      const lines = [`url: ${item.url}`];
      if (item.prompt) lines.push(`prompt: ${clip(item.prompt, 300)}`);
      if (item.resultText) lines.push(clip(item.resultText, CAPS.webResult));
      return { seq: 0, kind: "web", title: "Web fetch", body: lines.join("\n"), nested };
    }
    case "imageView":
      return { seq: 0, kind: "note", body: `[viewed image: ${item.path}]`, nested };
    case "plan":
      return { seq: 0, kind: "plan", title: "Plan", body: clip(item.text ?? "", CAPS.assistantMessage), nested };
    case "contextCompaction":
      return { seq: 0, kind: "note", body: "— provider context was compacted here —", nested };
    case "backgroundTask": {
      const label = item.workflowName ? `${item.taskType} (${item.workflowName})` : item.taskType;
      return {
        seq: 0,
        kind: "note",
        body: `[background task ${label}: ${item.description} — ${item.taskStatus}]`,
        nested,
      };
    }
    default:
      // Keep unfamiliar records visible; the unabridged archive preserves all fields.
      return { seq: 0, kind: "note", title: String(item.type),
        body: `[${String(item.type)}]\n${stringifyUnknown(item, CAPS.toolResult)}`, nested };
  }
}

function firstLine(text: string): string {
  const line = (text ?? "").split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/** Project raw thread events into an ordered transcript. Pure. */
export function projectEvents(rows: EventRowLike[]): ProjectedTranscript {
  const sorted = [...rows].sort((a, b) => a.seq - b.seq);
  const inputs = projectInputs(sorted);
  const itemOrder: string[] = [];
  // deno-lint-ignore no-explicit-any
  const items = new Map<string, { seq: number; item: any }>();
  const notes: TranscriptEntry[] = [];
  let providerThreadId: string | null = null;
  let turns = 0;

  for (const row of sorted) {
    const data = row.data ?? {};
    switch (row.type) {
      case "thread/identity":
        providerThreadId = data.providerThreadId ?? providerThreadId;
        break;
      case "turn/started":
        providerThreadId = data.providerThreadId ?? providerThreadId;
        if (!data.parentToolCallId) turns += 1;
        break;
      case "item/started":
      case "item/completed":
      case "item/backgroundTask/completed":
      case "item/delegation/completed": {
        const item = data.item;
        if (!item?.id) break;
        const existing = items.get(item.id);
        if (existing) existing.item = { ...existing.item, ...item };
        else {
          items.set(item.id, { seq: row.seq, item });
          itemOrder.push(item.id);
        }
        break;
      }
      case "turn/completed": {
        if (data.status === "failed") {
          const message = data.error?.message ? `: ${data.error.message}` : "";
          notes.push({ seq: row.seq, kind: "note", body: `[turn failed${message}]` });
        } else if (data.status === "interrupted") {
          notes.push({ seq: row.seq, kind: "note", body: "[turn interrupted by the user]" });
        }
        break;
      }
      case "thread/compacted":
        notes.push({ seq: row.seq, kind: "note", body: "— provider context was compacted here —" });
        break;
      default:
        break;
    }
  }

  const entries: TranscriptEntry[] = [];
  for (const id of itemOrder) {
    const record = items.get(id);
    if (!record) continue;
    const entry = renderItem(record.item);
    if (entry && !(entry.kind === "user" && !entry.nested && inputs.isEcho(record.seq, entry.body))) {
      entries.push({ ...entry, seq: record.seq });
    }
  }
  entries.push(...notes, ...inputs.entries);
  entries.sort((a, b) => a.seq - b.seq);
  return { entries, providerThreadId, turns };
}

// --- Native session file discovery -----------------------------------------

/** `/Users/x/...` or `/home/x/...` → that user's home directory. */
export function deriveHomeDir(workspacePath: string | null): string | null {
  if (!workspacePath) return null;
  const match = /^((?:\/Users|\/home)\/[^/]+)(?:\/|$)/.exec(workspacePath);
  return match ? match[1] : null;
}

/** Claude Code project-directory slug: every non [A-Za-z0-9-] char becomes "-". */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export interface NativeSessionQuery {
  providerId: string;
  providerThreadId: string | null;
  hostId: string | undefined;
  workspacePath: string | null;
}

/**
 * Best-effort absolute path of the provider's raw session transcript on the
 * environment host. Null when unknown provider, underivable home, or missing.
 */
export async function findNativeSessionPath(
  bb: BbPluginApi,
  query: NativeSessionQuery,
): Promise<string | null> {
  const { providerId, providerThreadId, hostId, workspacePath } = query;
  if (!providerThreadId || !workspacePath) return null;
  const home = deriveHomeDir(workspacePath);
  if (!home) return null;
  try {
    if (providerId === "claude-code") {
      const dir = `${home}/.claude/projects/${claudeProjectSlug(workspacePath)}`;
      const listing = await bb.sdk.files.list({ hostId, path: dir, query: providerThreadId, limit: 5 });
      const hit = pickJsonl(listing, providerThreadId);
      return hit ? `${dir}/${hit}` : null;
    }
    if (providerId === "codex") {
      const dir = `${home}/.codex/sessions`;
      const listing = await bb.sdk.files.list({ hostId, path: dir, query: providerThreadId, limit: 5 });
      const hit = pickJsonl(listing, providerThreadId);
      return hit ? `${dir}/${hit}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

function pickJsonl(listing: unknown, sessionId: string): string | null {
  // deno-lint-ignore no-explicit-any
  const files: any[] = Array.isArray(listing) ? listing : ((listing as any)?.files ?? (listing as any)?.entries ?? []);
  for (const file of files) {
    const path: string | undefined = typeof file === "string" ? file : file?.path ?? file?.relativePath;
    if (path && path.includes(sessionId) && path.endsWith(".jsonl")) return path;
  }
  return null;
}

// --- Full capture ------------------------------------------------------------

export interface CapturedSession {
  /** Full available BB events within the capture boundary, never rendered or clipped. */
  rawEvents?: EventRowLike[];
  threadId: string;
  title: string;
  providerId: string;
  projectId: string;
  environmentId: string | null;
  hostId: string | undefined;
  workspacePath: string | null;
  branchName: string | null;
  providerThreadId: string | null;
  entries: TranscriptEntry[];
  turns: number;
  eventCount: number;
  latestOutput: string | null;
  nativeSessionPath: string | null;
  /** Event-seq cutoff of a partial capture (anchored at a chat message); null = full thread. */
  untilSeq: number | null;
}

export interface CaptureOptions {
  /**
   * Only include events with `seq <= untilSeq` — a partial capture anchored at
   * one chat message (`ThreadChatMessageReference.sourceSeqEnd`).
   */
  untilSeq?: number;
}

// BB rejects event pages larger than 100; page through the complete history.
const EVENT_PAGE_SIZE = 100;

export async function captureThread(
  bb: BbPluginApi,
  threadId: string,
  options?: CaptureOptions,
): Promise<CapturedSession> {
  // deno-lint-ignore no-explicit-any
  const thread = (await bb.sdk.threads.get({ threadId })) as any;
  const environmentId: string | null = thread.environmentId ?? null;
  let workspacePath: string | null = null;
  let branchName: string | null = null;
  let hostId: string | undefined;
  if (environmentId) {
    try {
      const environment = await bb.sdk.environments.get({ environmentId });
      workspacePath = environment.path;
      branchName = environment.branchName;
      hostId = environment.hostId;
    } catch {
      // Environment may be destroyed; capture still works from events.
    }
  }

  const rows: EventRowLike[] = [];
  let afterSeq: string | undefined;
  const untilSeq = options?.untilSeq ?? null;
  for (;;) {
    const page = (await bb.sdk.threads.events.list({
      threadId,
      afterSeq,
      limit: String(EVENT_PAGE_SIZE),
    })) as unknown as EventRowLike[];
    const scoped = untilSeq != null ? page.filter((row) => row.seq <= untilSeq) : page;
    rows.push(...scoped);
    if (page.length < EVENT_PAGE_SIZE) break;
    // A page that reached past the cutoff means nothing relevant comes after.
    if (untilSeq != null && scoped.length < page.length) break;
    const nextSeq = page[page.length - 1]!.seq;
    if (!Number.isSafeInteger(nextSeq) || nextSeq <= Number(afterSeq ?? 0)) {
      throw new Error("Thread event pagination did not advance; refusing an incomplete capture.");
    }
    afterSeq = String(nextSeq);
  }

  const { entries, providerThreadId, turns } = projectEvents(rows);

  // Never mix a newer thread-level output into an earlier event snapshot.
  const latestOutput = [...entries].reverse()
    .find((entry) => entry.kind === "assistant" && !entry.nested)?.body ?? null;

  const providerId: string = thread.providerId ?? "unknown";
  const nativeSessionPath = untilSeq != null ? null : await findNativeSessionPath(bb, {
    providerId,
    providerThreadId,
    hostId,
    workspacePath,
  });

  return {
    rawEvents: rows,
    threadId,
    title: thread.title ?? thread.titleFallback ?? threadId,
    providerId,
    projectId: thread.projectId,
    environmentId,
    hostId,
    workspacePath,
    branchName,
    providerThreadId,
    entries,
    turns,
    eventCount: rows.length,
    latestOutput,
    nativeSessionPath,
    untilSeq,
  };
}
