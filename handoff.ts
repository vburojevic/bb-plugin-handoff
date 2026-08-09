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
  /**
   * Ask the source agent to write a handoff briefing before the transfer.
   * Best-effort: skipped when the source thread is busy, failed, or does not
   * answer within BRIEFING_TIMEOUT_MS.
   */
  briefing?: boolean;
}

/**
 * Whether the receiving thread's first turn confirmed the pickup.
 * "pending" until its first idle/failed event (best-effort: pending
 * verifications don't survive a plugin reload and expire after 15 minutes).
 */
export type VerificationState = "pending" | "confirmed" | "failed";

export interface HandoffRecord {
  sourceThreadId: string;
  sourceProvider: string;
  targetThreadId: string;
  targetProvider: string;
  model: string | null;
  workspace: WorkspaceMode;
  at: number;
  verification?: VerificationState;
}

export type BriefingOutcome = "included" | "skipped-busy" | "skipped-unanswered" | "off";

export const REALTIME_CHANNEL = "handoff:progress";

/** Most recent handoff records kept in kv; older ones are pruned on write. */
export const HISTORY_LIMIT = 100;

// --- Briefing: ask the outgoing agent to write a handoff note ---------------

export const BRIEFING_TIMEOUT_MS = 90_000;

const BRIEFING_PROMPT = [
  "This session is being handed off to another agent. Before the transfer, write a handoff briefing for your successor. Reply with only the briefing:",
  "",
  "- **Current state** — what has been completed and verified",
  "- **In progress** — what you were doing right now and what is unfinished",
  "- **Decisions** — choices made so far and why, so they are not relitigated",
  "- **Gotchas** — anything surprising the next agent should not rediscover the hard way",
  "- **Next steps** — what you would do next, in order",
  "",
  "Do not do any further work on the task itself.",
].join("\n");

/**
 * Handoffs currently waiting for their source thread's briefing turn to
 * finish. server.ts settles these from its thread.idle / thread.failed
 * listeners.
 */
const briefingWaiters = new Map<string, (text: string | null) => void>();

export function settleBriefing(threadId: string, text: string | null): void {
  briefingWaiters.get(threadId)?.(text);
}

/**
 * Send the briefing prompt to the source thread and wait for its answer.
 * Only runs against an idle thread — a busy source is never steered off its
 * in-flight turn (this also makes agent-initiated `bb handoff --self` skip
 * the briefing naturally, since that thread is mid-turn running the CLI).
 */
async function requestBriefing(
  bb: BbPluginApi,
  threadId: string,
): Promise<{ text: string | null; outcome: BriefingOutcome }> {
  try {
    // deno-lint-ignore no-explicit-any
    const thread = (await bb.sdk.threads.get({ threadId })) as any;
    if (thread.status !== "idle") return { text: null, outcome: "skipped-busy" };
  } catch {
    return { text: null, outcome: "skipped-busy" };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<string | null>((resolve) => {
    briefingWaiters.set(threadId, resolve);
    timer = setTimeout(() => resolve(null), BRIEFING_TIMEOUT_MS);
  });
  try {
    await bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text: BRIEFING_PROMPT, mentions: [] }],
    });
    const text = await waited;
    return { text, outcome: text?.trim() ? "included" : "skipped-unanswered" };
  } catch {
    return { text: null, outcome: "skipped-unanswered" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    briefingWaiters.delete(threadId);
  }
}

// --- Verification: did the receiving thread pick the work up? ---------------

export const VERIFY_CHANNEL = "handoff:verify";
const VERIFICATION_TTL_MS = 15 * 60_000;

const pendingVerifications = new Map<
  string,
  { kvKey: string; sourceThreadId: string; expiresAt: number }
>();

/**
 * Called by server.ts's thread.idle / thread.failed listeners for every
 * thread; only threads registered as fresh handoff targets are affected.
 * Persists the outcome on the history record and announces it in realtime.
 */
export async function settleVerification(
  bb: BbPluginApi,
  threadId: string,
  ok: boolean,
  firstReply?: string | null,
): Promise<void> {
  const now = Date.now();
  for (const [key, value] of pendingVerifications) {
    if (value.expiresAt < now) pendingVerifications.delete(key);
  }
  const entry = pendingVerifications.get(threadId);
  if (!entry) return;
  pendingVerifications.delete(threadId);
  const verification: VerificationState = ok && Boolean(firstReply?.trim()) ? "confirmed" : "failed";
  try {
    const record = await bb.storage.kv.get<HandoffRecord>(entry.kvKey);
    if (record) await bb.storage.kv.set(entry.kvKey, { ...record, verification });
  } catch {
    // History pruning may have removed the record; the signal still goes out.
  }
  bb.realtime.publish(VERIFY_CHANNEL, {
    targetThreadId: threadId,
    sourceThreadId: entry.sourceThreadId,
    verification,
  });
}

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

