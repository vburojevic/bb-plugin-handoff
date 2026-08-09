// `bb handoff adopt …` — the CLI surface of the adopt direction: continue an
// external agent session (Claude Code, Codex, Gemini CLI) as a bb thread.
import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  collectSessions,
  listRemoteSessionsForDirectory,
  parseAdoptQuery,
  performAdopt,
  performAdoptQuery,
  performAdoptRemote,
  type RemoteListResult,
} from "./adopt-core";

interface Flags {
  positional: string[];
  values: Map<string, string>;
  booleans: Set<string>;
}

const BOOLEAN_FLAGS = new Set(["json", "dry-run", "force"]);

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { positional: [], values: new Map(), booleans: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) {
      flags.positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.values.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.booleans.add(name);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        flags.booleans.add(name);
      } else {
        flags.values.set(name, next);
        i += 1;
      }
    }
  }
  return flags;
}

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const ADOPT_HELP = `bb handoff adopt — continue an external agent session as a bb thread

Supports Claude Code, Codex, Gemini CLI, and OpenCode sessions.

Usage:
  bb handoff adopt <session-id | resume command>
      Paste an id, an id prefix, or a whole resume command like
      "claude --resume <id>" — located across every agent's session store.

  bb handoff adopt <session-id> --machine <host name or id> [--home <path>] [--cwd <path>]
  bb handoff adopt --machine <host> --cwd <path>
      Adopt a session that lives on another enrolled machine; the thread runs
      on that machine in the session's directory. With --cwd and no id, the
      newest session for that directory over there is adopted. All four agents
      are supported: Claude Code and Codex are found by id alone, Gemini and
      OpenCode need --cwd (or an exact id) since their ids are not in a path.
      --home overrides the remote home directory when it can't be derived.

  bb handoff adopt list [--cwd <path>] [--agent <name>] [--limit <n>] [--json]
  bb handoff adopt list --machine <host> --cwd <path>
      List adoptable sessions for a directory (newest first, all agents).
      With --machine, lists what is adoptable in that directory over there.

  bb handoff adopt session [<session-id>] [options]
      Create a bb thread that continues a session. Defaults to the newest
      session for the directory across all agents. Options:
        --cwd <path>             Session working directory (default: invoking cwd)
        --agent <name>           Only consider one agent: claude | codex | gemini | opencode
        --project <id>           Target bb project (default: match cwd, else create)
        --title <title>          Thread title
        --thread-provider <id>   bb provider for the new thread (default: same
                                 family as the session; gemini falls back to
                                 claude-code)
        --model <model>          Model override for the new thread
        --max-chars <n>          Transcript context budget (default 150000)
        --force                  Re-adopt a session that was already adopted
        --dry-run                Show what would happen without creating a thread
        --json                   Machine-readable output

Notes:
  Without --machine, sessions are read from the machine running the bb server.
  Run it from inside a live session's directory (or have the agent run it) —
  the newest session for that directory is the one you're in.`;

// One entry: bb rejects command names containing a space, so the `list` /
// `session` subcommands live in the usage line (and in full in the skill).
export const adoptCommandSpecs = [
  {
    name: "adopt",
    summary:
      "Adopt a session that ran outside bb (Claude Code, Codex, Gemini CLI, OpenCode) — on this machine or any enrolled one — as a bb thread; `adopt list` shows what is adoptable",
    usage:
      "bb handoff adopt [<session-id | resume command>] [--cwd <path>] [--agent claude|codex|gemini|opencode] [--machine <host>] [--home <path>] [--force] [--dry-run] [--json]  |  bb handoff adopt list [--machine <host>] [--cwd <path>] [--limit <n>]",
  },
];

export interface AdoptCliContext {
  cwd?: string | null;
  threadId?: string | null;
}

type CliResult = { exitCode: number; stdout?: string; stderr?: string };

