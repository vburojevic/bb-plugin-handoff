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
import {
  listHandoffs,
  renderHandoff,
  settleBriefing,
  settleVerification,
  startHandoff,
  TransferError,
  type WorkspaceMode,
} from "./handoff";
import {
  captureWorkingState,
  listMachines,
  matchMachine,
  planTransfer,
  listProvidersBounded,
  projectSources,
  sourcePathOnHost,
  sourcePathOnHostFrom,
  type TransferPlan,
} from "./machines";

const workspaceModeSchema = z.enum(["reuse", "checkout", "worktree", "personal"]);

/**
 * Thinking effort for the target thread. Mirrors bb's `ReasoningLevel`, which
 * the SDK declares but does not export. Never offer these blind: the levels a
 * model actually accepts differ per model, and `providers.models()` reports
 * them, so the picker is driven by `supportedReasoningEfforts` rather than by
 * this full set.
 */
const reasoningLevelSchema = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
]);

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
    /** machineId re-scopes provider discovery to the machine being targeted. */
    input: z.object({ threadId: z.string(), machineId: z.string().optional() }).strict(),
    output: z.object({
      providers: z.array(
        z.object({
          id: z.string(),
          displayName: z.string(),
          available: z.boolean(),
          logoUrl: z.string().nullable(),
        }),
      ),
      machines: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          connected: z.boolean(),
          isSource: z.boolean(),
          /** Whether this project has a checkout there (gates "checkout"). */
          hasCheckout: z.boolean(),
        }),
      ),
      sourceMachineId: z.string().nullable(),
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
    input: z
      .object({ threadId: z.string(), providerId: z.string(), machineId: z.string().optional() })
      .strict(),
    output: z.object({
      models: z.array(
        z.object({
          model: z.string(),
          displayName: z.string(),
          /** The model the provider picks when the handoff names none. */
          isDefault: z.boolean(),
          defaultReasoningEffort: reasoningLevelSchema,
          supportedReasoningEfforts: z.array(
            z.object({ reasoningEffort: reasoningLevelSchema, description: z.string() }),
          ),
        }),
      ),
    }),
  },
  startHandoff: {
    input: z
      .object({
        threadId: z.string(),
        providerId: z.string(),
        model: z.string().optional(),
        workspace: workspaceModeSchema,
        machineId: z.string().optional(),
        extraInstructions: z.string().optional(),
        upToSeq: upToSeqField,
        briefing: z.boolean().optional(),
        reasoningLevel: reasoningLevelSchema.optional(),
      })
      .strict(),
    output: z.object({
      newThreadId: z.string(),
      docBytes: z.number(),
      briefing: z.enum(["included", "skipped-busy", "skipped-unanswered", "off"]),
      targetMachine: z.string().nullable(),
      crossMachine: z.boolean(),
      patchPath: z.string().nullable(),
      notes: z.array(z.string()),
    }),
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
          reasoningLevel: reasoningLevelSchema.nullable().optional(),
          workspace: workspaceModeSchema,
          at: z.number(),
          verification: z.enum(["pending", "confirmed", "failed"]).optional(),
          targetMachine: z.string().nullable().optional(),
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

/** The machine a thread runs on, and the project it belongs to. */
async function threadLocation(
  bb: BbPluginApi,
  threadId: string,
): Promise<{ projectId: string | null; hostId: string | null }> {
  // deno-lint-ignore no-explicit-any
  const thread = (await bb.sdk.threads.get({ threadId })) as any;
  const projectId: string | null = thread.projectId ?? null;
  if (!thread.environmentId) return { projectId, hostId: null };
  try {
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    return { projectId, hostId: environment.hostId ?? null };
  } catch {
    return { projectId, hostId: null };
  }
}

export default async function plugin(bb: BbPluginApi) {
  // Settle any handoff waiting on its source thread's briefing turn, and
  // verify fresh handoff targets when their first turn finishes.
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    settleBriefing(thread.id, lastAssistantText);
    void settleVerification(bb, thread.id, true, lastAssistantText).catch((error) => {
      bb.log.warn(`verification settle failed: ${error instanceof Error ? error.message : error}`);
    });
  });
  bb.events.on("thread.failed", ({ thread }) => {
    settleBriefing(thread.id, null);
    void settleVerification(bb, thread.id, false).catch((error) => {
      bb.log.warn(`verification settle failed: ${error instanceof Error ? error.message : error}`);
    });
  });

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
    async listTargets({ threadId, machineId }) {
      const [{ projectId, hostId }, machines] = await Promise.all([
        threadLocation(bb, threadId),
        listMachines(bb).catch(() => []),
      ]);
      const target = machineId ? matchMachine(machines, machineId) : null;
      // Providers are discovered per machine: the target's CLIs decide what
      // this handoff can actually land on, not the source's.
      const environmentId = target ? null : await environmentIdOfThread(bb, threadId);
      // Discovering a target machine's provider CLIs is a round trip to that
      // machine. Unbounded, one sleeping laptop held this handler — and bb's
      // event loop with it — for seconds; an empty list just means "we could
      // not ask", which the picker already renders as nothing available.
      const providers = await listProvidersBounded(
        bb,
        target ? { hostId: target.id } : environmentId ? { environmentId } : undefined,
      );
      // One project fetch for every machine, not one per machine: this is a
      // pure filter over the project's sources once we have them.
      const sources = projectId === null ? [] : await projectSources(bb, projectId);
      const checkouts = machines.map((machine) =>
        sourcePathOnHostFrom(sources, machine.id) !== null,
      );
      return {
        providers: providers.map((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
          logoUrl: provider.logoUrl ?? null,
        })),
        machines: machines.map((machine, index) => ({
          id: machine.id,
          name: machine.name,
          connected: machine.connected,
          isSource: machine.id === hostId,
          hasCheckout: checkouts[index] ?? false,
        })),
        sourceMachineId: hostId,
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
    async listModels({ threadId, providerId, machineId }) {
      const machines = machineId ? await listMachines(bb).catch(() => []) : [];
      const target = machineId ? matchMachine(machines, machineId) : null;
      const environmentId = target ? null : await environmentIdOfThread(bb, threadId);
      const options = await bb.sdk.providers.models(
        target
          ? { hostId: target.id, providerId }
          : environmentId
            ? { environmentId, providerId }
            : { providerId },
      );
      return {
        models: options.models.map((model) => ({
          model: model.model,
          displayName: model.displayName,
          isDefault: model.isDefault,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts.map((effort) => ({
            reasoningEffort: effort.reasoningEffort,
            description: effort.description,
          })),
        })),
      };
    },
    async startHandoff({
      threadId,
      providerId,
      model,
      workspace,
      machineId,
      extraInstructions,
      upToSeq,
      briefing,
      reasoningLevel,
    }) {
      const result = await startHandoff(bb, {
        sourceThreadId: threadId,
        providerId,
        model,
        workspace,
        machine: machineId,
        extraInstructions,
        untilSeq: upToSeq,
        briefing,
        reasoningLevel,
      });
      const where = result.crossMachine ? ` on ${result.targetMachine}` : "";
      bb.log.info(`handoff ${threadId} → ${providerId}${where} (${result.newThreadId})`);
      return {
        newThreadId: result.newThreadId,
        docBytes: result.docBytes,
        briefing: result.briefing,
        targetMachine: result.targetMachine,
        crossMachine: result.crossMachine,
        patchPath: result.patchPath,
        notes: result.notes,
      };
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
        summary:
          "Capture a thread and spawn a new thread on another provider — and optionally another machine — seeded with it",
        usage:
          "bb handoff <thread-id|--self> --to <provider> [--machine <host>] [--model <model>] [--effort <level>] [--workspace reuse|checkout|worktree|personal] [--instructions <text>] [--up-to-seq <n>] [--briefing] [--dry-run]",
      },
      {
        name: "export",
        summary: "Write the handoff document to a file (for codex exec / claude -p outside bb)",
        usage: "bb handoff export <thread-id|--self> [--out <path>]",
      },
      {
        name: "targets",
        summary: "List target providers available for a thread's host",
        usage: "bb handoff targets [--thread <thread-id>] [--json]",
      },
      { name: "list", summary: "Show past handoffs", usage: "bb handoff list [--json]" },
    ],
    async run(argv, ctx) {
      // The adopt direction owns its own argv grammar (ids, resume commands,
      // --cwd/--agent/…), so it is dispatched before handoff's flag parsing.
      if (argv[0] === "adopt") {
        return runAdoptCli(bb, argv.slice(1), { cwd: ctx.cwd, threadId: ctx.threadId });
      }
      const fail = (message: string) => ({ exitCode: 1, stderr: `${message}\n` });
      const BOOLEAN_FLAGS = new Set(["--self", "--dry-run", "--json", "--help", "--briefing"]);
      const flags = new Map<string, string>();
      const positional: string[] = [];
      for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!;
        if (BOOLEAN_FLAGS.has(arg)) flags.set(arg, "true");
        else if (arg.startsWith("--")) flags.set(arg, argv[++i] ?? "");
        else positional.push(arg);
      }
      const resolveThreadId = (candidate: string | undefined): string | null => {
        if (flags.has("--self")) return ctx.threadId ?? null;
        if (candidate && candidate.startsWith("thr_")) return candidate;
        return ctx.threadId ?? null;
      };

      const command = positional[0] && !positional[0].startsWith("thr_") ? positional.shift()! : "start";

      if (command === "help" || flags.has("--help")) {
        const help = [
          "bb handoff — move a session between agents and machines, in both directions",
          "",
          "  bb handoff <thread-id|--self> --to <provider> [--machine <host>] [--model <m>]",
          "             [--effort none|low|medium|high|xhigh|ultracode|max|ultra]",
          "             [--workspace reuse|checkout|worktree|personal]",
          "             [--instructions <text>] [--up-to-seq <n>] [--briefing] [--dry-run]",
          "             --effort sets the new thread's thinking effort; omit to use the",
          "             target model's own default. Run `bb handoff targets` for providers,",
          "             and note that the levels a model accepts vary by model.",
          "             --briefing asks the (idle) source agent for a handoff note first",
          "             --machine runs the new thread on another enrolled machine. The source's",
          "             uncommitted work travels with it as a patch; reuse is same-machine only,",
          "             so pick checkout (that machine's project checkout), worktree, or personal.",
          "  bb handoff export <thread-id|--self> [--out <path>]",
          "  bb handoff targets [--thread <thread-id>] [--machine <host>] [--json]",
          "  bb handoff list [--json]",
          "  bb handoff adopt …   (see `bb handoff adopt help`)",
        ].join("\n");
        return { exitCode: 0, stdout: `${help}\n` };
      }

      if (command === "list") {
        const handoffs = await listHandoffs(bb);
        if (flags.has("--json")) {
          return { exitCode: 0, stdout: `${JSON.stringify({ handoffs }, null, 2)}\n` };
        }
        if (handoffs.length === 0) return { exitCode: 0, stdout: "No handoffs recorded yet.\n" };
        const lines = handoffs.map(
          (record) =>
            `${new Date(record.at).toISOString()}  ${record.sourceThreadId} (${record.sourceProvider}) → ${record.targetThreadId} (${record.targetProvider}${record.model ? `/${record.model}` : ""}${record.reasoningLevel ? ` @${record.reasoningLevel}` : ""}, ${record.workspace}${record.targetMachine ? ` @ ${record.targetMachine}` : ""})`,
        );
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      if (command === "targets") {
        const threadId = flags.get("--thread") ?? ctx.threadId;
        const machineFlag = flags.get("--machine");
        const machines = await listMachines(bb).catch(() => []);
        const target = machineFlag ? matchMachine(machines, machineFlag) : null;
        if (machineFlag && !target) {
          return fail(
            `Unknown machine "${machineFlag}". Enrolled machines: ${machines.map((m) => m.name).join(", ") || "(none)"}`,
          );
        }
        const environmentId =
          target || !threadId ? null : await environmentIdOfThread(bb, threadId);
        const providers = await bb.sdk.providers.list(
          target ? { hostId: target.id } : environmentId ? { environmentId } : undefined,
        );
        if (flags.has("--json")) {
          const payload = providers.map((provider) => ({
            id: provider.id,
            displayName: provider.displayName,
            available: provider.available,
          }));
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ machine: target?.name ?? null, providers: payload, machines }, null, 2)}\n`,
          };
        }
        const lines = providers.map(
          (provider) => `${provider.id}\t${provider.displayName}${provider.available ? "" : "\t(unavailable)"}`,
        );
        const machineLines = machines.map(
          (machine) =>
            `${machine.name}\t${machine.id}${machine.connected ? "" : "\t(disconnected)"}${machine.isPrimary ? "\t(primary)" : ""}`,
        );
        const header = target ? `Providers on ${target.name}:\n` : "";
        return {
          exitCode: 0,
          stdout: `${header}${lines.join("\n")}\n\nMachines:\n${machineLines.join("\n")}\n`,
        };
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
        const machine = flags.get("--machine") || undefined;
        // Crossing machines cannot reuse the source environment, so a bare
        // --machine defaults to that machine's checkout of the same project.
        const workspace = (flags.get("--workspace") ?? (machine ? "checkout" : "reuse")) as WorkspaceMode;
        if (!workspaceModeSchema.safeParse(workspace).success) {
          return fail("--workspace must be reuse, checkout, worktree, or personal.");
        }
        const upToSeqRaw = flags.get("--up-to-seq");
        const upToSeq = upToSeqRaw ? Number.parseInt(upToSeqRaw, 10) : undefined;
        if (upToSeqRaw && (!Number.isInteger(upToSeq) || upToSeq! <= 0)) {
          return fail("--up-to-seq must be a positive integer (a message's sourceSeqEnd).");
        }
        const effortRaw = flags.get("--effort");
        const effort = effortRaw ? reasoningLevelSchema.safeParse(effortRaw) : null;
        if (effortRaw && !effort?.success) {
          return fail(`--effort must be one of ${reasoningLevelSchema.options.join(", ")}.`);
        }
        const reasoningLevel = effort?.success ? effort.data : undefined;
        if (flags.has("--dry-run")) {
          const captured = await captureThread(bb, threadId, { untilSeq: upToSeq });
          let plan: TransferPlan;
          try {
            plan = await planTransfer(bb, {
              projectId: captured.projectId,
              sourceHostId: captured.hostId,
              sourceBranch: captured.branchName,
              hasEnvironment: captured.environmentId != null,
              workspace,
              machine,
            });
          } catch (error) {
            if (error instanceof TransferError) return fail(error.message);
            throw error;
          }
          const doc = renderHandoff(captured, new Date(), null, { transfer: plan });
          const working =
            plan.crossMachine && captured.environmentId
              ? await captureWorkingState(bb, captured.environmentId)
              : null;
          const stats = [
            `Source: ${captured.title} (${captured.providerId}, ${threadId})`,
            `Turns: ${captured.turns}, transcript entries: ${captured.entries.length}, events: ${captured.eventCount}`,
            `Handoff document: ${new TextEncoder().encode(doc).byteLength} bytes`,
            `Scope: ${captured.untilSeq != null ? `partial — events up to seq ${captured.untilSeq}` : "full thread"}`,
            `Native session file: ${captured.nativeSessionPath ?? "(not found)"}`,
            `Workspace: ${captured.workspacePath ?? "(none)"}`,
            `Target machine: ${plan.hostName ?? "(source machine)"}${plan.crossMachine ? " — cross-machine handoff" : ""}`,
            `Target workspace: ${plan.workspace}${plan.checkoutPath ? ` (${plan.checkoutPath})` : ""}${plan.baseBranch ? ` based on ${plan.baseBranch}` : ""}`,
            ...(working?.dirty
              ? [
                  `Uncommitted work to carry: ${working.files.length} file(s), +${working.insertions}/-${working.deletions}${working.patch ? "" : " — NO PATCH AVAILABLE"}`,
                ]
              : plan.crossMachine
                ? ["Uncommitted work to carry: none (source tree is clean)"]
                : []),
            ...plan.notes.map((note) => `Note: ${note}`),
          ];
          return { exitCode: 0, stdout: `${stats.join("\n")}\n` };
        }
        if (!providerId) return fail("Missing --to <provider>. See `bb handoff targets`.");
        let result: Awaited<ReturnType<typeof startHandoff>>;
        try {
          result = await startHandoff(bb, {
            sourceThreadId: threadId,
            providerId,
            model: flags.get("--model"),
            reasoningLevel,
            workspace,
            machine,
            extraInstructions: flags.get("--instructions"),
            untilSeq: upToSeq,
            briefing: flags.has("--briefing"),
          });
        } catch (error) {
          if (error instanceof TransferError) return fail(error.message);
          throw error;
        }
        const where = result.crossMachine ? ` on ${result.targetMachine}` : "";
        const extra = [
          result.patchPath ? `Carried the source's uncommitted changes to ${result.patchPath}.` : "",
          ...result.notes,
        ].filter(Boolean);
        return {
          exitCode: 0,
          stdout: `Handed off ${threadId} → ${providerId}${where}. New thread: ${result.newThreadId} (doc ${result.docBytes} bytes)\n${extra.map((line) => `${line}\n`).join("")}`,
        };
      }

      return fail(`Unknown command "${command}". Commands: start, export, targets, list, adopt.`);
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
