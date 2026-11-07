import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { captureWorkingState, MAX_PATCH_BYTES, planTransfer, TransferError, type WorkspaceMode } from "./machines";

const MACBOOK = { id: "host_mac", name: "Vedrans-MacBook-Pro", status: "connected" as const };
const MINI = { id: "host_mini", name: "mini", status: "connected" as const };

interface FakeOptions {
  hosts?: { id: string; name: string; status: "connected" | "disconnected" }[];
  /** Project sources, by host. */
  sources?: { hostId: string; path: string; isDefault?: boolean }[];
  branches?: string[];
  primaryHostId?: string | null;
  hostsThrow?: boolean;
}

function makeBb(options: FakeOptions = {}) {
  const hosts = options.hosts ?? [MACBOOK, MINI];
  const sources = options.sources ?? [
    { hostId: MACBOOK.id, path: "/Users/dev/Git/aurora", isDefault: true },
    { hostId: MINI.id, path: "/Users/mini/Git/aurora" },
  ];
  const bb = {
    sdk: {
      hosts: {
        list: async () => {
          if (options.hostsThrow) throw new Error("daemon unreachable");
          return hosts;
        },
      },
      system: {
        config: async () => ({ primaryHostId: options.primaryHostId ?? MACBOOK.id }),
      },
      projects: {
        list: async () => [{ id: "proj_1", name: "aurora", sources }],
        branches: async ({ hostId }: { hostId: string }) => ({
          branches: hostId === MINI.id ? (options.branches ?? []) : ["main", "feature-x"],
        }),
      },
    },
  };
  return bb as unknown as BbPluginApi;
}

const BASE = {
  projectId: "proj_1",
  sourceHostId: MACBOOK.id,
  sourceBranch: "feature-x",
  hasEnvironment: true,
};

function plan(bb: BbPluginApi, workspace: WorkspaceMode, machine?: string) {
  return planTransfer(bb, { ...BASE, workspace, machine });
}

