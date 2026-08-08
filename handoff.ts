// Handoff delivery: render the captured session into a markdown handoff
// document, upload it as a project attachment, and spawn the target-provider
// thread seeded with it.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { CAPS, captureThread, type CapturedSession, type TranscriptEntry } from "./capture";

export type WorkspaceMode = "reuse" | "worktree" | "personal";

export interface HandoffRequest {
  sourceThreadId: string;
  providerId: string;
  model?: string;
  workspace: WorkspaceMode;
  extraInstructions?: string;
  /** Capture only events up to this seq (anchored at a chat message). */
  untilSeq?: number;
}

export interface HandoffRecord {
  sourceThreadId: string;
  sourceProvider: string;
  targetThreadId: string;
  targetProvider: string;
  model: string | null;
  workspace: WorkspaceMode;
  at: number;
}

export const REALTIME_CHANNEL = "handoff:progress";

function renderEntry(entry: TranscriptEntry, sourceProvider: string): string {
  const nested = entry.nested ? " (subagent)" : "";
  switch (entry.kind) {
    case "user":
      return `### User\n\n${entry.body}`;
    case "assistant":
      return `### Assistant (${sourceProvider})${nested}\n\n${entry.body}`;
    case "reasoning":
      return `**[thinking]**${nested}\n\n> ${entry.body.replaceAll("\n", "\n> ")}`;
    case "command":
      return `**Ran command**${nested}\n\n\`\`\`\n${entry.body}\n\`\`\``;
    case "tool":
      return `**Tool: ${entry.title ?? "unknown"}**${nested}\n\n\`\`\`\n${entry.body}\n\`\`\``;
    case "files":
      return `**${entry.title ?? "File changes"}**${nested}\n\n${entry.body}`;
    case "web":
      return `**${entry.title ?? "Web"}**${nested}\n\n${entry.body}`;
    case "plan":
      return `**Proposed plan**${nested}\n\n${entry.body}`;
    case "note":
      return `> ${entry.body}`;
  }
}

