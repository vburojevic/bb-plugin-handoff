// Cross-machine transfer. Every bb thread is pinned to one enrolled machine,
// so moving a session to another one is three decisions: which host, which
// workspace on that host, and what working state has to travel alongside the
// transcript because the git remote does not carry it.
import type { BbPluginApi } from "@bb/plugin-sdk";

export type WorkspaceMode = "reuse" | "checkout" | "worktree" | "personal";

export interface Machine {
  id: string;
  name: string;
  connected: boolean;
  isPrimary: boolean;
}

/** A transfer the user can fix by choosing differently; message is user-facing. */
export class TransferError extends Error {}

export async function listMachines(bb: BbPluginApi): Promise<Machine[]> {
  const hosts = await bb.sdk.hosts.list();
  let primaryHostId: string | null = null;
  try {
    primaryHostId = (await bb.sdk.system.config()).primaryHostId ?? null;
  } catch {
    // No primary reported — every machine is then treated as non-primary.
  }
  return hosts.map((host) => ({
    id: host.id,
    name: host.name,
    connected: host.status === "connected",
    isPrimary: host.id === primaryHostId,
  }));
}

/** Resolve a machine by id or (case-insensitive) name. */
export function matchMachine(machines: Machine[], needle: string): Machine | null {
  const trimmed = needle.trim();
  const lowered = trimmed.toLowerCase();
  return (
    machines.find((machine) => machine.id === trimmed) ??
    machines.find((machine) => machine.name.toLowerCase() === lowered) ??
    null
  );
}

export async function resolveMachine(bb: BbPluginApi, needle: string): Promise<Machine> {
  const machines = await listMachines(bb);
  const match = matchMachine(machines, needle);
  if (!match) {
    const known = machines.map((machine) => machine.name).join(", ") || "(none)";
    throw new TransferError(`Unknown machine "${needle}". Enrolled machines: ${known}`);
  }
  return match;
}

// --- Planning ---------------------------------------------------------------

export interface TransferPlan {
  /** Undefined targets bb's primary host, matching the spawn API. */
  hostId: string | undefined;
  hostName: string | null;
  /** True when the target machine differs from the source thread's machine. */
  crossMachine: boolean;
  sourceHostName: string | null;
  workspace: WorkspaceMode;
  /** Absolute path on the target host — "checkout" mode only. */
  checkoutPath: string | null;
  /** Branch the new worktree is based on, when the target host has it. */
  baseBranch: string | null;
  /** Planning adjustments worth telling the user and the receiving agent. */
  notes: string[];
}

export interface TransferInputs {
  projectId: string;
  /** Host the source thread runs on; undefined when its environment is gone. */
  sourceHostId: string | undefined;
  sourceBranch: string | null;
  hasEnvironment: boolean;
  workspace: WorkspaceMode;
  /** Target machine id or name; omit to stay on the source machine. */
  machine?: string | null;
}

/** The project's checkout on one host, preferring the default source. */
export async function sourcePathOnHost(
  bb: BbPluginApi,
  projectId: string,
  hostId: string,
): Promise<string | null> {
  const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
  const project = projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  const onHost = project.sources.filter((source) => source.hostId === hostId);
  const chosen = onHost.find((source) => source.isDefault) ?? onHost[0];
  return chosen?.path ?? null;
}

async function hostHasBranch(
  bb: BbPluginApi,
  projectId: string,
  hostId: string,
  branch: string,
): Promise<boolean> {
  try {
    const result = await bb.sdk.projects.branches({
      projectId,
      hostId,
      query: branch,
      limit: "100",
    });
    return result.branches.includes(branch);
  } catch {
    return false;
  }
}

/**
 * Decide where the handed-off thread runs and validate that it can. Throws
 * TransferError with an actionable message rather than letting a spawn fail
 * with a bb-internal one.
 */
