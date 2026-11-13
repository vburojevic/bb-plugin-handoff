// Rebuild the inputs bb accepted for a thread from its client request events.
// Some providers (Claude Code) never echo a user message item, so the request
// events are the only record of what the user asked for. Providers that do echo
// (Codex) would otherwise show each input twice.
import type { EventRowLike, TranscriptEntry } from "./capture";

/** Same rendering for client input and provider echoes, so the two compare equal. */
export function renderInput(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") out.push(part.text);
    else if (part.type === "image") out.push(`[attached image: ${part.url}]`);
    else if (part.type === "localImage" || part.type === "localFile") out.push(`[attached file: ${part.path}]`);
  }
  return out.join("\n\n");
}

interface Echo {
  start: number;
  end: number;
  body: string;
  accepted: boolean;
  /** The note shown for an unconfirmed request, dropped once an echo confirms delivery. */
  note: TranscriptEntry | null;
  consumed: boolean;
}

export interface ProjectedInputs {
  /**
   * Called for each top-level provider user message. Returns true when the
   * message echoes an accepted request already shown from the request events,
   * so the caller drops it. An echo of an unconfirmed request is kept: it
   * proves the input reached the model.
   */
  isEcho(seq: number, body: string): boolean;
  /** Input entries to show. Call after every provider user message went through isEcho. */
  entries(): TranscriptEntry[];
}

export function projectInputs(rows: EventRowLike[]): ProjectedInputs {
  const accepted = new Set(rows.filter((r) => r.type === "turn/input/accepted")
    .map((r) => r.data?.clientRequestId).filter((id): id is string => typeof id === "string"));
  const rejected = new Set(rows.filter((r) => r.type === "client/turn/rejected")
    .map((r) => r.data?.requestId));
  const requests = rows.filter((r) => r.type === "client/turn/requested");
  const byId = new Map(requests.filter((r) => typeof r.data?.requestId === "string")
    .map((r) => [r.data.requestId as string, r]));

  function rootOf(id: string): string {
    const visited = new Set<string>();
    for (;;) {
      const parent = byId.get(id)?.data?.retryOfRequestId;
      if (typeof parent !== "string" || visited.has(id)) return id;
      visited.add(id);
      id = parent;
    }
  }

  const entries: TranscriptEntry[] = [];
  const echoes: Echo[] = [];
  const seen = new Set<string>();
  const deliveredRoots = new Set<string>();
  for (let i = 0; i < requests.length; i++) {
    const row = requests[i]!;
    const data = row.data ?? {};
    const body = renderInput(data.input);
    if (!body) continue;
    const id = typeof data.requestId === "string" ? data.requestId : null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const end = requests[i + 1]?.seq ?? Infinity;
    if (id !== null && accepted.has(id)) {
      const root = rootOf(id);
      if (deliveredRoots.has(root)) {
        entries.push({ seq: row.seq, kind: "note",
          body: `[Retry of an already accepted input, not a new user instruction]\n${body}` });
      } else if (data.initiator === "user") {
        entries.push({ seq: row.seq, kind: "user", body });
      } else {
        const from = data.senderThreadId ? ` from ${data.senderThreadId}` : "";
        entries.push({ seq: row.seq, kind: "note", body: `[${data.initiator ?? "unknown"} input${from}]\n${body}` });
      }
      deliveredRoots.add(root);
      echoes.push({ start: row.seq, end, body, accepted: true, note: null, consumed: false });
    } else {
      const label = id !== null && rejected.has(id) ? "Rejected" : "Unconfirmed";
      const note: TranscriptEntry = { seq: row.seq, kind: "note",
        body: `[${label} input: not known to have reached the source model]\n${body}` };
      entries.push(note);
      echoes.push({ start: row.seq, end, body, accepted: false, note, consumed: false });
    }
  }

  const confirmed = new Set<TranscriptEntry>();
  return {
    isEcho(seq, body) {
      // One echo per request, inside that request's event interval: a later
      // identical request is a separate instruction.
      const match = echoes.find((e) => !e.consumed && seq >= e.start && seq < e.end && e.body === body);
      if (!match) return false;
      match.consumed = true;
      if (match.note) confirmed.add(match.note);
      return match.accepted;
    },
    entries() {
      return entries.filter((entry) => !confirmed.has(entry));
    },
  };
}
