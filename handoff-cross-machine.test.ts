// Handing a session to another machine is the case where the transcript alone
// is a lie: the files the agent reads about are on a disk it cannot see. These
// tests pin down what travels and what the document promises.
import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";
import type { CapturedSession } from "./capture";
import { renderHandoff, startHandoff } from "./handoff";
import type { TransferPlan, WorkingState } from "./machines";

const MAC = { id: "host_mac", name: "Vedrans-MacBook-Pro", status: "connected" as const };
const MINI = { id: "host_mini", name: "mini", status: "connected" as const };

interface RecordedCall {
  method: string;
  args: unknown;
}

function makeFakeBb(options: { dirty?: boolean; patchWritable?: boolean } = {}) {
  const calls: RecordedCall[] = [];
  const kv = new Map<string, unknown>();
  const record = (method: string, args: unknown) => calls.push({ method, args });

  const files = options.dirty
    ? [{ path: "src/exporter.ts", status: "M", insertions: 40, deletions: 4 }]
    : [];

  const bb = {
    realtime: { publish: (channel: string, payload: unknown) => record(`realtime:${channel}`, payload) },
    storage: {
      kv: {
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => void kv.set(key, value),
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix?: string) => [...kv.keys()].filter((key) => key.startsWith(prefix ?? "")),
      },
    },
    sdk: {
      hosts: { list: async () => [MAC, MINI] },
      system: { config: async () => ({ primaryHostId: MAC.id }) },
      threads: {
        get: async () => ({
          id: "thr_src",
          title: "Stream the CSV exporter",
          providerId: "claude-code",
          projectId: "proj_1",
          environmentId: "env_1",
          status: "idle",
        }),
        events: async () => [],
        output: async () => ({ output: "Exporter half converted." }),
        spawn: async (args: unknown) => {
          record("threads.spawn", args);
          return { id: "thr_new" };
        },
      },
      environments: {
        get: async () => ({ hostId: MAC.id, path: "/Users/dev/Git/aurora", branchName: "feature-x" }),
        status: async () => ({
          outcome: "available",
          workspace: {
            workingTree: {
              insertions: options.dirty ? 40 : 0,
              deletions: options.dirty ? 4 : 0,
              files,
              hasUncommittedChanges: Boolean(options.dirty),
              state: options.dirty ? "dirty_uncommitted" : "clean",
            },
            checkout: { kind: "branch", branchName: "feature-x", headSha: "abc123def4567890" },
          },
        }),
        diffPatch: async (args: unknown) => {
          record("environments.diffPatch", args);
          return {
            outcome: "available",
            patches: [
              { path: "src/exporter.ts", patch: "--- a/src/exporter.ts\n+++ b/src/exporter.ts\n", truncated: false },
            ],
          };
        },
      },
      files: {
        list: async () => ({ files: [] }),
        write: async (args: unknown) => {
          record("files.write", args);
          return { outcome: options.patchWritable === false ? "denied" : "written", sizeBytes: 40 };
        },
      },
      projects: {
        list: async () => [
          {
            id: "proj_1",
            name: "aurora",
            sources: [
              { hostId: MAC.id, path: "/Users/dev/Git/aurora", isDefault: true },
              { hostId: MINI.id, path: "/Users/mini/Git/aurora" },
            ],
          },
        ],
        branches: async () => ({ branches: ["main"] }),
        attachments: {
          upload: async (args: unknown) => {
            record("attachments.upload", args);
            return {
              type: "localFile",
              path: "attachments/handoff.md",
              name: "handoff.md",
              sizeBytes: 10,
              mimeType: "text/markdown",
            };
          },
        },
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  // The event pager expects threads.events.list; keep it separate for clarity.
  // deno-lint-ignore no-explicit-any
  (bb.sdk.threads as any).events = {
    list: async () => [
      {
        seq: 1,
        type: "item/completed",
        data: { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "Stream it" }] } },
      },
    ],
  };
  return { bb: bb as unknown as BbPluginApi, calls, kv };
}

