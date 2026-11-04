import type { BbPluginApi } from "@bb/plugin-sdk";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findRemoteSession, readRemoteSession } from "../adopt/remote";
import { listRemoteSessionsForDirectory, performAdoptRemote } from "../adopt/adopt-core";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function remote(home: string, entries: string[] = [], probe: string | null = home) {
  let output = "";
  const create = vi.fn(async ({ start }: { start: { command: string } }) => {
    // Execute the discovery script, but keep hostExec's temporary output in memory.
    const script = start.command.slice(2, start.command.indexOf(" ; } >"));
    output = script.includes('"$HOME"') ? (probe ?? "") : execFileSync("sh", ["-c", script], { encoding: "utf8" });
    return { id: "terminal" };
  });
  const bb = { sdk: {
    hosts: { list: async () => [{ id: "remote", name: "laptop", status: "connected" }] },
    system: { config: async () => ({ primaryHostId: "server" }) },
    projects: { list: async () => [] },
    terminals: { create, get: async () => ({ status: "exited" }), close: async () => {} },
    files: {
      list: async ({ limit }: { limit: number }) => entries.slice(0, limit),
      read: async ({ path }: { path: string }) => ({ content: path.startsWith("/tmp/bb-handoff-remote-") ? output : readFileSync(path, "utf8"), contentEncoding: "utf8" }),
      remove: async () => {},
    },
  } } as unknown as BbPluginApi;
  return { bb, create, ctx: { bb, hostId: "remote", hostName: "laptop", home } };
}

const ID = "7862d82b-39fa-4c03-935a-fab4a4649621";
function transcript(sidechain: boolean) {
  return ["user", "assistant"].map((type) => JSON.stringify({ type, sessionId: ID, cwd: "/work", isSidechain: sidechain, message: { role: type, content: "hello" } })).join("\n");
}

describe("remote Claude lookup", () => {
  it("selects the main transcript even when more than five subagents match first", async () => {
    const home = mkdtempSync(join(tmpdir(), "handoff remote's-"));
    roots.push(home);
    const project = join(home, ".claude/projects/-work");
    mkdirSync(join(project, ID, "subagents"), { recursive: true });
    const entries = Array.from({ length: 8 }, (_, i) => `-work/${ID}/subagents/agent-${i}.jsonl`);
    for (const entry of entries) writeFileSync(join(home, ".claude/projects", entry), transcript(true));
    writeFileSync(join(project, `${ID}.jsonl`), transcript(false));
    entries.push(`-work/${ID}.jsonl`);
    const { ctx } = remote(home, entries);
    const found = await findRemoteSession(ctx, ID, "claude");
    expect(found[0]?.filePath).toBe(join(project, `${ID}.jsonl`));
    expect(await readRemoteSession(ctx, found[0]!)).toMatchObject({ userMessageCount: 1, assistantMessageCount: 1 });
    expect((await findRemoteSession(ctx, ID.slice(0, 8), "claude"))[0]?.filePath).toBe(join(project, `${ID}.jsonl`));
  });

  it("does not adopt an orphan subagent as its parent", async () => {
    const home = mkdtempSync(join(tmpdir(), "handoff-orphan-"));
    roots.push(home);
    const nested = `-work/${ID}/subagents/agent-one.jsonl`;
    mkdirSync(join(home, ".claude/projects", `-work/${ID}/subagents`), { recursive: true });
    writeFileSync(join(home, ".claude/projects", nested), transcript(true));
    expect(await findRemoteSession(remote(home, [nested]).ctx, ID, "claude")).toEqual([]);
  });
});

describe("remote home discovery", () => {
  it("lists sessions without a project source or explicit home", async () => {
    const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
    roots.push(home);
    const { bb } = remote(home);
    expect(await listRemoteSessionsForDirectory(bb, { machine: "remote", cwd: "/work" })).toMatchObject({ sessions: [], machine: "laptop" });
  });

  it("uses the same home discovery for adoption by id", async () => {
    const home = mkdtempSync(join(tmpdir(), "handoff-home-"));
    roots.push(home);
    const { bb } = remote(home);
    const result = await performAdoptRemote(bb, { machine: "remote", sessionId: ID, agent: "claude", dryRun: true });
    expect(result).toMatchObject({ ok: false, code: "not-found" });
  });

  it("honors an explicit home without probing HOME", async () => {
    const { bb, create } = remote("/nonexistent", [], "/different");
    await listRemoteSessionsForDirectory(bb, { machine: "remote", cwd: "/work", home: "/nonexistent" });
    expect(create.mock.calls.every(([args]) => !args.start.command.includes('"$HOME"'))).toBe(true);
  });

  it.each([false, true])("falls back to project sources when the HOME probe fails (terminal failure: %s)", async (terminalFailure) => {
    const { bb, create } = remote("/unused", [], "relative/path");
    if (terminalFailure) create.mockRejectedValueOnce(new Error("terminal unavailable"));
    vi.spyOn(bb.sdk.projects, "list").mockResolvedValue([
      { sources: [{ hostId: "remote", path: "/home/fallback/work" }] },
    ] as Awaited<ReturnType<typeof bb.sdk.projects.list>>);
    expect(await listRemoteSessionsForDirectory(bb, { machine: "remote", cwd: "/work" })).toMatchObject({ sessions: [], machine: "laptop" });
    expect(create.mock.calls.at(-1)?.[0].start.command).toContain("/home/fallback/.claude/projects");
  });

  it.each(["", "relative/path", "/home/user\nnoise"])("reports no-home for invalid probe output %j", async (probe) => {
    const { bb } = remote("/unused", [], probe);
    expect(await performAdoptRemote(bb, { machine: "remote", sessionId: ID, dryRun: true })).toMatchObject({ ok: false, code: "no-home" });
  });
});
