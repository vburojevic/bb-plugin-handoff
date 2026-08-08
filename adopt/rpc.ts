// RPC surface of the adopt direction, merged into the plugin's single
// contract in server.ts. Method names are namespaced under no prefix because
// they don't collide with the handoff methods.
import type { BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { collectSessions, performAdopt, performAdoptQuery, resolveProjectCwd } from "./adopt-core";

export const adoptRpcShape = {
  listProjects: {
    input: z.null(),
    output: z.object({
      projects: z.array(z.object({ id: z.string(), name: z.string(), path: z.string().nullable() })),
    }),
  },
  listSessions: {
    input: z
      .object({
        projectId: z.string().nullable(),
        cwd: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      cwd: z.string().nullable(),
      sessions: z.array(
        z.object({
          agent: z.string(),
          sessionId: z.string(),
          title: z.string().nullable(),
          modifiedAtMs: z.number(),
          sizeBytes: z.number(),
        }),
      ),
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
    async listSessions({ projectId, cwd }: { projectId: string | null; cwd: string | null }) {
      const resolvedCwd = cwd?.trim() || (projectId ? await resolveProjectCwd(bb, projectId) : null);
      if (!resolvedCwd) {
        return { cwd: null, sessions: [], error: projectId ? "Project has no source directory." : null };
      }
      const collected = collectSessions(resolvedCwd);
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
    },
    async adopt({
      query,
      agent,
      sessionId,
      cwd,
      force,
    }: {
      query: string | null;
      agent: string | null;
      sessionId: string | null;
      cwd: string | null;
      force?: boolean;
    }) {
      const outcome =
        query?.trim()
          ? await performAdoptQuery(bb, { query, cwd, force: force ?? false })
          : cwd
            ? await performAdopt(bb, {
                cwd,
                sessionId: sessionId ?? undefined,
                agent: agent ?? undefined,
                force: force ?? false,
              })
            : null;
      if (outcome === null) {
        return { ok: false, threadId: null, error: "Nothing to adopt.", existingThreadId: null, matches: null };
      }
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
    },
  };
}