describe("planTransfer", () => {
  it("stays on the source machine when none is named", async () => {
    const result = await plan(makeBb(), "reuse");
    expect(result).toMatchObject({
      hostId: MACBOOK.id,
      crossMachine: false,
      sourceHostName: MACBOOK.name,
    });
  });

  it("keeps working when the machine list is unavailable and none was named", async () => {
    const result = await plan(makeBb({ hostsThrow: true }), "worktree");
    expect(result).toMatchObject({ hostId: MACBOOK.id, crossMachine: false, hostName: null });
  });

  it("fails loudly when a machine is named but the list is unavailable", async () => {
    await expect(plan(makeBb({ hostsThrow: true }), "checkout", "mini")).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("detects the machine change and resolves that machine's checkout", async () => {
    const result = await plan(makeBb(), "checkout", "mini");
    expect(result).toMatchObject({
      hostId: MINI.id,
      hostName: "mini",
      crossMachine: true,
      sourceHostName: MACBOOK.name,
      checkoutPath: "/Users/mini/Git/aurora",
    });
  });

  it("matches a machine by id as well as by name", async () => {
    const result = await plan(makeBb(), "checkout", MINI.id);
    expect(result.hostId).toBe(MINI.id);
  });

  it("rejects reuse across machines with a message that names both", async () => {
    await expect(plan(makeBb(), "reuse", "mini")).rejects.toThrow(TransferError);
    await expect(plan(makeBb(), "reuse", "mini")).rejects.toThrow(
      /lives on Vedrans-MacBook-Pro.*run on mini/s,
    );
  });

  it("still rejects reuse when the thread has no environment", async () => {
    await expect(
      planTransfer(makeBb(), { ...BASE, hasEnvironment: false, workspace: "reuse" }),
    ).rejects.toThrow("no environment to reuse");
  });

  it("rejects a checkout on a machine the project is not on", async () => {
    const bb = makeBb({ sources: [{ hostId: MACBOOK.id, path: "/Users/dev/Git/aurora" }] });
    await expect(plan(bb, "checkout", "mini")).rejects.toThrow(/no checkout on mini/);
  });

  it("rejects a cross-machine worktree with nothing to build it from", async () => {
    const bb = makeBb({ sources: [{ hostId: MACBOOK.id, path: "/Users/dev/Git/aurora" }] });
    await expect(plan(bb, "worktree", "mini")).rejects.toThrow(/nothing to build a worktree/);
  });

  it("refuses a disconnected target machine", async () => {
    const bb = makeBb({ hosts: [MACBOOK, { ...MINI, status: "disconnected" }] });
    await expect(plan(bb, "checkout", "mini")).rejects.toThrow(/disconnected/);
  });

  it("bases a cross-machine worktree on the source branch when it exists there", async () => {
    const result = await plan(makeBb({ branches: ["main", "feature-x"] }), "worktree", "mini");
    expect(result.baseBranch).toBe("feature-x");
    expect(result.notes).toEqual([]);
  });

  it("falls back to the default branch and says so when the branch is not there", async () => {
    const result = await plan(makeBb({ branches: ["main"] }), "worktree", "mini");
    expect(result.baseBranch).toBeNull();
    expect(result.notes[0]).toMatch(/does not exist on mini/);
  });

  it("leaves same-machine worktrees on the default branch", async () => {
    const result = await plan(makeBb(), "worktree");
    expect(result.baseBranch).toBeNull();
    expect(result.notes).toEqual([]);
  });

  it("needs nothing from the project for a personal workspace", async () => {
    const bb = makeBb({ sources: [] });
    const result = await plan(bb, "personal", "mini");
    expect(result).toMatchObject({ hostId: MINI.id, crossMachine: true, checkoutPath: null });
  });
});

// --- Working state ----------------------------------------------------------

function makeStatusBb(
  status: unknown,
  diff?: unknown,
): { bb: BbPluginApi; gitCalls: { method: string; input: unknown }[] } {
  const gitCalls: { method: string; input: unknown }[] = [];
  const bb = {
    sdk: {
      plugins: {
        callRpc: async (args: {
          pluginId: string;
          method: string;
          input: unknown;
          outputSchema: { parse(value: unknown): unknown };
        }) => {
          expect(args.pluginId).toBe("bb--git");
          gitCalls.push({ method: args.method, input: args.input });
          return args.outputSchema.parse(args.method === "workspaceStatus" ? status : diff);
        },
      },
    },
  };
  return { bb: bb as unknown as BbPluginApi, gitCalls };
}

function diffResult(diff: string, truncated = false) {
  return {
    outcome: "available",
    diff: { diff, truncated, shortstat: "", files: "", mergeBaseRef: null },
  };
}

const CLEAN_STATUS = {
  outcome: "available",
  workspace: {
    workingTree: { insertions: 0, deletions: 0, files: [], hasUncommittedChanges: false, state: "clean" },
    checkout: { kind: "branch", branchName: "feature-x", headSha: "abc123def456789" },
  },
};

const DIRTY_STATUS = {
  outcome: "available",
  workspace: {
    workingTree: {
      insertions: 12,
      deletions: 3,
      files: [
        { path: "src/a.ts", status: "M", insertions: 10, deletions: 3 },
        { path: "src/b.ts", status: "??", insertions: 2, deletions: 0 },
      ],
      hasUncommittedChanges: true,
      state: "dirty_uncommitted",
    },
    checkout: { kind: "branch", branchName: "feature-x", headSha: "abc123def456789" },
  },
};

describe("captureWorkingState", () => {
  it("reports a clean tree without asking for a patch", async () => {
    const { bb, gitCalls } = makeStatusBb(CLEAN_STATUS);
    const state = await captureWorkingState(bb, "env_1");
    expect(state).toMatchObject({ dirty: false, branch: "feature-x", patch: null });
    expect(gitCalls).toEqual([{ method: "workspaceStatus", input: { environmentId: "env_1" } }]);
  });

  it("ships the uncommitted diff, untracked files included, as one patch", async () => {
    const { bb, gitCalls } = makeStatusBb(
      DIRTY_STATUS,
      diffResult("--- a/src/a.ts\n+++ b/src/a.ts\n--- /dev/null\n+++ b/src/b.ts"),
    );
    const state = await captureWorkingState(bb, "env_1");
    expect(state?.dirty).toBe(true);
    expect(state?.files).toHaveLength(2);
    expect(state?.patch).toContain("src/a.ts");
    expect(state?.patch).toContain("src/b.ts");
    // A patch without a trailing newline does not apply.
    expect(state?.patch?.endsWith("\n")).toBe(true);
    expect(gitCalls[1]).toEqual({
      method: "diff",
      input: { environmentId: "env_1", target: { type: "uncommitted" }, maxDiffBytes: MAX_PATCH_BYTES },
    });
  });

  it("carries the truncation flag through from the Git plugin", async () => {
    const { bb } = makeStatusBb(DIRTY_STATUS, diffResult("diff", true));
    expect((await captureWorkingState(bb, "env_1"))?.patchTruncated).toBe(true);
  });

  it("keeps the dirty file list when no patch can be produced", async () => {
    const { bb } = makeStatusBb(DIRTY_STATUS, {
      outcome: "not_applicable",
      reason: "non_git_environment",
      message: "Not a git repository",
    });
    const state = await captureWorkingState(bb, "env_1");
    expect(state).toMatchObject({ dirty: true, patch: null, note: "Not a git repository" });
    expect(state?.files).toHaveLength(2);
  });

  it("returns null when the environment cannot be inspected", async () => {
    const { bb } = makeStatusBb({
      outcome: "unavailable",
      failure: { code: "path_not_found", workspacePath: "/gone", message: "Workspace is missing" },
    });
    expect(await captureWorkingState(bb, "env_1")).toBeNull();
  });
});
