import type { EventRowLike, TranscriptEntry } from "./capture";

/** Same formatting for client input and provider echoes. Attachment bytes are not text. */
export function renderInput(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    if (part.type === "text" && typeof part.text === "string") return [part.text];
    if (part.type === "image") return [`[attached image reference: ${part.url ?? part.path ?? "unknown"}]`];
    if (part.type === "localImage" || part.type === "localFile") {
      return [`[attached file reference: ${part.path ?? part.name ?? "unknown"}]`];
    }
    return [`[input ${String(part.type)}: ${JSON.stringify(part)}]`];
  }).join("\n\n");
}

export function projectInputs(rows: EventRowLike[]): {
  entries: TranscriptEntry[];
  isEcho: (seq: number, body: string) => boolean;
} {
  const accepted = new Set(rows.filter(r => r.type === "turn/input/accepted")
    .map(r => r.data?.clientRequestId).filter((id): id is string => typeof id === "string"));
  const rejected = new Set(rows.filter(r => r.type === "client/turn/rejected")
    .map(r => r.data?.requestId));
  const requests = rows.filter(r => r.type === "client/turn/requested");
  const byId = new Map(requests.filter(r => typeof r.data?.requestId === "string")
    .map(r => [r.data.requestId as string, r]));
  const deliveredRoots = new Set<string>();
  function rootOf(id: string): string {
    const visited = new Set<string>();
    while (typeof byId.get(id)?.data?.retryOfRequestId === "string") {
      if (visited.has(id)) throw new Error("Cyclic retry ancestry in captured input");
      visited.add(id);
      id = byId.get(id)!.data.retryOfRequestId;
    }
    return id;
  }
  const entries: TranscriptEntry[] = [];
  const echoes: { start: number; end: number; body: string; consumed: boolean }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < requests.length; i++) {
    const row = requests[i]!;
    const data = row.data ?? {};
    const body = renderInput(data.input);
    if (!body) continue;
    if (typeof data.requestId === "string") {
      if (seen.has(data.requestId)) continue;
      seen.add(data.requestId);
    }
    const delivered = accepted.has(data.requestId);
    const human = data.initiator === "user";
    const root = typeof data.requestId === "string" ? rootOf(data.requestId) : null;
    const repeated = root !== null && deliveredRoots.has(root);
    if (delivered) {
      entries.push({ seq: row.seq, kind: human && !repeated ? "user" : "note",
        body: repeated ? `[Retry of an already accepted input — not a new user instruction]\n${body}`
          : human ? body : `[${data.initiator ?? "unknown"} input${data.senderThreadId ? ` from ${data.senderThreadId}` : ""}]\n${body}` });
      if (root !== null) deliveredRoots.add(root);
    } else {
      entries.push({ seq: row.seq, kind: "note",
        body: `[${rejected.has(data.requestId) ? "Rejected" : "Unconfirmed"} input — not known to have reached the source model]\n${body}` });
    }
    // A later identical request is a separate instruction. Suppress only one
    // matching top-level provider echo in this request's event interval.
    echoes.push({ start: row.seq, end: requests[i + 1]?.seq ?? Infinity, body, consumed: false });
  }
  return {
    entries,
    isEcho(seq, body) {
      const match = echoes.find(e => !e.consumed && seq >= e.start && seq < e.end && e.body === body);
      if (!match) return false;
      match.consumed = true;
      return true;
    },
  };
}
