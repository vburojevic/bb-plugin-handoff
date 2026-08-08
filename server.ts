// bb-plugin-handoff — move a session between agents, in both directions.
//
// Out: capture a bb thread's full transcript from bb's provider-independent
// event log, render a handoff document, and spawn a new thread on any
// installed provider (Codex, Claude Code, Cursor, …) seeded with it.
// In ("adopt", see adopt/): take a session that ran OUTSIDE bb — Claude Code,
// Codex, or Gemini CLI — and continue it as a bb thread.
import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";
import { adoptCommandSpecs, runAdoptCli } from "./adopt/cli";
import { adoptRpcShape, createAdoptRpcHandlers } from "./adopt/rpc";
import { captureThread } from "./capture";
import { listHandoffs, renderHandoff, startHandoff, type WorkspaceMode } from "./handoff";

const workspaceModeSchema = z.enum(["reuse", "worktree", "personal"]);

/** Event-seq cutoff of one chat message; scopes the capture to everything up to it. */
const upToSeqField = z.number().int().positive().optional();

export const rpcContract = defineRpcContract({
  ...adoptRpcShape,
  prepareHandoff: {
    input: z.object({ threadId: z.string(), upToSeq: upToSeqField }).strict(),
    output: z.object({
      title: z.string(),
      providerId: z.string(),
      turns: z.number(),
      entries: z.number(),
      docBytes: z.number(),
      nativeSessionPath: z.string().nullable(),
      workspacePath: z.string().nullable(),
      branchName: z.string().nullable(),
      hasEnvironment: z.boolean(),
    }),
  },
  listTargets: {
    input: z.object({ threadId: z.string() }).strict(),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          available: z.boolean(),
          logoUrl: z.string().nullable(),
        }),
      ),
    }),
  },
  previewHandoff: {
    input: z.object({ threadId: z.string(), upToSeq: upToSeqField }).strict(),
    output: z.object({
      doc: z.string(),
      docBytes: z.number(),
      truncated: z.boolean(),
    }),
  },
  listModels: {
    input: z.object({ threadId: z.string(), providerId: z.string() }).strict(),
    output: z.object({
      models: z.array(z.object({ model: z.string(), displayName: z.string() })),
    }),
  },
  startHandoff: {
    input: z
      .object({
        threadId: z.string(),
        providerId: z.string(),
        model: z.string().optional(),
        workspace: workspaceModeSchema,
        extraInstructions: z.string().optional(),
        upToSeq: upToSeqField,
      })
      .strict(),
    output: z.object({ newThreadId: z.string(), docBytes: z.number() }),
  },
  history: {
    input: z.null(),
    output: z.object({
      handoffs: z.array(
        z.object({
          sourceThreadId: z.string(),
          sourceProvider: z.string(),
          targetThreadId: z.string(),
          targetProvider: z.string(),
          model: z.string().nullable(),
          workspace: workspaceModeSchema,
          at: z.number(),
        }),
      ),
    }),
  },
});