export async function planTransfer(bb: BbPluginApi, inputs: TransferInputs): Promise<TransferPlan> {
  // Staying on the source machine must not depend on the host list, so a
  // failure to enumerate machines is only fatal when one was actually named.
  const machines = inputs.machine
    ? await listMachines(bb)
    : await listMachines(bb).catch(() => [] as Machine[]);
  const source = inputs.sourceHostId
    ? (machines.find((machine) => machine.id === inputs.sourceHostId) ?? null)
    : null;

  let target: Machine | null = null;
  if (inputs.machine) {
    target = matchMachine(machines, inputs.machine);
    if (!target) {
      const known = machines.map((machine) => machine.name).join(", ") || "(none)";
      throw new TransferError(`Unknown machine "${inputs.machine}". Enrolled machines: ${known}`);
    }
  } else {
    target = source;
  }

  const hostId = target?.id ?? inputs.sourceHostId;
  const crossMachine = Boolean(inputs.sourceHostId) && hostId !== inputs.sourceHostId;
  const notes: string[] = [];
  if (target && crossMachine && !target.connected) {
    throw new TransferError(
      `${target.name} is disconnected — bring it online before handing a session to it.`,
    );
  }

  const plan: TransferPlan = {
    hostId,
    hostName: target?.name ?? null,
    crossMachine,
    sourceHostName: source?.name ?? null,
    workspace: inputs.workspace,
    checkoutPath: null,
    baseBranch: null,
    notes,
  };
  const targetLabel = plan.hostName ?? "the target machine";

  if (inputs.workspace === "reuse") {
    if (crossMachine) {
      throw new TransferError(
        `"Same workspace" reuses the source thread's environment, which lives on ${plan.sourceHostName ?? "the source machine"}. To run on ${targetLabel}, choose the project checkout there, a new worktree, or a blank workspace.`,
      );
    }
    if (!inputs.hasEnvironment) {
      throw new TransferError("Source thread has no environment to reuse — pick worktree or personal.");
    }
    return plan;
  }

  if (inputs.workspace === "personal") return plan;

  if (inputs.workspace === "checkout") {
    const checkoutPath = hostId ? await sourcePathOnHost(bb, inputs.projectId, hostId) : null;
    if (!checkoutPath) {
      throw new TransferError(
        `This project has no checkout on ${targetLabel} — add one to the project's sources first, or hand off to a new worktree or a blank workspace.`,
      );
    }
    plan.checkoutPath = checkoutPath;
    return plan;
  }

  // worktree. Same-machine keeps its long-standing "isolated copy off the
  // default branch" meaning; crossing machines it would silently strand the
  // agent on the wrong history, so there the source branch is carried over.
  if (crossMachine && hostId) {
    if (!(await sourcePathOnHost(bb, inputs.projectId, hostId))) {
      throw new TransferError(
        `This project has no checkout on ${targetLabel}, so there is nothing to build a worktree from. Add a source for it there, or hand off to a blank personal workspace.`,
      );
    }
    if (inputs.sourceBranch) {
      if (await hostHasBranch(bb, inputs.projectId, hostId, inputs.sourceBranch)) {
        plan.baseBranch = inputs.sourceBranch;
      } else {
        notes.push(
          `Branch \`${inputs.sourceBranch}\` does not exist on ${targetLabel}, so the new worktree is based on the default branch. Push that branch to continue from the same commits.`,
        );
      }
    }
  }
  return plan;
}

// --- Working state ----------------------------------------------------------

export interface WorkingFile {
  path: string;
  status: string;
}

export interface WorkingState {
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  files: WorkingFile[];
  insertions: number;
  deletions: number;
  /** Unified diff of everything uncommitted; null when clean or unavailable. */
  patch: string | null;
  patchTruncated: boolean;
  /** Why there is no patch, when there is uncommitted work but no diff. */
  note: string | null;
}

/** A patch beyond this is not worth shipping through a handoff. */
export const MAX_PATCH_BYTES = 2_000_000;

/**
 * The source workspace's git state, including a patch of everything
 * uncommitted. Cross-machine handoffs need this because the target machine
 * only ever sees what has been pushed.
 */
export async function captureWorkingState(
  bb: BbPluginApi,
  environmentId: string,
): Promise<WorkingState | null> {
  let status: Awaited<ReturnType<typeof bb.sdk.environments.status>>;
  try {
    status = await bb.sdk.environments.status({ environmentId });
  } catch {
    return null;
  }
  if (status.outcome !== "available") return null;
  const { workingTree, checkout } = status.workspace;
  const branch = checkout.kind === "branch" || checkout.kind === "unborn" ? checkout.branchName : null;
  const headSha = "headSha" in checkout ? checkout.headSha : null;
  const files: WorkingFile[] = workingTree.files.map((file) => ({
    path: file.path,
    status: file.status,
  }));
  const state: WorkingState = {
    branch,
    headSha,
    dirty: workingTree.hasUncommittedChanges || files.length > 0,
    files,
    insertions: workingTree.insertions,
    deletions: workingTree.deletions,
    patch: null,
    patchTruncated: false,
    note: null,
  };
  if (!state.dirty) return state;

  try {
    const result = await bb.sdk.environments.diffPatch({
      environmentId,
      target: { type: "uncommitted" },
      paths: files.map((file) => file.path),
    });
    if (result.outcome !== "available") {
      state.note = "message" in result ? result.message : result.failure.message;
      return state;
    }
    const chunks: string[] = [];
    let bytes = 0;
    for (const entry of result.patches) {
      const text = entry.patch.endsWith("\n") ? entry.patch : `${entry.patch}\n`;
      if (bytes + text.length > MAX_PATCH_BYTES) {
        state.patchTruncated = true;
        break;
      }
      chunks.push(text);
      bytes += text.length;
      if (entry.truncated) state.patchTruncated = true;
    }
    state.patch = chunks.length > 0 ? chunks.join("") : null;
    if (state.patch === null) state.note = "No diff could be produced for the uncommitted files.";
  } catch (error) {
    state.note = error instanceof Error ? error.message : String(error);
  }
  return state;
}

/**
 * Put the source machine's uncommitted patch on the target machine, where the
 * receiving agent can actually read and apply it. Returns the absolute path,
 * or null when the write failed (never fatal — the handoff still goes).
 */
export async function deliverPatch(
  bb: BbPluginApi,
  options: { hostId: string; sourceThreadId: string; patch: string },
): Promise<string | null> {
  const path = `/tmp/bb-handoff-${options.sourceThreadId}.patch`;
  try {
    const written = await bb.sdk.files.write({
      hostId: options.hostId,
      path,
      content: options.patch,
      createParents: true,
    });
    return written.outcome === "written" ? path : null;
  } catch {
    return null;
  }
}
