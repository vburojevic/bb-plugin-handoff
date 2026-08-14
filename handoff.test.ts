import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@bb/plugin-sdk";
import {
  BRIEFING_POLL_MS,
  HISTORY_LIMIT,
  settleBriefing,
  settleVerification,
  startHandoff,
} from "./handoff";

interface RecordedCall {
  method: string;
  args: unknown;
}

/**
 * Minimal hand-rolled fake of the narrow BbPluginApi surface startHandoff
 * touches (the packed @bb/plugin-sdk testing harness is not distributed with
 * this bb build). Live behavior is covered by the bb plugin dev loop.
 */
function makeFakeBb(
  options: {
    spawnError?: Error;
    threadStatus?: string;
    briefingReply?: string;
    /** Holds the spawn open, so a second handoff can overlap the first. */
    spawnGate?: Promise<void>;
    /** The thread already has a question or approval waiting on the user. */
    pendingInteraction?: boolean;
    /** The briefing turn stops to ask something instead of answering. */
    briefingAsksQuestion?: boolean;
  } = {},
) {
  const calls: RecordedCall[] = [];
  const kv = new Map<string, unknown>();
  const record = (method: string, args: unknown) => calls.push({ method, args });
  let blocked = options.pendingInteraction ?? false;

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
            status: options.threadStatus ?? "idle",
            hasPendingInteraction: blocked,
          };
        },
        send: async (args: unknown) => {
          record("threads.send", args);
          if (options.briefingAsksQuestion) {
            // The agent stops to ask instead of answering: the thread stays
            // active, so no idle ever arrives for this turn.
            blocked = true;
            return;
          }
          // The briefing turn "completes" right after the send resolves.
          queueMicrotask(() =>
            settleBriefing("thr_src", options.briefingReply ?? "Briefing: step one is done."),
          );
        },
        interactions: {
          list: async (args: unknown) => {
            record("threads.interactions.list", args);
            return blocked
              ? [
                  {
                    id: "int_1",
                    threadId: "thr_src",
                    status: "pending",
                    payload: { kind: "user_question" },
                  },
                ]
              : [];
          },
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
          if (options.spawnGate) await options.spawnGate;
          if (options.spawnError) throw options.spawnError;
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

  it("passes the requested thinking effort to the target thread", async () => {
    const { bb, calls, kv } = makeFakeBb();
    await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      reasoningLevel: "xhigh",
    });
    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      reasoningLevel?: string;
    };
    expect(spawn.reasoningLevel).toBe("xhigh");

    const key = [...kv.keys()].find((entry) => entry.startsWith("handoff:"))!;
    expect(kv.get(key)).toMatchObject({ reasoningLevel: "xhigh" });
  });

  it("omits the effort entirely when none is requested, so the model's default stands", async () => {
    const { bb, calls } = makeFakeBb();
    await startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" });
    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as Record<
      string,
      unknown
    >;
    // Present-but-undefined would be sent as an explicit null downstream and
    // could read as "no thinking"; the key must be absent.
    expect(Object.hasOwn(spawn, "reasoningLevel")).toBe(false);
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

  it("tells the next agent how to reach the source thread", async () => {
    const { bb, calls } = makeFakeBb();
    await startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" });
    const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
      clientFile: Uint8Array;
    };
    const doc = new TextDecoder().decode(upload.clientFile);
    expect(doc).toContain('bb thread tell thr_src "<your question>" --mode queue');
    expect(doc).toContain("bb thread output thr_src");
  });

  it("with briefing, asks the idle source agent and embeds its answer", async () => {
    const { bb, calls } = makeFakeBb({ briefingReply: "State: tests green. Next: fix lint." });
    await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      briefing: true,
    });

    const send = calls.find((call) => call.method === "threads.send")!.args as {
      threadId: string;
      input: { text: string }[];
    };
    expect(send.threadId).toBe("thr_src");
    expect(send.input[0]!.text).toContain("handoff briefing");

    const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
      clientFile: Uint8Array;
    };
    const doc = new TextDecoder().decode(upload.clientFile);
    expect(doc).toContain("## Briefing from the outgoing agent");
    expect(doc).toContain("State: tests green. Next: fix lint.");
    // The briefing exchange itself must not leak into the transcript section.
    expect(doc.split("## Transcript")[1]).not.toContain("handoff briefing");

    const stages = calls
      .filter((call) => call.method === "realtime:handoff:progress")
      .map((call) => (call.args as { stage: string }).stage);
    expect(stages).toEqual(["capturing", "briefing", "rendering", "uploading", "spawning", "done"]);

    const spawn = calls.find((call) => call.method === "threads.spawn")!.args as {
      input: { text?: string }[];
    };
    expect(spawn.input[0]!.text).toContain("briefing the outgoing agent wrote");
  });

  it("reports the briefing outcome on the result", async () => {
    const included = makeFakeBb();
    const withBriefing = await startHandoff(included.bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      briefing: true,
    });
    expect(withBriefing.briefing).toBe("included");

    const busy = makeFakeBb({ threadStatus: "active" });
    const skipped = await startHandoff(busy.bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      briefing: true,
    });
    expect(skipped.briefing).toBe("skipped-busy");

    const off = makeFakeBb();
    const without = await startHandoff(off.bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
    });
    expect(without.briefing).toBe("off");
  });

  it("verifies the receiving thread's first turn onto the history record", async () => {
    const { bb, calls, kv } = makeFakeBb();
    await startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" });
    const key = [...kv.keys()].find((k) => k.startsWith("handoff:") && k.endsWith(":thr_new"))!;
    expect((kv.get(key) as { verification?: string }).verification).toBe("pending");

    await settleVerification(bb, "thr_new", true, "Work stands at step two; continuing.");
    expect((kv.get(key) as { verification?: string }).verification).toBe("confirmed");
    const verify = calls.find((call) => call.method === "realtime:handoff:verify")!.args as {
      targetThreadId: string;
      verification: string;
    };
    expect(verify).toMatchObject({ targetThreadId: "thr_new", verification: "confirmed" });

    // Already settled — a later idle for the same thread is a no-op.
    await settleVerification(bb, "thr_new", false);
    expect((kv.get(key) as { verification?: string }).verification).toBe("confirmed");
  });

  it("marks verification failed when the receiving thread fails", async () => {
    const { bb, kv } = makeFakeBb();
    await startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" });
    await settleVerification(bb, "thr_new", false);
    const key = [...kv.keys()].find((k) => k.startsWith("handoff:") && k.endsWith(":thr_new"))!;
    expect((kv.get(key) as { verification?: string }).verification).toBe("failed");
  });

  it("does not ask for a briefing while the agent is already waiting on the user", async () => {
    const { bb, calls } = makeFakeBb({ pendingInteraction: true });
    const result = await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      briefing: true,
    });

    // An idle thread with a question outstanding must not be handed a second
    // question on top of the first.
    expect(result.briefing).toBe("skipped-blocked");
    expect(calls.some((call) => call.method === "threads.send")).toBe(false);
    expect(result.newThreadId).toBe("thr_new");
  });

  it("gives up on the briefing as soon as the agent stops to ask something", async () => {
    vi.useFakeTimers();
    try {
      const { bb, calls } = makeFakeBb({ briefingAsksQuestion: true });
      const running = startHandoff(bb, {
        sourceThreadId: "thr_src",
        providerId: "codex",
        workspace: "reuse",
        briefing: true,
      });
      // Well short of BRIEFING_TIMEOUT_MS: the point is that it does not sit
      // there for the full 90s waiting on a turn that cannot finish.
      for (let tick = 0; tick < 5; tick++) await vi.advanceTimersByTimeAsync(BRIEFING_POLL_MS);
      const result = await running;

      expect(result.briefing).toBe("skipped-blocked");
      expect(calls.some((call) => call.method === "threads.interactions.list")).toBe(true);
      // The question is the user's to answer — the handoff only reports it.
      expect(calls.some((call) => call.method.startsWith("threads.interactions.cancel"))).toBe(false);

      // The handoff still lands, just without a briefing section.
      expect(result.newThreadId).toBe("thr_new");
      const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
        clientFile: Uint8Array;
      };
      const doc = new TextDecoder().decode(upload.clientFile);
      expect(doc).not.toContain("## Briefing from the outgoing agent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the briefing when the source thread is busy", async () => {
    const { bb, calls } = makeFakeBb({ threadStatus: "active" });
    await startHandoff(bb, {
      sourceThreadId: "thr_src",
      providerId: "codex",
      workspace: "reuse",
      briefing: true,
    });

    expect(calls.some((call) => call.method === "threads.send")).toBe(false);
    const upload = calls.find((call) => call.method === "attachments.upload")!.args as {
      clientFile: Uint8Array;
    };
    const doc = new TextDecoder().decode(upload.clientFile);
    expect(doc).not.toContain("## Briefing from the outgoing agent");
  });

  it("refuses a second handoff while one is still running on the same thread", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bb, calls } = makeFakeBb({ spawnGate: gate });
    const request = { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" } as const;

    const first = startHandoff(bb, { ...request });
    await expect(startHandoff(bb, { ...request })).rejects.toThrow(/already running/);

    release();
    await first;
    expect(calls.filter((call) => call.method === "threads.spawn")).toHaveLength(1);

    // The guard is per-run, not a permanent lock: handing the thread off again
    // once the first finished is allowed.
    await startHandoff(bb, { ...request });
    expect(calls.filter((call) => call.method === "threads.spawn")).toHaveLength(2);
  });

  it("publishes a failed stage and rethrows when spawning fails", async () => {
    const { bb, calls } = makeFakeBb({ spawnError: new Error("provider exploded") });
    await expect(
      startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" }),
    ).rejects.toThrow("provider exploded");

    const progress = calls
      .filter((call) => call.method === "realtime:handoff:progress")
      .map((call) => call.args as { stage: string; message?: string });
    expect(progress.map((p) => p.stage)).toEqual([
      "capturing",
      "rendering",
      "uploading",
      "spawning",
      "failed",
    ]);
    expect(progress.at(-1)!.message).toBe("provider exploded");
  });

  it("prunes the oldest history records beyond HISTORY_LIMIT", async () => {
    const { bb, kv } = makeFakeBb();
    const base = 1_700_000_000_000;
    for (let i = 0; i < HISTORY_LIMIT; i += 1) {
      kv.set(`handoff:${base + i}:thr_${i}`, { targetThreadId: `thr_${i}`, at: base + i });
    }
    await startHandoff(bb, { sourceThreadId: "thr_src", providerId: "codex", workspace: "reuse" });

    const keys = [...kv.keys()].filter((key) => key.startsWith("handoff:"));
    expect(keys).toHaveLength(HISTORY_LIMIT);
    expect(keys).not.toContain(`handoff:${base}:thr_0`);
    expect(keys.some((key) => key.endsWith(":thr_new"))).toBe(true);
  });
});
