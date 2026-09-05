// RPC surface of the adopt direction, merged into the plugin's single
// contract in server.ts. Method names are namespaced under no prefix because
// they don't collide with the handoff methods.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { listMachines, matchMachine, type Machine } from "../machines";
import {
  collectSessions,
  listRemoteSessionsForDirectory,
  performAdopt,
  performAdoptQuery,
  performAdoptRemote,
  resolveProjectCwd,
  type AdoptOutcome,
  type RemoteListResult,
} from "./adopt-core";

const sessionRowSchema = z.object({
  agent: z.string(),
  sessionId: z.string(),
  title: z.string().nullable(),
  modifiedAtMs: z.number(),
  sizeBytes: z.number(),
});

export const adoptRpcShape = {
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable() })),
    }),
  },
  /** Enrolled machines, for adopting a session that lives on another one. */
  adoptMachines: {
    input: z.null(),
    output: z.object({
      machines: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          connected: z.boolean(),
          isPrimary: z.boolean(),
        }),
      ),
    }),
  },
  listSessions: {
    input: z
      .object({
        projectId: z.string().nullable(),
        cwd: z.string().nullable(),
        /** Read another enrolled machine's stores instead of this one's. */
        machineId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      cwd: z.string().nullable(),
      sessions: z.array(sessionRowSchema),
      error: z.string().nullable(),
    }),
  },
  adopt: {
    input: z
      .object({
        /** Pasted id / prefix / resume command; located across all agents. */
        query: z.string().nullable(),
        /** Direct adoption of a listed session (row tap). */
        agent: z.string().nullable(),
        sessionId: z.string().nullable(),
        /** Directory context: required for direct adoption, optional for query. */
        cwd: z.string().nullable(),
        force: z.boolean().optional(),
        /** Adopt from another enrolled machine; the thread then runs there. */
        machineId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string().nullable(),
      error: z.string().nullable(),
      existingThreadId: z.string().nullable(),
      matches: z
        .array(
          z.object({
            agent: z.string(),
            sessionId: z.string(),
            title: z.string().nullable(),
            cwd: z.string().nullable(),
            modifiedAtMs: z.number(),
          }),
        )
        .nullable(),
    }),
  },
} as const;

/**
 * The machine an adopt request targets, or null for the server's own machine
 * (the primary host, whose stores the local engine reads directly). Selecting
 * the primary machine explicitly normalizes to local, so the fast path never
 * depends on which of the two spellings the frontend sent.
 */
async function resolveRemoteTarget(
  bb: BbPluginApi,
  machineId: string | null | undefined,
): Promise<{ remote: Machine | null; error: string | null }> {
  if (!machineId) return { remote: null, error: null };
  const machines = await listMachines(bb).catch(() => []);
  const target = matchMachine(machines, machineId);
  if (!target) return { remote: null, error: `Unknown machine "${machineId}".` };
  const { primaryHostId } = await bb.sdk.system.config().catch(() => ({ primaryHostId: null }));
  if (target.id === primaryHostId) return { remote: null, error: null };
  if (!target.connected) {
    return {
      remote: null,
      error: `${target.name} is disconnected — bring it online to read its sessions.`,
    };
  }
  return { remote: target, error: null };
}

type AdoptRpcResult = {
  ok: boolean;
  threadId: string | null;
  error: string | null;
  existingThreadId: string | null;
  matches:
    | { agent: string; sessionId: string; title: string | null; cwd: string | null; modifiedAtMs: number }[]
    | null;
};

function adoptFailure(message: string): AdoptRpcResult {
  return { ok: false, threadId: null, error: message, existingThreadId: null, matches: null };
}

function mapOutcome(outcome: AdoptOutcome): AdoptRpcResult {
  if (!outcome.ok) {
    return {
      ok: false,
      threadId: null,
      error: outcome.message,
      existingThreadId: outcome.existingThreadId ?? null,
      matches:
        outcome.matches?.map((m) => ({
          agent: m.agent,
          sessionId: m.sessionId,
          title: m.title,
          cwd: m.cwd,
          modifiedAtMs: m.modifiedAtMs,
        })) ?? null,
    };
  }
  return {
    ok: true,
    threadId: outcome.dryRun ? null : outcome.threadId,
    error: null,
    existingThreadId: null,
    matches: null,
  };
}

