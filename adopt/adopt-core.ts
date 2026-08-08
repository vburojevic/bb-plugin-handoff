// Shared adoption engine used by both the CLI command and the frontend RPC.
import * as fs from "node:fs";
import * as os from "node:os";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { ADAPTERS, getAdapter, resolveAgentId } from "./agents";
import type { AgentAdapter, AgentId, FoundSession, ParsedSession } from "./transcript";
import type { SessionSummary } from "./transcript";

export function collectSessions(
  cwd: string,
  agentFilter?: string,
): SessionSummary[] | { error: string } {
  let adapters = ADAPTERS;
  if (agentFilter) {
    const id = resolveAgentId(agentFilter);
    if (!id) return { error: `Unknown agent "${agentFilter}". Supported: claude, codex, gemini.` };
    adapters = [getAdapter(id)];
  }
  const sessions = adapters.flatMap((adapter) => adapter.list(cwd));
  sessions.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return sessions;
}

// ---------------------------------------------------------------------------
// Query parsing — accepts a bare id/prefix or a pasted resume command like
// `claude --resume 8f2c…`, `claude -r 8f2c…`, or `codex resume 019f…`.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface ParsedQuery {
  sessionId: string | null;
  agentHint: AgentId | null;
  newest: boolean;
}

export function parseAdoptQuery(text: string): ParsedQuery {
  const trimmed = text.trim().replace(/^["'`]|["'`]$/g, "");
  let agentHint: AgentId | null = null;
  if (/\bclaude\b/i.test(trimmed)) agentHint = "claude";
  else if (/\bcodex\b/i.test(trimmed)) agentHint = "codex";
  else if (/\bgemini\b/i.test(trimmed)) agentHint = "gemini";

  const uuid = trimmed.match(UUID_RE);
  if (uuid) return { sessionId: uuid[0].toLowerCase(), agentHint, newest: false };

  const resume = trimmed.match(/(?:--resume(?:=|\s+)|(?:^|\s)-r\s+|\bresume\s+)["'`]?([\w-]+)/i);
  if (resume?.[1] && !resume[1].startsWith("-")) {
    return { sessionId: resume[1], agentHint, newest: false };
  }
  if (/(?:--continue|--last|(?:^|\s)-c(?:\s|$))/.test(trimmed)) {
    return { sessionId: null, agentHint, newest: true };
  }
  if (/^[0-9a-f][0-9a-f-]{5,}$/i.test(trimmed)) {
    return { sessionId: trimmed.toLowerCase(), agentHint, newest: false };
  }
  return { sessionId: null, agentHint, newest: false };
}

/** Search all agents' stores for a session id/prefix, across all directories. */
export async function locateSessions(
  bb: BbPluginApi,
  sessionId: string,
  agentHint: AgentId | null,
): Promise<FoundSession[]> {
  // Candidate directories let the Gemini adapter reverse its cwd hashes:
  // project sources, plus the children of their parent folders (siblings like
  // ~/Git/<other-repo>) and of the home directory.
  const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
  const home = os.homedir();
  const roots = new Set<string>([home, ...projects.flatMap((p) => p.sources.map((s) => s.path))]);
  const parents = new Set<string>([home]);
  for (const root of roots) {
    const parent = root.slice(0, root.lastIndexOf("/"));
    if (parent.length > 1) parents.add(parent);
  }
  const cwdCandidates = new Set<string>(roots);
  for (const parent of parents) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        cwdCandidates.add(`${parent}/${entry.name}`);
      }
    }
  }
  const adapters = agentHint ? [getAdapter(agentHint)] : ADAPTERS;
  const found = adapters.flatMap((adapter) =>
    adapter.find(sessionId, { cwdCandidates: [...cwdCandidates] }),
  );
  found.sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  return found;
}

// ---------------------------------------------------------------------------
// Adoption

export interface AdoptOptions {
  cwd: string;
  /** Exact session id or unique prefix. Omit for the newest session. */
  sessionId?: string;
  agent?: string;
  projectId?: string;
  title?: string;
  threadProviderId?: string;
  model?: string;
  maxChars?: number;
  force?: boolean;
  dryRun?: boolean;
}

export interface AdoptPlan {
  agent: string;
  agentLabel: string;
  sessionId: string;
  cwd: string;
  projectId: string | null;
  projectName: string;
  createdProject: boolean;
  providerId: string;
  providerNote: string;
  title: string;
  userMessageCount: number;
  assistantMessageCount: number;
  transcriptChars: number;
  truncated: boolean;
}

export type AdoptOutcome =
  | { ok: true; dryRun: true; plan: AdoptPlan }
  | { ok: true; dryRun: false; plan: AdoptPlan; threadId: string }
  | { ok: false; code: string; message: string; existingThreadId?: string; matches?: FoundSession[] };

function buildHandoff(
  session: ParsedSession,
  cwd: string,
  sameFamily: boolean,
): { visible: string; agentOnly: string } {
  const started = session.firstTimestamp ? new Date(session.firstTimestamp).toLocaleString() : "unknown";
  const visible = [
    `Continuing adopted ${session.agentLabel} session \`${session.sessionId.slice(0, 8)}\``,
    `(${session.userMessageCount} user / ${session.assistantMessageCount} assistant messages, started ${started})`,
    `in \`${cwd}\`.`,
  ].join(" ");
  const identity = sameFamily
    ? `The transcript below is YOUR OWN conversation history with this user. Continue
seamlessly: do not re-introduce yourself, do not redo completed work, and keep
every decision already made unless the user changes it.`
    : `The transcript below is the conversation so far between the user and the
prior agent (${session.agentLabel}). Take it over as your own work: do not
re-introduce yourself, do not redo completed work, and keep every decision
already made unless the user changes it.`;
  const agentOnly = `# Session handoff — adopted external session

You are continuing an existing ${session.agentLabel} session that was running
outside bb. ${identity}

- Original session id: ${session.sessionId}
- Original agent: ${session.agentLabel}
- Working directory: ${cwd} (this thread runs in the same directory; files are exactly as the session left them)
- Git branch: ${session.gitBranch ?? "n/a"}
- Started: ${session.firstTimestamp ?? "unknown"} — last activity: ${session.lastTimestamp ?? "unknown"}${
    session.truncated ? "\n- Note: the transcript was truncated to fit; oldest middle portions were omitted." : ""
  }

## Transcript

${session.transcript}

## Now

Reply with a brief status (2–4 sentences): what was being worked on and where
things stand. Then wait for the user's next instruction — do not start new work.`;
  return { visible, agentOnly };
}

type AdoptFileOptions = Omit<AdoptOptions, "cwd" | "sessionId" | "agent">;

/**
 * Sessions being adopted right now. The kv marker is only written after the
 * thread spawns, so without this a concurrent CLI + UI adoption of the same
 * session would both pass the duplicate check and create two threads.
 */
const inFlightAdoptions = new Set<string>();

async function adoptFromFile(
  bb: BbPluginApi,
  agent: AgentId,
  filePath: string,
  cwd: string,
  options: AdoptFileOptions,
): Promise<AdoptOutcome> {
  const adapter = getAdapter(agent);
  const maxChars = options.maxChars ?? 150_000;
  const session = adapter.parse(filePath, {
    maxChars: Number.isFinite(maxChars) && maxChars > 1000 ? maxChars : 150_000,
  });
  if (!session.transcript.trim()) {
    return {
      ok: false,
      code: "empty-session",
      message: `Session ${session.sessionId} has no conversation content to adopt.`,
    };
  }

  const kvKey = `adopted:${session.agent}:${session.sessionId}`;
  if (inFlightAdoptions.has(kvKey)) {
    return {
      ok: false,
      code: "in-progress",
      message: `Session ${session.sessionId} is already being adopted.`,
    };
  }
  inFlightAdoptions.add(kvKey);
  try {
    return await adoptParsedSession(bb, adapter, session, kvKey, cwd, options);
  } finally {
    inFlightAdoptions.delete(kvKey);
  }
}

async function adoptParsedSession(
  bb: BbPluginApi,
  adapter: AgentAdapter,
  session: ParsedSession,
  kvKey: string,
  cwd: string,
  options: AdoptFileOptions,
): Promise<AdoptOutcome> {
  // Refuse duplicate adoption unless forced (the prior thread may have moved on).
  const existing = await bb.storage.kv.get<{ threadId: string }>(kvKey);
  if (existing && !options.force) {
    let stillExists = true;
    try {
      await bb.sdk.threads.get({ threadId: existing.threadId });
    } catch {
      stillExists = false;
    }
    if (stillExists) {
      return {
        ok: false,
        code: "already-adopted",
        message: `Session ${session.sessionId} was already adopted as thread ${existing.threadId}.`,
        existingThreadId: existing.threadId,
      };
    }
  }

  // Sessions are read from the server machine, so the thread must run on that
  // same (primary) host.
  const { primaryHostId } = await bb.sdk.system.config();
  if (!primaryHostId) {
    return { ok: false, code: "no-host", message: "No primary host available to run the adopted thread on." };
  }

  // Pick the bb provider for the continued thread: explicit choice, else the
  // session's own family, falling back to claude-code if unavailable.
  let providerId = options.threadProviderId ?? adapter.bbProviderId;
  const providers = await bb.sdk.providers.list({ hostId: primaryHostId });
  const availableIds = new Set(providers.filter((p) => p.available).map((p) => p.id));
  let providerNote = "";
  if (!availableIds.has(providerId)) {
    if (options.threadProviderId) {
      return {
        ok: false,
        code: "bad-provider",
        message: `Provider "${providerId}" is not available on the primary host. Available: ${[...availableIds].join(", ")}`,
      };
    }
    const fallback = availableIds.has("claude-code") ? "claude-code" : [...availableIds][0];
    if (!fallback) {
      return { ok: false, code: "no-provider", message: "No bb providers are available on the primary host." };
    }
    providerNote = ` (provider ${providerId} unavailable, using ${fallback})`;
    providerId = fallback;
  }
  const sameFamily = providerId === adapter.bbProviderId && session.agent !== "gemini";

  // Project: explicit choice, else the project whose source path contains cwd
  // (longest match), else a new project registered for this directory —
  // personal projects can't attach to arbitrary paths.
  let projectId = options.projectId ?? null;
  let projectName: string | null = null;
  let willCreateProject = false;
  const projects = await bb.sdk.projects.list();
  if (projectId) {
    const match = projects.find((p) => p.id === projectId);
    if (!match) return { ok: false, code: "bad-project", message: `Unknown project: ${projectId}` };
    projectName = match.name;
  } else {
    let bestLength = -1;
    for (const project of projects) {
      for (const source of project.sources) {
        const root = source.path.replace(/\/+$/, "");
        if ((cwd === root || cwd.startsWith(`${root}/`)) && root.length > bestLength) {
          bestLength = root.length;
          projectId = project.id;
          projectName = project.name;
        }
      }
    }
    if (!projectId) {
      willCreateProject = true;
      projectName = cwd.split("/").filter(Boolean).pop() ?? "adopted";
    }
  }

  const title = (
    options.title?.trim() || `Adopted: ${session.title ?? session.sessionId.slice(0, 8)}`
  ).slice(0, 100);
  const plan: AdoptPlan = {
    agent: session.agent,
    agentLabel: session.agentLabel,
    sessionId: session.sessionId,
    cwd,
    projectId: willCreateProject ? null : projectId,
    projectName: projectName ?? "",
    createdProject: willCreateProject,
    providerId,
    providerNote,
    title,
    userMessageCount: session.userMessageCount,
    assistantMessageCount: session.assistantMessageCount,
    transcriptChars: session.transcript.length,
    truncated: session.truncated,
  };
  if (options.dryRun) return { ok: true, dryRun: true, plan };

  if (willCreateProject) {
    const project = await bb.sdk.projects.create({
      name: plan.projectName,
      source: { hostId: primaryHostId, type: "local_path", path: cwd },
    });
    projectId = project.id;
    plan.projectId = project.id;
    plan.projectName = project.name;
  }

  // A freshly created project has no execution defaults, so spawn requires an
  // explicit model — resolve the provider's default when none is given.
  let model = options.model;
  if (!model) {
    const executionOptions = await bb.sdk.providers.models({ hostId: primaryHostId, providerId });
    const candidates = executionOptions.models;
    model = (candidates.find((m) => m.isDefault) ?? candidates[0])?.model;
    if (!model) {
      return { ok: false, code: "no-model", message: `No models available for provider ${providerId}.` };
    }
  }

  const handoff = buildHandoff(session, cwd, sameFamily);
  const thread = await bb.sdk.threads.spawn({
    projectId: projectId!,
    providerId,
    model,
    title,
    environment: {
      type: "host",
      hostId: primaryHostId,
      workspace: { type: "unmanaged", path: cwd },
    },
    input: [
      { type: "text", text: handoff.visible, mentions: [] },
      { type: "text", text: handoff.agentOnly, mentions: [], visibility: "agent-only" },
    ],
  });
  await bb.storage.kv.set(kvKey, { threadId: thread.id, adoptedAt: Date.now() });
  bb.log.info(`adopted ${session.agent} session ${session.sessionId} as thread ${thread.id}`);
  return { ok: true, dryRun: false, plan, threadId: thread.id };
}

/** Adopt within a known directory (newest session, or an id/prefix in it). */
export async function performAdopt(bb: BbPluginApi, options: AdoptOptions): Promise<AdoptOutcome> {
  const { cwd } = options;
  if (!fs.existsSync(cwd)) {
    return { ok: false, code: "bad-cwd", message: `Directory does not exist on the bb server machine: ${cwd}` };
  }
  const collected = collectSessions(cwd, options.agent);
  if ("error" in collected) return { ok: false, code: "bad-agent", message: collected.error };
  if (collected.length === 0) {
    return { ok: false, code: "no-sessions", message: `No agent sessions found for ${cwd}` };
  }
  const summary = options.sessionId
    ? collected.find((s) => s.sessionId === options.sessionId || s.sessionId.startsWith(options.sessionId!))
    : collected[0];
  if (!summary) {
    return { ok: false, code: "not-found", message: `No session matching "${options.sessionId}" for ${cwd}.` };
  }
  return adoptFromFile(bb, summary.agent, summary.filePath, cwd, options);
}

export interface QueryAdoptOptions extends AdoptFileOptions {
  /** A pasted session id, id prefix, or resume command. */
  query: string;
  /** Deliberately chosen directory: rescues sessions whose cwd is unknown. */
  cwd?: string | null;
  /** Ambient directory (invoking cwd): used only to prefer among matches. */
  contextCwd?: string | null;
}

/** Adopt from pasted input — parse the id, locate it globally, adopt it. */
export async function performAdoptQuery(
  bb: BbPluginApi,
  options: QueryAdoptOptions,
): Promise<AdoptOutcome> {
  const parsed = parseAdoptQuery(options.query);
  const anchorCwd = options.cwd ?? options.contextCwd ?? null;
  if (parsed.newest) {
    if (!anchorCwd) {
      return {
        ok: false,
        code: "no-id",
        message:
          "That command resumes the newest session of a directory — paste a session id instead, or set the directory and use the session list.",
      };
    }
    return performAdopt(bb, {
      ...options,
      cwd: anchorCwd,
      sessionId: undefined,
      agent: parsed.agentHint ?? undefined,
    });
  }
  if (!parsed.sessionId) {
    return {
      ok: false,
      code: "no-id",
      message:
        'No session id found in that input. Paste the id itself, or a resume command like "claude --resume <id>" / "codex resume <id>".',
    };
  }
  const matches = await locateSessions(bb, parsed.sessionId, parsed.agentHint);
  if (matches.length === 0) {
    return {
      ok: false,
      code: "not-found",
      message: `No session matching "${parsed.sessionId}" found on this machine.`,
    };
  }
  const exact = matches.filter((m) => m.sessionId.toLowerCase() === parsed.sessionId!.toLowerCase());
  let pool = exact.length > 0 ? exact : matches;
  if (pool.length > 1 && anchorCwd) {
    const local = pool.filter((m) => m.cwd === anchorCwd);
    if (local.length === 1) pool = local;
  }
  if (pool.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message: `${pool.length} sessions match "${parsed.sessionId}" — pick one from the list.`,
      matches: pool,
    };
  }
  const match = pool[0]!;
  const cwd = match.cwd ?? options.cwd ?? null;
  if (!cwd) {
    return {
      ok: false,
      code: "no-cwd",
      message: `Found the ${getAdapter(match.agent).label} session, but its directory can't be determined — set the directory and retry.`,
      matches: [match],
    };
  }
  return adoptFromFile(bb, match.agent, match.filePath, cwd, options);
}

/** Resolve the directory to look in for a project: its default source path. */
export async function resolveProjectCwd(bb: BbPluginApi, projectId: string): Promise<string | null> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
  return source?.path ?? null;
}