const uploadedDoc = (calls: RecordedCall[]): string => {
  const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
    clientFile: Uint8Array;
  };
  return new TextDecoder().decode(upload.clientFile);
};

describe("startHandoff across machines", () => {
  it("runs the new thread on the target machine's checkout of the same project", async () => {
    const { bb, calls } = makeFakeBb();
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "checkout",
      machine: "mini",
    });

    expect(result.crossMachine).toBe(true);
    expect(result.targetMachine).toBe("mini");
    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      environment: { type: string; hostId: string; workspace: { type: string; path: string } };
    };
    expect(spawn.environment).toMatchObject({
      type: "host",
      hostId: MINI.id,
      workspace: { type: "unmanaged", path: "/Users/mini/Git/aurora" },
    });
  });

  it("records the target machine in history", async () => {
    const { bb, kv } = makeFakeBb();
    await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "checkout",
      machine: "mini",
    });
    const record = [...kv.values()].find(
      (value) => (value as { targetThreadId?: string }).targetThreadId === "thr_new",
    ) as { targetMachine?: string };
    expect(record.targetMachine).toBe("mini");
  });

  it("carries uncommitted work to the target machine and points the agent at it", async () => {
    const { bb, calls } = makeFakeBb({ dirty: true });
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "checkout",
      machine: "mini",
    });

    expect(result.patchPath).toBe("/tmp/bb-handoff-thr_src.patch");
    const write = calls.find((call) => call.method === "files.write")!.args as {
      hostId: string;
      path: string;
      content: string;
    };
    // The patch has to land on the machine that will apply it.
    expect(write.hostId).toBe(MINI.id);
    expect(write.content).toContain("src/exporter.ts");

    const doc = uploadedDoc(calls);
    expect(doc).toContain("Working state on Vedrans-MacBook-Pro");
    expect(doc).toContain("git apply --3way /tmp/bb-handoff-thr_src.patch");
    expect(doc).toContain("NOT present in your workspace");

    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      input: { text?: string }[];
    };
    expect(spawn.input[0]!.text).toContain("/tmp/bb-handoff-thr_src.patch");
  });

  it("says the changes were stranded when the patch cannot be delivered", async () => {
    const { bb, calls } = makeFakeBb({ dirty: true, patchWritable: false });
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "checkout",
      machine: "mini",
    });
    expect(result.patchPath).toBeNull();
    expect(result.notes.join(" ")).toMatch(/could not be written to mini/);
    expect(uploadedDoc(calls)).toContain("could NOT be carried over");
  });

  it("does not look for a working tree when the machine does not change", async () => {
    const { bb, calls } = makeFakeBb({ dirty: true });
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
    });
    expect(result.crossMachine).toBe(false);
    expect(calls.some((call) => call.method === "files.write")).toBe(false);
    expect(calls.some((call) => call.method === "environments.diffPatch")).toBe(false);
  });

  it("refuses to reuse the source environment on another machine", async () => {
    const { bb } = makeFakeBb();
    await expect(
      startHandoff(bb, {
        sourceThreadId: "thr_src",
        providerId: "codex",
        workspace: "reuse",
        machine: "mini",
      }),
    ).rejects.toThrow(/lives on Vedrans-MacBook-Pro/);
  });

  it("bases a cross-machine worktree on the default branch and warns when the branch is missing", async () => {
    const { bb, calls } = makeFakeBb();
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "worktree",
      machine: "mini",
    });
    expect(result.notes[0]).toMatch(/feature-x.*does not exist on mini/);
    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      environment: { workspace: { baseBranch: { kind: string } } };
    };
    expect(spawn.environment.workspace.baseBranch).toEqual({ kind: "default" });
  });
});

// --- Document wording -------------------------------------------------------