export function createAdoptRpcHandlers(bb: BbPluginApi) {
  return {
    async listProjects() {
      const projects = await bb.sdk.projects.list();
      return {
        projects: projects.map((project) => {
          const source = project.sources.find((s) => s.isDefault) ?? project.sources[0];
          return { id: project.id, name: project.name, path: source?.path ?? null };
        }),
      };
    },
    async adoptMachines() {
      const machines = await listMachines(bb).catch(() => []);
      return {
        machines: machines.map((machine) => ({
          id: machine.id,
          name: machine.name,
          connected: machine.connected,
          isPrimary: machine.isPrimary,
        })),
      };
    },
    async listSessions({
      projectId,
      cwd,
      machineId,
    }: {
      projectId: string | null;
      cwd: string | null;
      machineId?: string;
    }) {
      const target = await resolveRemoteTarget(bb, machineId);
      if (target.error) return { cwd: null, sessions: [], error: target.error };
      const resolvedCwd =
        cwd?.trim() ||
        (projectId ? await resolveProjectCwd(bb, projectId, target.remote?.id) : null);
      if (!resolvedCwd) {
        return {
          cwd: null,
          sessions: [],
          error: projectId
            ? target.remote
              ? `Project has no source directory on ${target.remote.name} — enter the directory there.`
              : "Project has no source directory."
            : target.remote
              ? `Enter the session's directory on ${target.remote.name} to browse it.`
              : null,
        };
      }
      if (!target.remote) {
        const collected = await collectSessions(resolvedCwd);
        if ("error" in collected) return { cwd: resolvedCwd, sessions: [], error: collected.error };
        return {
          cwd: resolvedCwd,
          sessions: collected.slice(0, 20).map((s) => ({
            agent: s.agent,
            sessionId: s.sessionId,
            title: s.title,
            modifiedAtMs: s.modifiedAtMs,
            sizeBytes: s.sizeBytes,
          })),
          error: null,
        };
      }
      const result = await listRemoteSessionsForDirectory(bb, {
        machine: target.remote.id,
        cwd: resolvedCwd,
      });
      if ("error" in result && !("sessions" in result)) {
        return { cwd: resolvedCwd, sessions: [], error: result.error };
      }
      const listing = result as RemoteListResult;
      return {
        cwd: resolvedCwd,
        sessions: listing.sessions.slice(0, 20).map((s) => ({
          agent: s.agent,
          sessionId: s.sessionId,
          title: s.title,
          modifiedAtMs: s.modifiedAtMs,
          sizeBytes: s.sizeBytes,
        })),
        error: listing.error ?? null,
      };
    },
    async adopt({
      query,
      agent,
      sessionId,
      cwd,
      force,
      machineId,
    }: {
      query: string | null;
      agent: string | null;
      sessionId: string | null;
      cwd: string | null;
      force?: boolean;
      machineId?: string;
    }) {
      const target = await resolveRemoteTarget(bb, machineId);
      if (target.error) return adoptFailure(target.error);
      const trimmedCwd = cwd?.trim() || null;
      let outcome: AdoptOutcome | null = null;
      if (target.remote) {
        if (query?.trim()) {
          outcome = await performAdoptRemote(bb, {
            machine: target.remote.id,
            query,
            cwd: trimmedCwd,
            force: force ?? false,
          });
        } else if (sessionId) {
          outcome = await performAdoptRemote(bb, {
            machine: target.remote.id,
            sessionId,
            agent: agent ?? undefined,
            cwd: trimmedCwd,
            force: force ?? false,
          });
        }
      } else if (query?.trim()) {
        outcome = await performAdoptQuery(bb, { query, cwd: trimmedCwd, force: force ?? false });
      } else if (trimmedCwd) {
        outcome = await performAdopt(bb, {
          cwd: trimmedCwd,
          sessionId: sessionId ?? undefined,
          agent: agent ?? undefined,
          force: force ?? false,
        });
      }
      if (outcome === null) return adoptFailure("Nothing to adopt.");
      return mapOutcome(outcome);
    },
  };
}
