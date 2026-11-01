import { createHash } from "node:crypto";
import type { CapturedSession } from "./capture";

export interface ArchivePart {
  name: string;
  bytes: Uint8Array;
  sha256: string;
  firstSeq: number;
  lastSeq: number;
  events: number;
}

/** Below BB's per-attachment cap. Each part is independently valid JSONL. */
export const ARCHIVE_PART_BYTES = 8_000_000;

export function buildEventArchive(captured: CapturedSession, maxBytes = ARCHIVE_PART_BYTES): ArchivePart[] {
  const parts: ArchivePart[] = [];
  let lines: string[] = [];
  let size = 0;
  let firstSeq = 0;
  let lastSeq = 0;
  const flush = () => {
    if (!lines.length) return;
    const bytes = new TextEncoder().encode(lines.join(""));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    parts.push({ name: `handoff-${captured.threadId}-${sha256.slice(0, 12)}-events-${String(parts.length + 1).padStart(3, "0")}.jsonl`,
      bytes, sha256, firstSeq, lastSeq, events: lines.length });
    lines = []; size = 0;
  };
  for (const row of captured.rawEvents ?? []) {
    const line = JSON.stringify(row) + "\n";
    const length = Buffer.byteLength(line, "utf8");
    if (length > maxBytes) throw new Error(`Event ${row.seq} exceeds the archive part limit (${maxBytes} bytes); no handoff was started.`);
    if (size + length > maxBytes) flush();
    if (!lines.length) firstSeq = row.seq;
    lines.push(line); size += length; lastSeq = row.seq;
  }
  flush();
  return parts;
}

export function fidelitySummary(captured: CapturedSession): string {
  let clipped = 0;
  let omittedChars = 0;
  for (const entry of captured.entries) {
    for (const match of entry.body.matchAll(/\[truncated (\d+) chars\]/g)) {
      clipped++; omittedChars += Number(match[1]);
    }
  }
  const users = captured.entries.filter(e => e.kind === "user" && !e.nested).length;
  return [
    "## Context fidelity",
    "",
    `- ${users} user messages reconstructed from accepted BB input or provider messages. Rejected/unconfirmed and agent inputs are labelled separately.`,
    `- Rendered transcript contains ${clipped} truncation markers (${omittedChars} characters omitted in those excerpts). The raw event archive preserves the available original event payloads.`,
    "- Attachment references are preserved; original image/file bytes are NOT copied by this transcript. Read the original attachments on the source host if needed; report unavailable ones.",
    "- This is transcript-based continuation, not a native resume or a clone of model memory. Provider-hidden state and data absent from BB events cannot be recovered from this archive.",
    "- A completed first reply confirms delivery only, not comprehension. Verify the user's requirements from the beginning, middle, and end before acting.",
  ].join("\n");
}

export function archiveManifest(parts: ArchivePart[]): string {
  return [
    "## Unabridged BB event archive",
    "",
    "These JSONL files are attached alongside this document. They contain the exact captured BB event objects, including fields abbreviated or not rendered below. Sequence boundaries match this capture.",
    "Read in bounded chunks; do not cat the entire archive into one tool response. Use a script to select event sequences or input records. If any response says it was truncated, read smaller chunks before claiming you reviewed it.",
    "",
    ...parts.map(p => `- ${p.name}: ${p.events} events, seq ${p.firstSeq}–${p.lastSeq}, ${p.bytes.byteLength} bytes, SHA-256 ${p.sha256}`),
    "",
  ].join("\n");
}