export function renderHandoff(captured: CapturedSession, capturedAt: Date): string {
  const header = [
    "# Session handoff",
    "",
    `- Source thread: ${captured.title} (\`${captured.threadId}\`)`,
    `- Source provider: ${captured.providerId}`,
    `- Workspace: ${captured.workspacePath ?? "(none)"}${captured.branchName ? ` (branch \`${captured.branchName}\`)` : ""}`,
    `- Captured: ${capturedAt.toISOString()} — ${captured.turns} turns, ${captured.entries.length} transcript entries`,
    captured.untilSeq != null
      ? `- Scope: partial capture — the conversation only up to a message the user selected (events up to seq ${captured.untilSeq}); anything the source thread did after that message is intentionally excluded`
      : null,
    `- Native provider session file: ${captured.nativeSessionPath ? `\`${captured.nativeSessionPath}\`` : "(not found)"}`,
    "",
    "## How to continue",
    "",
    "You are taking over this session from the provider named above.",
    "",
    "1. Read the full transcript below before doing anything else.",
    "2. The workspace path above holds the live working state — check `git status` and `git log` there for uncommitted work.",
    "3. Continue from where the previous agent left off. Do not redo completed steps; honor decisions already made unless the user says otherwise.",
    captured.nativeSessionPath
      ? "4. If you need raw detail the transcript truncated, the native session file above contains the source provider's full session (JSONL)."
      : null,
    "",
  ].filter((line) => line !== null).join("\n");

  const latest = [
    "",
    "## Latest result",
    "",
    captured.latestOutput?.trim() || "(no final output captured)",
    "",
  ].join("\n");

  const rendered = captured.entries.map((entry) => renderEntry(entry, captured.providerId));
  const transcript = fitTranscript(rendered, CAPS.totalDocBytes - header.length - latest.length);

  return `${header}${latest}\n## Transcript\n\n${transcript}\n`;
}

/** Keep the head and tail of the transcript when the whole thing won't fit. */
export function fitTranscript(blocks: string[], budget: number): string {
  const joined = blocks.join("\n\n---\n\n");
  if (joined.length <= budget) return joined;

  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const headCount = Math.min(2, blocks.length);
  for (let i = 0; i < headCount; i++) {
    head.push(blocks[i]!);
    used += blocks[i]!.length + 10;
  }
  for (let i = blocks.length - 1; i >= headCount; i--) {
    const block = blocks[i]!;
    if (used + block.length + 10 > budget) break;
    tail.unshift(block);
    used += block.length + 10;
  }
  const dropped = blocks.length - head.length - tail.length;
  return [...head, `> [${dropped} earlier entries omitted to fit the handoff size budget]`, ...tail].join(
    "\n\n---\n\n",
  );
}

export function buildIntroPrompt(captured: CapturedSession, request: HandoffRequest): string {
  const lines = [
    `You are taking over an in-progress agent session handed off from ${captured.providerId}.`,
    "Read the attached handoff document in full — it contains the complete conversation transcript and the current state of the work.",
    "Then reply with one short paragraph confirming where the work stands, and continue from that point. Do not redo completed work.",
  ];
  if (request.extraInstructions?.trim()) {
    lines.push("", `Additional instructions from the user: ${request.extraInstructions.trim()}`);
  }
  return lines.join("\n");
}

// deno-lint-ignore no-explicit-any
function resolveEnvironment(request: HandoffRequest, captured: CapturedSession): any {
  if (request.workspace === "reuse") {
    if (!captured.environmentId) {
      throw new Error("Source thread has no environment to reuse — pick worktree or personal.");
    }
    return { type: "reuse", environmentId: captured.environmentId };
  }
  if (request.workspace === "worktree") {
    return {
      type: "host",
      hostId: captured.hostId,
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    };
  }
  return { type: "host", hostId: captured.hostId, workspace: { type: "personal" } };
}

export interface HandoffResult {
  newThreadId: string;
  attachmentPath: string;
  docBytes: number;
}

export async function startHandoff(bb: BbPluginApi, request: HandoffRequest): Promise<HandoffResult> {
  const publish = (stage: string, extra?: Record<string, unknown>) =>
    bb.realtime.publish(REALTIME_CHANNEL, { sourceThreadId: request.sourceThreadId, stage, ...extra });

  publish("capturing");
  const captured = await captureThread(bb, request.sourceThreadId, { untilSeq: request.untilSeq });
  publish("rendering");
  const doc = renderHandoff(captured, new Date());
  const bytes = new TextEncoder().encode(doc);

  publish("uploading");
  const uploaded = await bb.sdk.projects.attachments.upload({
    projectId: captured.projectId,
    clientFile: bytes,
    filename: `handoff-${captured.threadId}-${Date.now()}.md`,
    mimeType: "text/markdown",
  });

  publish("spawning");
  const thread = await bb.sdk.threads.spawn({
    projectId: captured.projectId,
    providerId: request.providerId,
    ...(request.model ? { model: request.model } : {}),
    environment: resolveEnvironment(request, captured),
    title: `${captured.untilSeq != null ? "Handoff from message" : "Handoff"}: ${captured.title}`,
    input: [
      { type: "text", text: buildIntroPrompt(captured, request), mentions: [] },
      {
        type: "localFile",
        path: uploaded.path,
        name: uploaded.name,
        sizeBytes: uploaded.sizeBytes,
        ...(uploaded.mimeType ? { mimeType: uploaded.mimeType } : {}),
      },
    ],
  });

  const record: HandoffRecord = {
    sourceThreadId: request.sourceThreadId,
    sourceProvider: captured.providerId,
    targetThreadId: thread.id,
    targetProvider: request.providerId,
    model: request.model ?? null,
    workspace: request.workspace,
    at: Date.now(),
  };
  await bb.storage.kv.set(`handoff:${record.at}:${thread.id}`, record);

  publish("done", { newThreadId: thread.id });
  return { newThreadId: thread.id, attachmentPath: uploaded.path, docBytes: bytes.byteLength };
}

export async function listHandoffs(bb: BbPluginApi): Promise<HandoffRecord[]> {
  const keys = await bb.storage.kv.list("handoff:");
  const records: HandoffRecord[] = [];
  for (const key of keys) {
    const value = await bb.storage.kv.get<HandoffRecord>(key);
    if (value?.targetThreadId) records.push(value);
  }
  records.sort((a, b) => b.at - a.at);
  return records;
}
