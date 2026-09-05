// Shared adoption engine used by both the CLI command and the frontend RPC.
import * as fs from "node:fs";
import * as os from "node:os";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { deriveHomeDir } from "../capture";
import type { ReasoningLevel } from "../handoff";
import { listMachines, matchMachine } from "../machines";
import { ADAPTERS, getAdapter, resolveAgentId } from "./agents";
import {
  findRemoteSession,
  listRemoteSessions,
  readRemoteSession,
  type RemoteContext,
} from "./remote";
import type { AgentAdapter, AgentId, FoundSession, ParsedSession } from "./transcript";
import type { SessionSummary } from "./transcript";

export async function collectSessions(
  cwd: string,
  agentFilter?: string,
): Promise<SessionSummary[] | { error: string }> {
  let adapters = ADAPTERS;
  if (agentFilter) {
    const id = resolveAgentId(agentFilter);
    if (!id) {
      return { error: `Unknown agent "${agentFilter}". Supported: claude, codex, gemini, opencode.` };
    }
    adapters = [getAdapter(id)];
  }
  const sessions = (await Promise.all(adapters.map((adapter) => adapter.list(cwd)))).flat();
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
  if (/\bopencode\b/i.test(trimmed)) agentHint = "opencode";
  else if (/\bclaude\b/i.test(trimmed)) agentHint = "claude";
  else if (/\bcodex\b/i.test(trimmed)) agentHint = "codex";
  else if (/\bgemini\b/i.test(trimmed)) agentHint = "gemini";

  // OpenCode session ids are `ses_<base62>` — not hex, so match them first.
  const sesId = trimmed.match(/\bses_[A-Za-z0-9]{4,}\b/);
  if (sesId) return { sessionId: sesId[0], agentHint: agentHint ?? "opencode", newest: false };

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
      entries = await fs.promises.readdir(parent, { withFileTypes: true });
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
  const found = (await Promise.all(adapters.map((adapter) =>
    adapter.find(sessionId, { cwdCandidates: [...cwdCandidates] }),
  ))).flat();
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
  /** Thinking effort for the new thread; omit for the model's own default. */
  reasoningLevel?: ReasoningLevel;
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

/** A session with activity this recent may still be running in a terminal. */
const LIVE_SESSION_WINDOW_MS = 10 * 60_000;

export function isPossiblyLive(lastActivityMs: number | null, now = Date.now()): boolean {
  return lastActivityMs != null && now - lastActivityMs < LIVE_SESSION_WINDOW_MS;
}

function buildHandoff(
  session: ParsedSession,
  cwd: string,
  sameFamily: boolean,
  possiblyLive = false,
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
  }${
    possiblyLive
      ? "\n- WARNING: this session showed activity within the last few minutes and may still be RUNNING in a terminal. Before writing any file, check `git status` for concurrent edits, and if the working tree changes underneath you, stop and tell the user."
      : ""
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
  const session = await adapter.parse(filePath, {
    maxChars: Number.isFinite(maxChars) && maxChars > 1000 ? maxChars : 150_000,
  });
  let lastActivityMs: number | null = null;
  try {
    lastActivityMs = (await fs.promises.stat(filePath)).mtimeMs;
  } catch {
    // Not a plain file path (e.g. a database-backed session) — fall through.
  }
  if (session.lastTimestamp) {
    const parsedTs = Date.parse(session.lastTimestamp);
    if (Number.isFinite(parsedTs)) lastActivityMs = Math.max(lastActivityMs ?? 0, parsedTs);
  }
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
    return await adoptParsedSession(bb, adapter, session, kvKey, cwd, options, {
      possiblyLive: isPossiblyLive(lastActivityMs),
    });
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
  context: { possiblyLive?: boolean; hostId?: string } = {},
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

  // The thread runs on the host the session was read from: the server's
  // primary host for local adoption, or an explicitly chosen enrolled machine
  // for remote adoption.
  let hostId = context.hostId ?? null;
  if (!hostId) {
    const { primaryHostId } = await bb.sdk.system.config();
    hostId = primaryHostId ?? null;
  }
  if (!hostId) {
    return { ok: false, code: "no-host", message: "No host available to run the adopted thread on." };
  }

  // Pick the bb provider for the continued thread: explicit choice, else the
  // session's own family, falling back to claude-code if unavailable.
  let providerId = options.threadProviderId ?? adapter.bbProviderId;
  const providers = await bb.sdk.providers.list({ hostId });
  const availableIds = new Set(providers.filter((p) => p.available).map((p) => p.id));
  let providerNote = "";
  if (!availableIds.has(providerId)) {
    if (options.threadProviderId) {
      return {
        ok: false,
        code: "bad-provider",
        message: `Provider "${providerId}" is not available on the target host. Available: ${[...availableIds].join(", ")}`,
      };
    }
    const fallback = availableIds.has("claude-code") ? "claude-code" : [...availableIds][0];
    if (!fallback) {
      return { ok: false, code: "no-provider", message: "No bb providers are available on the target host." };
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
        if (source.hostId !== hostId) continue;
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
      source: { hostId, type: "local_path", path: cwd },
    });
    projectId = project.id;
    plan.projectId = project.id;
    plan.projectName = project.name;
  }

  // A freshly created project has no execution defaults, so spawn requires an
  // explicit model — resolve the provider's default when none is given.
  let model = options.model;
  if (!model) {
    const executionOptions = await bb.sdk.providers.models({ hostId, providerId });
    const candidates = executionOptions.models;
    model = (candidates.find((m) => m.isDefault) ?? candidates[0])?.model;
    if (!model) {
      return { ok: false, code: "no-model", message: `No models available for provider ${providerId}.` };
    }
  }

  const handoff = buildHandoff(session, cwd, sameFamily, context.possiblyLive ?? false);
  const thread = await bb.sdk.threads.spawn({
    projectId: projectId!,
    providerId,
    model,
    ...(options.reasoningLevel ? { reasoningLevel: options.reasoningLevel } : {}),
    title,
    environment: {
      type: "host",
      hostId,
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
  const collected = await collectSessions(cwd, options.agent);
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

// ---------------------------------------------------------------------------
// Remote adoption: sessions that live on another enrolled machine. The stores
// are read over bb's host file API and, where a store is not addressable by
// path alone, a short-lived host terminal — see adopt/remote.ts.

export interface RemoteAdoptOptions extends AdoptFileOptions {
  /** Host id or name of the enrolled machine holding the session. */
  machine: string;
  /** Session id, id prefix, or pasted resume command. Omit for the newest. */
  query?: string;
  /**
   * Exact session id from a prior listing — used verbatim, bypassing query
   * parsing. Gemini's filename-derived ids contain characters the query
   * grammar rejects, so a listed row must not round-trip through it.
   */
  sessionId?: string;
  /** The session's working directory on that machine. */
  cwd?: string | null;
  /** Override when no project source exists on that host to derive it from. */
  home?: string | null;
  /** Restrict to one agent's store. */
  agent?: string;
}

/** Resolve the machine, its home directory, and whether it is actually local. */
type FailedOutcome = Extract<AdoptOutcome, { ok: false }>;

async function resolveRemoteContext(
  bb: BbPluginApi,
  machine: string,
  homeOverride?: string | null,
): Promise<
  | { ok: false; outcome: FailedOutcome }
  | { ok: true; local: true }
  | { ok: true; local: false; ctx: RemoteContext }
> {
  const machines = await listMachines(bb).catch(() => []);
  const host = matchMachine(machines, machine);
  if (!host) {
    const known = machines.map((m) => m.name).join(", ") || "(none)";
    return {
      ok: false,
      outcome: {
        ok: false,
        code: "bad-host",
        message: `Unknown machine "${machine}". Enrolled machines: ${known}`,
      },
    };
  }
  const { primaryHostId } = await bb.sdk.system.config().catch(() => ({ primaryHostId: null }));
  if (host.id === primaryHostId) return { ok: true, local: true };
  if (!host.connected) {
    return {
      ok: false,
      outcome: {
        ok: false,
        code: "disconnected",
        message: `${host.name} is disconnected — bring it online to read its sessions.`,
      },
    };
  }

  // Home directory on that machine: explicit override, else derived from a
  // project source that lives there.
  let home = homeOverride?.trim() || null;
  if (!home) {
    const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
    for (const project of projects) {
      for (const source of project.sources) {
        if (source.hostId !== host.id) continue;
        home = deriveHomeDir(source.path);
        if (home) break;
      }
      if (home) break;
    }
  }
  if (!home) {
    return {
      ok: false,
      outcome: {
        ok: false,
        code: "no-home",
        message: `Couldn't derive the home directory on ${host.name} — pass --home <path>.`,
      },
    };
  }
  return { ok: true, local: false, ctx: { bb, hostId: host.id, hostName: host.name, home } };
}

export interface RemoteListResult {
  cwd: string;
  machine: string;
  sessions: FoundSession[];
  error?: string;
}

/** `bb handoff adopt list --machine <host> --cwd <path>`. */
export async function listRemoteSessionsForDirectory(
  bb: BbPluginApi,
  options: { machine: string; cwd: string; home?: string | null; agent?: string },
): Promise<RemoteListResult | { error: string }> {
  const resolved = await resolveRemoteContext(bb, options.machine, options.home);
  if (!resolved.ok) return { error: resolved.outcome.message ?? "Unknown machine." };
  if (resolved.local) {
    const collected = await collectSessions(options.cwd, options.agent);
    if ("error" in collected) return { error: collected.error };
    return {
      cwd: options.cwd,
      machine: options.machine,
      sessions: collected.map((session) => ({ ...session, cwd: options.cwd })),
    };
  }
  let agentFilter: AgentId | null = null;
  if (options.agent) {
    agentFilter = resolveAgentId(options.agent);
    if (!agentFilter) {
      return { error: `Unknown agent "${options.agent}". Supported: claude, codex, gemini, opencode.` };
    }
  }
  const { sessions, execFailed } = await listRemoteSessions(resolved.ctx, options.cwd, agentFilter);
  return {
    cwd: options.cwd,
    machine: resolved.ctx.hostName,
    sessions,
    ...(execFailed
      ? {
          error: `Could not run the session scan on ${resolved.ctx.hostName}. Adoption by session id still works.`,
        }
      : {}),
  };
}

export async function performAdoptRemote(
  bb: BbPluginApi,
  options: RemoteAdoptOptions,
): Promise<AdoptOutcome> {
  const resolved = await resolveRemoteContext(bb, options.machine, options.home);
  if (!resolved.ok) return resolved.outcome;
  if (resolved.local) {
    // Local after all — the full local engine applies.
    return options.query?.trim()
      ? performAdoptQuery(bb, { ...options, cwd: options.cwd ?? null, query: options.query })
      : options.cwd
        ? performAdopt(bb, { ...options, cwd: options.cwd, agent: options.agent })
        : {
            ok: false,
            code: "no-cwd",
            message: "That machine is the bb server itself — pass a session id or --cwd.",
          };
  }
  const ctx = resolved.ctx;

  const parsed: ParsedQuery | null = options.sessionId
    ? { sessionId: options.sessionId, agentHint: null, newest: false }
    : options.query?.trim()
      ? parseAdoptQuery(options.query)
      : null;
  const agentHint = parsed?.agentHint ?? (options.agent ? resolveAgentId(options.agent) : null);
  let matches: FoundSession[] = [];

  if (parsed?.sessionId) {
    matches = await findRemoteSession(ctx, parsed.sessionId, agentHint);
    if (matches.length === 0 && options.cwd) {
      // Not found by id alone (Gemini prefixes, Codex date shards) — fall back
      // to the directory scan and match the id there.
      const listed = await listRemoteSessions(ctx, options.cwd, agentHint);
      const needle = parsed.sessionId.toLowerCase();
      matches = listed.sessions.filter(
        (session) =>
          session.sessionId.toLowerCase() === needle ||
          session.sessionId.toLowerCase().startsWith(needle) ||
          session.filePath.toLowerCase().includes(needle),
      );
    }
    if (matches.length === 0) {
      return {
        ok: false,
        code: "not-found",
        message: `No session matching "${parsed.sessionId}" found on ${ctx.hostName}${options.cwd ? ` (searched all stores, and ${options.cwd})` : " — add --cwd <path> to scan a directory as well"}.`,
      };
    }
  } else {
    // No id: adopt the newest session for a directory on that machine.
    if (!options.cwd) {
      return {
        ok: false,
        code: "no-id",
        message: `Pass a session id, or --cwd <path> to adopt the newest session for a directory on ${ctx.hostName}.`,
      };
    }
    const listed = await listRemoteSessions(ctx, options.cwd, agentHint);
    if (listed.execFailed) {
      return {
        ok: false,
        code: "exec-failed",
        message: `Could not scan ${options.cwd} on ${ctx.hostName}. Pass an explicit session id instead.`,
      };
    }
    if (listed.sessions.length === 0) {
      return {
        ok: false,
        code: "no-sessions",
        message: `No agent sessions found for ${options.cwd} on ${ctx.hostName}.`,
      };
    }
    matches = [listed.sessions[0]!];
  }

  if (matches.length > 1) {
    const exact = parsed?.sessionId
      ? matches.filter((m) => m.sessionId.toLowerCase() === parsed.sessionId!.toLowerCase())
      : [];
    if (exact.length === 1) matches = exact;
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: "ambiguous",
      message: `${matches.length} sessions on ${ctx.hostName} match — pick one by full id.`,
      matches,
    };
  }

  const match = matches[0]!;
  const maxChars = options.maxChars ?? 150_000;
  let session: ParsedSession;
  try {
    session = await readRemoteSession(ctx, match, {
      maxChars: Number.isFinite(maxChars) && maxChars > 1000 ? maxChars : 150_000,
    });
  } catch (error) {
    return {
      ok: false,
      code: "read-failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!session.transcript.trim()) {
    return {
      ok: false,
      code: "empty-session",
      message: `Session ${session.sessionId} has no conversation content to adopt.`,
    };
  }
  const cwd = session.cwd ?? match.cwd ?? options.cwd ?? null;
  if (!cwd) {
    return {
      ok: false,
      code: "no-cwd",
      message: `Found the ${session.agentLabel} session on ${ctx.hostName}, but its directory can't be determined — pass --cwd <path>.`,
    };
  }

  const kvKey = `adopted:${session.agent}:${session.sessionId}`;
  if (inFlightAdoptions.has(kvKey)) {
    return { ok: false, code: "in-progress", message: `Session ${session.sessionId} is already being adopted.` };
  }
  inFlightAdoptions.add(kvKey);
  try {
    const lastMs = session.lastTimestamp ? Date.parse(session.lastTimestamp) : Number.NaN;
    return await adoptParsedSession(bb, getAdapter(session.agent), session, kvKey, cwd, options, {
      hostId: ctx.hostId,
      possiblyLive: isPossiblyLive(Number.isFinite(lastMs) ? lastMs : null),
    });
  } finally {
    inFlightAdoptions.delete(kvKey);
  }
}

/**
 * Resolve the directory to look in for a project: its default source path.
 * With a hostId, only that machine's sources count — a default source on a
 * different machine is a path that does not exist over there.
 */
export async function resolveProjectCwd(
  bb: BbPluginApi,
  projectId: string,
  hostId?: string | null,
): Promise<string | null> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  const pool = hostId ? project.sources.filter((s) => s.hostId === hostId) : project.sources;
  const source = pool.find((s) => s.isDefault) ?? pool[0];
  return source?.path ?? null;
}