export function renderHandoff(
  captured: CapturedSession,
  capturedAt: Date,
  briefing?: string | null,
  options?: { sameFamily?: boolean },
): string {
  const sameFamily = options?.sameFamily ?? false;
  const steps = [
    briefing?.trim()
      ? "Read the outgoing agent's briefing and the full transcript below before doing anything else."
      : "Read the full transcript below before doing anything else.",
    ...(sameFamily
      ? [
          "The transcript is YOUR OWN conversation history with this user, continued on a new bb thread. Continue seamlessly: do not re-introduce yourself and do not summarize back what you already know.",
        ]
      : []),
    "The workspace path above holds the live working state — check `git status` and `git log` there for uncommitted work.",
    "Continue from where the previous agent left off. Do not redo completed steps; honor decisions already made unless the user says otherwise.",
    ...(captured.nativeSessionPath
      ? [
          sameFamily
            ? "The native session file above is your own full session log (JSONL). When you need exact detail this rendered transcript truncated — precise file contents, complete command output — read that file directly; it is the authoritative record."
            : "If you need raw detail the transcript truncated, the native session file above contains the source provider's full session (JSONL).",
        ]
      : []),
    `The previous agent is still reachable in bb thread \`${captured.threadId}\`. If something essential is unclear, ask it directly: \`bb thread tell ${captured.threadId} "<your question>" --mode queue\`, then \`bb thread wait ${captured.threadId}\` and \`bb thread output ${captured.threadId}\` to read the answer. Ask at most once or twice, then continue on your own — that agent no longer owns this task.`,
  ];

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
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    "",
  ].filter((line) => line !== null).join("\n");

  const latest = [
    "",
    "## Latest result",
    "",
    captured.latestOutput?.trim() || "(no final output captured)",
    "",
  ].join("\n");

  const briefingSection = briefing?.trim()
    ? [
        "",
        "## Briefing from the outgoing agent",
        "",
        "Written by the outgoing agent immediately before this handoff — the freshest statement of state and intent:",
        "",
        briefing.trim(),
        "",
      ].join("\n")
    : "";

  const rendered = captured.entries.map((entry) => renderEntry(entry, captured.providerId));
  const transcript = fitTranscript(
    rendered,
    CAPS.totalDocBytes - header.length - latest.length - briefingSection.length,
  );

  return `${header}${latest}${briefingSection}\n## Transcript\n\n${transcript}\n`;
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

export function buildIntroPrompt(
  captured: CapturedSession,
  request: HandoffRequest,
  hasBriefing = false,
): string {
  const sameFamily = request.providerId === captured.providerId;
  const lines = [
    sameFamily
      ? "You are continuing YOUR OWN in-progress session on a new bb thread (same provider, new thread)."
      : `You are taking over an in-progress agent session handed off from ${captured.providerId}.`,
    "Read the attached handoff document in full — it contains the complete conversation transcript and the current state of the work.",
    ...(hasBriefing
      ? [
          "It also contains a briefing the outgoing agent wrote moments before this handoff — treat it as the freshest statement of state and intent.",
        ]
      : []),
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
  briefing: BriefingOutcome;
}

export async function startHandoff(bb: BbPluginApi, request: HandoffRequest): Promise<HandoffResult> {
  const publish = (stage: string, extra?: Record<string, unknown>) =>
    bb.realtime.publish(REALTIME_CHANNEL, { sourceThreadId: request.sourceThreadId, stage, ...extra });
  try {
    return await runHandoff(bb, request, publish);
  } catch (error) {
    publish("failed", { message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

async function runHandoff(
  bb: BbPluginApi,
  request: HandoffRequest,
  publish: (stage: string, extra?: Record<string, unknown>) => void,
): Promise<HandoffResult> {
  publish("capturing");
  const captured = await captureThread(bb, request.sourceThreadId, { untilSeq: request.untilSeq });

  // The capture snapshot is taken first, so the briefing exchange below never
  // appears in the transcript — it travels only as its own document section.
  let briefing: string | null = null;
  let briefingOutcome: BriefingOutcome = "off";
  if (request.briefing) {
    publish("briefing");
    const result = await requestBriefing(bb, request.sourceThreadId);
    briefing = result.text;
    briefingOutcome = result.outcome;
  }

  publish("rendering");
  const sameFamily = request.providerId === captured.providerId;
  const doc = renderHandoff(captured, new Date(), briefing, { sameFamily });
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
      { type: "text", text: buildIntroPrompt(captured, request, briefing != null), mentions: [] },
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
    verification: "pending",
  };
  const kvKey = `handoff:${record.at}:${thread.id}`;
  await bb.storage.kv.set(kvKey, record);
  await pruneHistory(bb);
  pendingVerifications.set(thread.id, {
    kvKey,
    sourceThreadId: request.sourceThreadId,
    expiresAt: Date.now() + VERIFICATION_TTL_MS,
  });

  publish("done", { newThreadId: thread.id });
  return {
    newThreadId: thread.id,
    attachmentPath: uploaded.path,
    docBytes: bytes.byteLength,
    briefing: briefingOutcome,
  };
}

/**
 * Drop the oldest records beyond HISTORY_LIMIT. Keys embed a fixed-width
 * millisecond timestamp (`handoff:<ms>:<threadId>`), so a lexicographic sort
 * is chronological.
 */
async function pruneHistory(bb: BbPluginApi): Promise<void> {
  const keys = await bb.storage.kv.list("handoff:");
  if (keys.length <= HISTORY_LIMIT) return;
  const excess = [...keys].sort().slice(0, keys.length - HISTORY_LIMIT);
  for (const key of excess) await bb.storage.kv.delete(key);
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