const CAPTURED: CapturedSession = {
  threadId: "thr_src",
  title: "Stream the CSV exporter",
  providerId: "claude-code",
  projectId: "proj_1",
  environmentId: "env_1",
  hostId: "host_mac",
  workspacePath: "/Users/dev/Git/aurora",
  branchName: "feature-x",
  providerThreadId: "sess-1",
  entries: [{ seq: 1, kind: "user", body: "Stream it" }],
  turns: 1,
  eventCount: 1,
  latestOutput: "Half done.",
  nativeSessionPath: "/Users/dev/.claude/projects/-Users-dev-Git-aurora/sess-1.jsonl",
  untilSeq: null,
};

const CROSS: TransferPlan = {
  hostId: "host_mini",
  hostName: "mini",
  crossMachine: true,
  sourceHostName: "Vedrans-MacBook-Pro",
  workspace: "checkout",
  checkoutPath: "/Users/mini/Git/aurora",
  baseBranch: null,
  notes: [],
};

const CLEAN: WorkingState = {
  branch: "feature-x",
  headSha: "abc123def4567890",
  dirty: false,
  files: [],
  insertions: 0,
  deletions: 0,
  patch: null,
  patchTruncated: false,
  note: null,
};

describe("renderHandoff wording", () => {
  it("names both machines and stops claiming the source path is readable", () => {
    const doc = renderHandoff(CAPTURED, new Date(), null, { transfer: CROSS, working: CLEAN });
    expect(doc).toContain("handed off from Vedrans-MacBook-Pro to mini");
    expect(doc).toContain("DIFFERENT MACHINE");
    expect(doc).toContain("/Users/mini/Git/aurora");
    // The native session file is on the other machine — say so, don't offer it.
    expect(doc).toContain("is not readable from here");
    expect(doc).not.toContain("read that file directly");
  });

  it("tells a same-machine handoff to just look at the workspace", () => {
    const doc = renderHandoff(CAPTURED, new Date(), null, {
      transfer: { ...CROSS, crossMachine: false, hostName: "Vedrans-MacBook-Pro", workspace: "reuse" },
    });
    expect(doc).toContain("The workspace path above holds the live working state");
    expect(doc).not.toContain("DIFFERENT MACHINE");
  });

  it("reassures the next agent when the source tree was clean", () => {
    const doc = renderHandoff(CAPTURED, new Date(), null, { transfer: CROSS, working: CLEAN });
    expect(doc).toContain("nothing is stranded there");
  });

  it("flags a truncated patch as incomplete rather than authoritative", () => {
    const doc = renderHandoff(CAPTURED, new Date(), null, {
      transfer: CROSS,
      working: {
        ...CLEAN,
        dirty: true,
        files: [{ path: "src/a.ts", status: "M" }],
        insertions: 9,
        deletions: 1,
        patch: "diff",
        patchTruncated: true,
      },
      patchPath: "/tmp/p.patch",
    });
    expect(doc).toContain("truncated to fit, so it is incomplete");
  });

  it("surfaces planning notes in the document itself", () => {
    const doc = renderHandoff(CAPTURED, new Date(), null, {
      transfer: { ...CROSS, notes: ["Branch `feature-x` does not exist on mini"] },
    });
    expect(doc).toContain("- Note: Branch `feature-x` does not exist on mini");
  });

  it("keeps the dirty working-state section as separate markdown paragraphs", () => {
    const doc = renderHandoff(CAPTURED, new Date(), null, {
      transfer: CROSS,
      working: {
        ...CLEAN,
        dirty: true,
        files: [{ path: "src/a.ts", status: "M" }],
        insertions: 9,
        deletions: 1,
        patch: "diff",
        patchTruncated: false,
      },
      patchPath: "/tmp/p.patch",
    });
    // Paragraph breaks must survive: without them the branch line, the
    // uncommitted-changes warning, and the file list all merge into one
    // run-on paragraph when the document is rendered.
    expect(doc).toContain("at commit `abc123def456`.\n\n**It had uncommitted changes");
    expect(doc).toContain("unless you apply them.\n\n- `M` src/a.ts");
    expect(doc).toContain("where it stood:\n\n```\ngit apply --3way /tmp/p.patch\n```");
  });
});
