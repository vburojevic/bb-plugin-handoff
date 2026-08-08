import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";
import { startHandoff } from "./handoff";

interface RecordedCall {
  method: string;
  args: unknown;
}

/**
 * Minimal hand-rolled fake of the narrow BbPluginApi surface startHandoff
 * touches (the packed @bb/plugin-sdk testing harness is not distributed with
 * this bb build). Live behavior is covered by the bb plugin dev loop.
 */
function makeFakeBb() {
  const calls: RecordedCall[] = [];
  const kv = new Map<string, unknown>();
  const record = (method: string, args: unknown) => calls.push({ method, args });

  const events = [
    { seq: 1, type: "turn/started", data: { providerThreadId: "sess-1" } },
    {
      seq: 2,
      type: "item/completed",
      data: { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "Build the feature" }] } },
    },
    {
      seq: 3,
      type: "item/completed",
      data: { item: { type: "agentMessage", id: "a1", text: "Done with step one." } },
    },
  ];

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
      threads: {
        get: async (args: unknown) => {
          record("threads.get", args);
          return {
            id: "thr_src",
            title: "Build feature X",
            providerId: "claude-code",
            projectId: "proj_1",
            environmentId: "env_1",
          };
        },
        events: {
          list: async (args: unknown) => {
            record("threads.events.list", args);
            return events;
          },
        },
        output: async (args: unknown) => {
          record("threads.output", args);
          return { output: "Step one done." };
        },
        spawn: async (args: unknown) => {
          record("threads.spawn", args);
          return { id: "thr_new" };
        },
      },
      environments: {
        get: async (args: unknown) => {
          record("environments.get", args);
          return { hostId: "host_1", path: "/Users/dev/work/repo", branchName: "feature-x" };
        },
      },
      files: {
        list: async (args: unknown) => {
          record("files.list", args);
          return { files: [{ path: "sess-1.jsonl" }] };
        },
      },
      projects: {
        attachments: {
          upload: async (args: unknown) => {
            record("attachments.upload", args);
            return {
              type: "localFile",
              path: "attachments/handoff.md",
              name: "handoff.md",
              sizeBytes: 1234,
              mimeType: "text/markdown",
            };
          },
        },
      },
    },
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  return { bb: bb as unknown as BbPluginApi, calls, kv };
}

describe("startHandoff", () => {
  it("captures, uploads, and spawns on the target provider reusing the environment", async () => {
    const { bb, calls, kv } = makeFakeBb();
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      model: "gpt-5.6-sol",
      workspace: "reuse",
      extraInstructions: "Prefer small commits.",
    });

    expect(result.newThreadId).toBe("thr_new");
    expect(result.docBytes).toBeGreaterThan(100);

    const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
      projectId: string;
      mimeType: string;
      filename: string;
    };
    expect(upload.projectId).toBe("proj_1");
    expect(upload.mimeType).toBe("text/markdown");
    expect(upload.filename).toMatch(/^handoff-thr_src-\d+\.md$/);

    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      projectId: string;
      providerId: string;
      model: string;
      environment: { type: string; environmentId: string };
      title: string;
      input: { type: string; text?: string; path?: string }[];
    };
    expect(spawn.providerId).toBe("codex");
    expect(spawn.model).toBe("gpt-5.6-sol");
    expect(spawn.environment).toEqual({ type: "reuse", environmentId: "env_1" });
    expect(spawn.title).toBe("Handoff: Build feature X");
    expect(spawn.input[0]!.type).toBe("text");
    expect(spawn.input[0]!.text).toContain("handed off from claude-code");
    expect(spawn.input[0]!.text).toContain("Prefer small commits.");
    expect(spawn.input[1]).toMatchObject({ type: "localFile", path: "attachments/handoff.md" });

    const historyKeys = [...kv.keys()].filter((key) => key.startsWith("handoff:"));
    expect(historyKeys).toHaveLength(1);

    const stages = calls
      .filter((call) => call.method === "realtime:handoff:progress")
      .map((call) => (call.args as { stage: string }).stage);
    expect(stages).toEqual(["capturing", "rendering", "uploading", "spawning", "done"]);
  });

  it("uses a managed worktree on the source host when asked", async () => {
    const { bb, calls } = makeFakeBb();
    await startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "worktree" });
    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      environment: { type: string; hostId: string; workspace: { type: string } };
      model?: string;
    };
    expect(spawn.environment.type).toBe("host");
    expect(spawn.environment.hostId).toBe("host_1");
    expect(spawn.environment.workspace.type).toBe("managed-worktree");
    expect(spawn.model).toBeUndefined();
  });

  it("with untilSeq, captures only up to the selected message", async () => {
    const { bb, calls } = makeFakeBb();
    await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      untilSeq: 2,
    });

    const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
      clientFile: Uint8Array;
    };
    const doc = new TextDecoder().decode(upload.clientFile);
    expect(doc).toContain("Build the feature");
    expect(doc).toContain("partial capture");
    expect(doc).not.toContain("Done with step one.");
    expect(doc).not.toContain("Step one done.");

    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as { title: string };
    expect(spawn.title).toBe("Handoff from message: Build feature X");
  });
});