/** Run `bb handoff adopt <argv…>` (argv excludes the "adopt" token). */
export async function runAdoptCli(
  bb: BbPluginApi,
  argv: string[],
  ctx: AdoptCliContext,
): Promise<CliResult> {
  const [first, ...restArgs] = argv;
  if (!first || first === "help" || first === "--help") {
    return { exitCode: 0, stdout: ADOPT_HELP };
  }
  let command = first;
  let rest = restArgs;
  if (command !== "list" && command !== "session") {
    // `bb handoff adopt <id | resume command>` shorthand for `… adopt session`,
    // and the id-less forms that say where to look instead (--machine/--cwd).
    // Probing goes through the flag parser so a flag's VALUE is never mistaken
    // for a pasted session id.
    const probe = parseArgs(argv);
    const parsedQuery = parseAdoptQuery(probe.positional.join(" ").trim());
    const routed = probe.values.has("machine") || probe.values.has("cwd");
    if (!parsedQuery.sessionId && !parsedQuery.newest && !routed) {
      return { exitCode: 1, stderr: `Unknown adopt command "${first}".\n\n${ADOPT_HELP}` };
    }
    command = "session";
    rest = argv;
  }
  const flags = parseArgs(rest);
  const machine = flags.values.get("machine");
  const cwd = flags.values.get("cwd") ?? ctx.cwd;
  if (!cwd && !machine) {
    return { exitCode: 1, stderr: "No working directory. Pass --cwd <path>." };
  }

  if (command === "list") {
    const limit = Number(flags.values.get("limit") ?? "10");
    const take = Number.isFinite(limit) ? limit : 10;
    if (machine) {
      // A remote listing is always directory-scoped: the invoking cwd is a
      // path on THIS machine, so it is never assumed to exist over there.
      const remoteCwd = flags.values.get("cwd");
      if (!remoteCwd) {
        return {
          exitCode: 1,
          stderr: `Listing sessions on another machine needs the directory there: bb handoff adopt list --machine ${machine} --cwd <path>`,
        };
      }
      const result = await listRemoteSessionsForDirectory(bb, {
        machine,
        cwd: remoteCwd,
        home: flags.values.get("home") ?? null,
        agent: flags.values.get("agent"),
      });
      if ("error" in result && !("sessions" in result)) {
        return { exitCode: 1, stderr: result.error };
      }
      const listing = result as RemoteListResult;
      const sessions = listing.sessions.slice(0, take);
      if (flags.booleans.has("json")) {
        return { exitCode: 0, stdout: JSON.stringify({ ...listing, sessions }, null, 2) };
      }
      if (sessions.length === 0) {
        return {
          exitCode: 0,
          stdout: `No agent sessions found for ${listing.cwd} on ${listing.machine}${listing.error ? `\n${listing.error}` : ""}`,
        };
      }
      const lines = sessions.map((session) => {
        const age = session.modifiedAtMs ? formatAge(Date.now() - session.modifiedAtMs) : "unknown";
        const size = session.sizeBytes ? `${Math.max(1, Math.round(session.sizeBytes / 1024))}KB` : "-";
        return `${session.agent.padEnd(7)} ${session.sessionId}  ${age.padEnd(9)} ${size.padEnd(8)} ${session.title ?? ""}`.trimEnd();
      });
      return {
        exitCode: 0,
        stdout: `Sessions for ${listing.cwd} on ${listing.machine} (newest first):\n${lines.join("\n")}${listing.error ? `\n\n${listing.error}` : ""}\n\nAdopt one with: bb handoff adopt <session-id> --machine ${machine} --cwd ${listing.cwd}`,
      };
    }
    const collected = collectSessions(cwd!, flags.values.get("agent"));
    if ("error" in collected) return { exitCode: 1, stderr: collected.error };
    const sessions = collected.slice(0, take);
    if (flags.booleans.has("json")) {
      return { exitCode: 0, stdout: JSON.stringify({ cwd, sessions }, null, 2) };
    }
    if (sessions.length === 0) {
      return { exitCode: 0, stdout: `No agent sessions found for ${cwd}` };
    }
    const lines = sessions.map((session) => {
      const age = formatAge(Date.now() - session.modifiedAtMs);
      const size = `${Math.max(1, Math.round(session.sizeBytes / 1024))}KB`;
      return `${session.agent.padEnd(7)} ${session.sessionId}  ${age.padEnd(9)} ${size.padEnd(8)} ${session.title ?? ""}`.trimEnd();
    });
    return {
      exitCode: 0,
      stdout: `Sessions for ${cwd} (newest first):\n${lines.join("\n")}\n\nAdopt one with: bb handoff adopt <session-id>`,
    };
  }

  const shared = {
    projectId: flags.values.get("project"),
    title: flags.values.get("title"),
    threadProviderId: flags.values.get("thread-provider"),
    model: flags.values.get("model"),
    maxChars: Number(flags.values.get("max-chars") ?? "150000"),
    force: flags.booleans.has("force"),
    dryRun: flags.booleans.has("dry-run"),
  };
  // A positional argument may be an id, an id prefix, or a whole pasted
  // resume command — route it through the query engine (global lookup).
  const positionalQuery = flags.positional.join(" ").trim();
  const agentFlag = flags.values.get("agent");
  if (machine && !positionalQuery && !flags.values.get("cwd")) {
    return {
      exitCode: 1,
      stderr: `Adopting from another machine needs a session id, or --cwd <path> for its newest session: bb handoff adopt <id> --machine ${machine}`,
    };
  }
  const outcome = machine
    ? await performAdoptRemote(bb, {
        machine,
        ...(positionalQuery
          ? { query: agentFlag ? `${agentFlag} ${positionalQuery}` : positionalQuery }
          : {}),
        cwd: flags.values.get("cwd") ?? null,
        home: flags.values.get("home") ?? null,
        agent: agentFlag,
        ...shared,
      })
    : positionalQuery
      ? await performAdoptQuery(bb, {
          query: agentFlag ? `${agentFlag} ${positionalQuery}` : positionalQuery,
          cwd: flags.values.get("cwd") ?? null,
          contextCwd: ctx.cwd ?? null,
          ...shared,
        })
      : await performAdopt(bb, { cwd: cwd!, agent: agentFlag, ...shared });

  if (!outcome.ok) {
    const matchLines = outcome.matches
      ?.map((m) => `  ${m.agent.padEnd(7)} ${m.sessionId}  ${m.cwd ?? "(directory unknown)"}`)
      .join("\n");
    const hint =
      outcome.code === "already-adopted"
        ? `\nOpen it with: bb thread open ${outcome.existingThreadId}\nPass --force to adopt it again.`
        : outcome.code === "not-found" && !machine
          ? `\nRun: bb handoff adopt list --cwd ${cwd}`
          : matchLines
            ? `\n${matchLines}`
            : "";
    return { exitCode: 1, stderr: `${outcome.message}${hint}` };
  }

  const { plan } = outcome;
  if (outcome.dryRun) {
    return flags.booleans.has("json")
      ? { exitCode: 0, stdout: JSON.stringify({ dryRun: true, ...plan }, null, 2) }
      : {
          exitCode: 0,
          stdout: `Dry run — would adopt ${plan.agentLabel} session ${plan.sessionId}\n  project:    ${plan.projectName}${plan.createdProject ? " (would be created)" : ` (${plan.projectId})`}\n  provider:   ${plan.providerId}${plan.providerNote}\n  directory:  ${plan.cwd}\n  title:      ${plan.title}\n  transcript: ${plan.userMessageCount} user / ${plan.assistantMessageCount} assistant messages, ${plan.transcriptChars} chars${plan.truncated ? " (truncated)" : ""}`,
        };
  }

  if (flags.booleans.has("json")) {
    return {
      exitCode: 0,
      stdout: JSON.stringify(
        {
          threadId: outcome.threadId,
          agent: plan.agent,
          sessionId: plan.sessionId,
          projectId: plan.projectId,
          providerId: plan.providerId,
          title: plan.title,
        },
        null,
        2,
      ),
    };
  }
  const warning = ctx.threadId
    ? "\nNote: you ran this from inside a bb thread — the adopted copy is a separate thread.\n"
    : "";
  return {
    exitCode: 0,
    stdout: `Adopted ${plan.agentLabel} session ${plan.sessionId} → thread ${outcome.threadId}\n  project:  ${plan.projectName}${plan.createdProject ? " (newly created for this directory)" : ""}\n  provider: ${plan.providerId}${plan.providerNote}\n  title:    ${plan.title}${warning}\nOpen it: bb thread open ${outcome.threadId}`,
  };
}
