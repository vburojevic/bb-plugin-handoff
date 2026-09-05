import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { opencodeAdapter } from "../adopt/agents/opencode";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it("lets the server handle other work while sqlite3 is still running", async () => {
  const root = mkdtempSync(join(tmpdir(), "handoff-yield-"));
  roots.push(root);
  const dbDir = join(root, ".local/share/opencode");
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(dbDir, "opencode.db"), "");
  writeFileSync(join(root, "sqlite3"), "#!/bin/sh\n/bin/sleep 0.1\nprintf '[]'\n", { mode: 0o755 });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = root;
    const query = opencodeAdapter.list("/project", root);
    const yielded = await Promise.race([
      Promise.resolve(query).then(() => false),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(true))),
    ]);
    expect(yielded).toBe(true);
    expect(await query).toEqual([]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});