async function environmentIdOfThread(bb: BbPluginApi, threadId: string): Promise<string | null> {
  // deno-lint-ignore no-explicit-any
  const thread = (await bb.sdk.threads.get({ threadId })) as any;
  return thread.environmentId ?? null;
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    ...createAdoptRpcHandlers(bb),
    async prepareHandoff({ threadId, upToSeq }) {
      const captured = await captureThread(bb, threadId, { untilSeq: upToSeq });
      const doc = renderHandoff(captured, new Date());
      return {
        title: captured.title,
        providerId: captured.providerId,
        turns: captured.turns,
        entries: captured.entries.length,
        docBytes: new TextEncoder().encode(doc).byteLength,
        nativeSessionPath: captured.nativeSessionPath,
        workspacePath: captured.workspacePath,
        branchName: captured.branchName,
        hasEnvironment: captured.environmentId != null,
      };
    },
    async listTargets({ threadId }) {
      const environmentId = await environmentIdOfThread(bb, threadId);
      const providers = await bb.sdk.providers.list(
        environmentId ? { environmentId } : undefined,
      );
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
          logoUrl: provider.logoUrl ?? null,
        })),
      };
    },
    async previewHandoff({ threadId, upToSeq }) {
      const captured = await captureThread(bb, threadId, { untilSeq: upToSeq });
      const doc = renderHandoff(captured, new Date());
      const docBytes = new TextEncoder().encode(doc).byteLength;
      const PREVIEW_CAP = 250_000;
      const truncated = doc.length > PREVIEW_CAP;
      return {
        doc: truncated ? `${doc.slice(0, PREVIEW_CAP)}\n\n… _(preview truncated)_` : doc,
        docBytes,
        truncated,
      };
    },
    async listModels({ threadId, providerId }) {
      const environmentId = await environmentIdOfThread(bb, threadId);
      const options = await bb.sdk.providers.models(
        environmentId ? { environmentId, providerId } : { providerId },
      );
      return {
        models: options.models.map((model) => ({
          model: model.model,
          displayName: model.displayName,
        })),
      };
    },
    async startHandoff({ threadId, providerId, model, workspace, extraInstructions, upToSeq }) {
      const result = await startHandoff(bb, {
        sourceThreadId: threadId,
        providerId,
        model,
        workspace,
        extraInstructions,
        untilSeq: upToSeq,
      });
      bb.log.info(`handoff ${threadId} → ${providerId} (${result.newThreadId})`);
      return { newThreadId: result.newThreadId, docBytes: result.docBytes };
    },
    async history() {
      return { handoffs: await listHandoffs(bb) };
    },
  });

  bb.cli.register({
    name: "handoff",
    summary: "Move a session between agents — hand off a bb thread, or adopt an external one",
    commands: [
      ...adoptCommandSpecs,
      {
        name: "start",
        summary: "Capture a thread and spawn a new thread on another provider seeded with it",
        usage:
          "bb handoff <thread-id|--self> --to <provider> [--model <model>] [--workspace reuse|worktree|personal] [--instructions <text>] [--up-to-seq <n>] [--dry-run]",
      },
      {
        name: "export",
        summary: "Write the handoff document to a file (for codex exec / claude -p outside bb)",
        usage: "bb handoff export <thread-id|--self> [--out <path>]",
      },
      {
        name: "targets",
        summary: "List target providers available for a thread's host",
        usage: "bb handoff targets [--thread <thread-id>]",
      },
      { name: "list", summary: "Show past handoffs", usage: "bb handoff list" },
    ],
    async run(argv, ctx) {
      // The adopt direction owns its own argv grammar (ids, resume commands,
      // --cwd/--agent/…), so it is dispatched before handoff's flag parsing.
      if (argv[0] === "adopt") {
        return runAdoptCli(bb, argv.slice(1), { cwd: ctx.cwd, threadId: ctx.threadId });
      }
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n` });
      const flags = new Map<string, string>();
      const positional: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === "--self" || arg === "--dry-run") flags.set(arg, "true");
        else if (arg.startsWith("--")) flags.set(arg, argv[++i] ?? "");
        else positional.push(arg);
      }
      const resolveThreadId = (candidate: string | undefined): string | null => {
        if (flags.has("--self")) return ctx.threadId ?? null;
        if (candidate && candidate.startsWith("thr_")) return candidate;
        return ctx.threadId ?? null;
      };

      const command = positional[0] && !positional[0].startsWith("thr_") ? positional.shift()! : "start";

      if (command === "list") {
        const handoffs = await listHandoffs(bb);
        if (handoffs.length === 0) return { exitCode: 0, stdout: "No handoffs recorded yet.\n" };
        const lines = handoffs.map(
          (record) =>
            `${new Date(record.at).toISOString()}  ${record.sourceThreadId} (${record.sourceProvider}) → ${record.targetThreadId} (${record.targetProvider}${record.model ? `/${record.model}` : ""}, ${record.workspace})`,
        );
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      if (command === "targets") {
        const threadId = flags.get("--thread") ?? ctx.threadId;
        const environmentId = threadId ? await environmentIdOfThread(bb, threadId) : null;
        const providers = await bb.sdk.providers.list(environmentId ? { environmentId } : undefined);
        const lines = providers.map(
          (provider) => `${provider.id}\t${provider.displayName}${provider.available ? "" : "\t(unavailable)"}`,
        );
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      if (command === "export") {
        const threadId = resolveThreadId(positional[0]);
        if (!threadId) return fail("No thread. Pass a thread id or run with --self inside a bb thread.");
        const captured = await captureThread(bb, threadId);
        const doc = renderHandoff(captured, new Date());
        const out = flags.get("--out") ?? `handoff-${threadId}.md`;
        const absolute = out.startsWith("/") ? out : `${ctx.cwd ?? captured.workspacePath ?? "."}/${out}`;
        // Multi-machine rule: write on the invoking thread's host when known,
        // otherwise the server host — never blindly on run()'s filesystem.
        let hostId: string | undefined;
        if (ctx.threadId) {
          const environmentId = await environmentIdOfThread(bb, ctx.threadId);
          if (environmentId) hostId = (await bb.sdk.environments.get({ environmentId })).hostId;
        }
        const written = await bb.sdk.files.write({ hostId, path: absolute, content: doc, createParents: true });
        if (written.outcome !== "written") return fail(`Could not write ${absolute}: ${written.outcome}`);
        return {
          exitCode: 0,
          stdout: `Wrote ${written.sizeBytes} bytes to ${absolute}\nUse it outside bb, e.g.: codex exec - < ${absolute}\n`,
        };
      }

      if (command === "start") {
        const threadId = resolveThreadId(positional[0]);
        if (!threadId) return fail("No thread. Pass a thread id or run with --self inside a bb thread.");
        const providerId = flags.get("--to");
        const workspace = (flags.get("--workspace") ?? "reuse") as WorkspaceMode;
        if (!workspaceModeSchema.safeParse(workspace).success) {
          return fail("--workspace must be reuse, worktree, or personal.");
        }
        const upToSeqRaw = flags.get("--up-to-seq");
        const upToSeq = upToSeqRaw ? Number.parseInt(upToSeqRaw, 10) : undefined;
        if (upToSeqRaw && (!Number.isInteger(upToSeq) || upToSeq! <= 0)) {
          return fail("--up-to-seq must be a positive integer (a message's sourceSeqEnd).");
        }
        if (flags.has("--dry-run")) {
          const captured = await captureThread(bb, threadId, { untilSeq: upToSeq });
          const doc = renderHandoff(captured, new Date());
          const stats = [
            `Source: ${captured.title} (${captured.providerId}, ${threadId})`,
            `Turns: ${captured.turns}, transcript entries: ${captured.entries.length}, events: ${captured.eventCount}`,
            `Handoff document: ${new TextEncoder().encode(doc).byteLength} bytes`,
            `Scope: ${captured.untilSeq != null ? `partial — events up to seq ${captured.untilSeq}` : "full thread"}`,
            `Native session file: ${captured.nativeSessionPath ?? "(not found)"}`,
            `Workspace: ${captured.workspacePath ?? "(none)"}`,
          ];
          return { exitCode: 0, stdout: `${stats.join("\n")}\n` };
        }
        if (!providerId) return fail("Missing --to <provider>. See `bb handoff targets`.");
        const result = await startHandoff(bb, {
          sourceThreadId: threadId,
          providerId,
          model: flags.get("--model"),
          workspace,
          extraInstructions: flags.get("--instructions"),
          untilSeq: upToSeq,
        });
        return {
          exitCode: 0,
          stdout: `Handed off ${threadId} → ${providerId}. New thread: ${result.newThreadId} (doc ${result.docBytes} bytes)\n`,
        };
      }

      return fail(`Unknown command "${command}". Commands: start, export, targets, list, adopt.`);
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
