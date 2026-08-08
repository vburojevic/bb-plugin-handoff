import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BlockBuilder,
  MtimeCache,
  formatToolCall,
  parseJsonLine,
  readHead,
  renderTranscript,
  snippet,
  type Block,
} from "../adopt/transcript";

describe("BlockBuilder", () => {
  it("merges consecutive assistant text into one block", () => {
    const builder = new BlockBuilder();
    builder.addText("user", "hi");
    builder.addText("assistant", "part one");
    builder.addText("assistant", "part two");
    expect(builder.blocks).toHaveLength(2);
    expect(builder.blocks[1]).toMatchObject({ role: "assistant", text: "part one\n\npart two" });
  });

  it("attaches tools to the current assistant block, creating one if needed", () => {
    const builder = new BlockBuilder();
    builder.addTool("Read(file)");
    builder.addText("assistant", "done");
    builder.addTool("Edit(file)");
    expect(builder.blocks).toHaveLength(1);
    expect(builder.blocks[0]!.tools).toEqual(["Read(file)", "Edit(file)"]);
  });

  it("ignores whitespace-only text", () => {
    const builder = new BlockBuilder();
    builder.addText("user", "  \n ");
    expect(builder.blocks).toHaveLength(0);
  });
});

describe("renderTranscript", () => {
  const block = (role: Block["role"], text: string): Block => ({ role, text, tools: [] });

  it("renders full transcripts under the budget without truncation", () => {
    const result = renderTranscript([block("user", "ask"), block("assistant", "answer")], 10_000);
    expect(result.truncated).toBe(false);
    expect(result.userMessageCount).toBe(1);
    expect(result.assistantMessageCount).toBe(1);
    expect(result.transcript).toContain("### User");
    expect(result.transcript).toContain("### Assistant");
  });

  it("keeps the opening block and the tail when truncating", () => {
    const blocks = [
      block("user", `OPENING ${"x".repeat(50)}`),
      ...Array.from({ length: 20 }, (_, i) => block("assistant", `middle-${i} ${"y".repeat(200)}`)),
      block("assistant", "THE-TAIL"),
    ];
    const result = renderTranscript(blocks, 1500);
    expect(result.truncated).toBe(true);
    expect(result.transcript).toContain("OPENING");
    expect(result.transcript).toContain("THE-TAIL");
    expect(result.transcript).toMatch(/omitted to fit the context budget/);
    expect(result.transcript.length).toBeLessThan(1500 + 200); // marker overhead only
  });

  it("counts messages from the full set even when truncated", () => {
    const blocks = [
      block("user", "a".repeat(500)),
      block("assistant", "b".repeat(500)),
      block("user", "c".repeat(500)),
      block("assistant", "d".repeat(500)),
    ];
    const result = renderTranscript(blocks, 600);
    expect(result.userMessageCount).toBe(2);
    expect(result.assistantMessageCount).toBe(2);
  });
});

describe("snippet / parseJsonLine / formatToolCall", () => {
  it("collapses whitespace and caps length with an ellipsis", () => {
    expect(snippet("a\n b\t c", 100)).toBe("a b c");
    expect(snippet("abcdef", 4)).toBe("abc…");
  });

  it("parses object lines and rejects everything else", () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine("")).toBeNull();
    expect(parseJsonLine("not json")).toBeNull();
    expect(parseJsonLine('"just a string"')).toBeNull();
    expect(parseJsonLine("42")).toBeNull();
  });

  it("formats tool calls with a briefed input", () => {
    expect(formatToolCall("Read", { file: "a.ts" })).toBe('Read({"file":"a.ts"})');
    expect(formatToolCall("Bash", "ls -la")).toBe("Bash(ls -la)");
  });
});

describe("MtimeCache", () => {
  it("computes once per (path, mtime) and recomputes when mtime changes", () => {
    const cache = new MtimeCache<string>();
    const compute = vi.fn(() => "value");
    expect(cache.get("/a", 1, compute)).toBe("value");
    expect(cache.get("/a", 1, compute)).toBe("value");
    expect(compute).toHaveBeenCalledTimes(1);
    cache.get("/a", 2, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("resets rather than growing past maxEntries", () => {
    const cache = new MtimeCache<number>(2);
    cache.get("/a", 1, () => 1);
    cache.get("/b", 1, () => 2);
    cache.get("/c", 1, () => 3); // triggers reset before insert
    const recompute = vi.fn(() => 9);
    cache.get("/a", 1, recompute);
    expect(recompute).toHaveBeenCalledTimes(1);
  });
});

describe("readHead", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads only the first bytes of a file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-test-"));
    dirs.push(dir);
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, `head${"z".repeat(100)}`);
    expect(readHead(file, 4, fs)).toBe("head");
    expect(readHead(path.join(dir, "missing.txt"), 4, fs)).toBeNull();
  });
});
