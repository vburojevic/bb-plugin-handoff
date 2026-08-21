// "Adopt agent session" — a section on the new-thread (compose) screen.
//
// Primary flow: paste a session id — or a whole resume command like
// `claude --resume <id>` — and adopt. The backend parses the id and locates
// the session across every agent's store. Secondary flow: browse recent
// sessions per project/directory and tap one to adopt it.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
};

const VISIBLE_SESSIONS = 5;

/**
 * Mirrors the backend's LIVE_SESSION_WINDOW_MS: a session with store activity
 * this recent may still be running in a terminal.
 */
const LIVE_WINDOW_MS = 10 * 60_000;

function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

type SessionRow = {
  agent: string;
  sessionId: string;
  title: string | null;
  modifiedAtMs: number;
  cwd?: string | null;
};

type ProjectRow = { id: string; name: string; path: string | null };

type MachineRow = { id: string; name: string; connected: boolean; isPrimary: boolean };

function SessionRowButton({
  session,
  subtitle,
  busy,
  disabled,
  onAdopt,
}: {
  session: SessionRow;
  subtitle?: string | null;
  /** This row's adoption is in flight. */
  busy: boolean;
  /** Any adoption is in flight — no row should start a second one. */
  disabled: boolean;
  onAdopt: () => void;
}) {
  const possiblyLive = session.modifiedAtMs > 0 && Date.now() - session.modifiedAtMs < LIVE_WINDOW_MS;
  return (
    <button
      type="button"
      onClick={onAdopt}
      disabled={disabled}
      title={new Date(session.modifiedAtMs).toLocaleString()}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md border border-border px-3 py-2 text-left transition-colors",
        "hover:border-ring hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-60",
        "sm:flex-row sm:items-center sm:gap-3",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{session.title ?? session.sessionId}</span>
        {subtitle ? (
          <span className="block truncate font-mono text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {possiblyLive ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            title="Recent activity — this session may still be running in a terminal"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
            live?
          </span>
        ) : null}
        <Badge variant="secondary">{AGENT_LABELS[session.agent] ?? session.agent}</Badge>
        <span className="text-xs tabular-nums text-muted-foreground">
          {busy ? "Adopting…" : formatAge(Date.now() - session.modifiedAtMs)}
        </span>
      </span>
    </button>
  );
}

export function AdoptSection({ projectId: projectIdProp }: { projectId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  // The whole section stays collapsed to a quiet one-liner until opened —
  // starting a fresh thread is the primary action on this screen, not this.
  const [open, setOpen] = useState(false);

  // Primary paste flow
  const queryInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [matches, setMatches] = useState<SessionRow[] | null>(null);
  /** Already-adopted outcome: offer opening the thread or force re-adopting. */
  const [already, setAlready] = useState<{ threadId: string; retry: () => void } | null>(null);

  // Machine: sessions can be adopted from any enrolled machine. "" = this one.
  const [machines, setMachines] = useState<MachineRow[] | null>(null);
  const [machineId, setMachineId] = useState<string>("");
  const remoteMachine =
    machineId !== "" ? (machines?.find((m) => m.id === machineId && !m.isPrimary) ?? null) : null;

  // Secondary browse flow
  const [browseOpen, setBrowseOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectRow[] | null>(null);
  const [pickedProjectId, setPickedProjectId] = useState<string | null>(null);
  const projectId = projectIdProp ?? pickedProjectId;
  const [cwd, setCwd] = useState("");
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [busy, setBusy] = useState<string | null>(null); // "query" | "<agent>:<id>"
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!open || machines !== null) return;
    rpc
      .call("adoptMachines")
      .then((result) => setMachines(result.machines))
      .catch(() => setMachines([]));
  }, [open, machines, rpc]);

  const load = useCallback(
    (cwdOverride: string | null) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setListError(null);
      rpc
        .call("listSessions", {
          projectId,
          cwd: cwdOverride,
          ...(machineId ? { machineId } : {}),
        })
        .then((result) => {
          if (seq !== requestSeq.current) return;
          setSessions(result.sessions);
          setListError(result.error);
          if (result.cwd) setCwd(result.cwd);
        })
        .catch(() => {
          if (seq !== requestSeq.current) return;
          setSessions([]);
          setListError("Could not load sessions.");
        })
        .finally(() => {
          if (seq === requestSeq.current) setLoading(false);
        });
    },
    [projectId, machineId, rpc],
  );

  // (Re)load the browse list when it is open and the project or machine changes.
  useEffect(() => {
    if (!browseOpen) return;
    setCwd("");
    load(null);
  }, [browseOpen, load]);

  useEffect(() => {
    if (!browseOpen || projectIdProp !== null || projects !== null) return;
    rpc
      .call("listProjects")
      .then((result) => setProjects(result.projects))
      .catch(() => setProjects([]));
  }, [browseOpen, projectIdProp, projects, rpc]);

  const handleOutcome = useCallback(
    (
      result: {
        ok: boolean;
        threadId: string | null;
        error: string | null;
        existingThreadId: string | null;
        matches: SessionRow[] | null;
      },
      retryWithForce: () => void,
    ) => {
      if (result.ok && result.threadId) {
        toast.success("Session adopted — the thread is picking up the context.");
        setQuery("");
        navigate.toThread(result.threadId);
        return;
      }
      if (result.existingThreadId) {
        setInlineError(null);
        setAlready({ threadId: result.existingThreadId, retry: retryWithForce });
        return;
      }
      setInlineError(result.error ?? "Adoption failed.");
      setMatches(result.matches?.length ? result.matches : null);
    },
    [navigate],
  );

  const adoptQuery = useCallback(
    (force = false) => {
      const trimmed = query.trim();
      if (!trimmed || busy !== null) return;
      setBusy("query");
      setInlineError(null);
      setMatches(null);
      setAlready(null);
      rpc
        .call("adopt", {
          query: trimmed,
          agent: null,
          sessionId: null,
          cwd: cwd.trim() || null,
          force,
          ...(machineId ? { machineId } : {}),
        })
        .then((result) => handleOutcome(result, () => adoptQuery(true)))
        .catch(() => setInlineError("Adoption failed."))
        .finally(() => setBusy(null));
    },
    [busy, cwd, handleOutcome, machineId, query, rpc],
  );

  const adoptDirect = useCallback(
    (session: SessionRow, directory: string | null, force = false) => {
      if (busy !== null) return;
      if (!directory) {
        setInlineError("This session's directory is unknown — set it in the browse panel below.");
        setBrowseOpen(true);
        return;
      }
      setBusy(`${session.agent}:${session.sessionId}`);
      setInlineError(null);
      setAlready(null);
      rpc
        .call("adopt", {
          query: null,
          agent: session.agent,
          sessionId: session.sessionId,
          cwd: directory,
          force,
          ...(machineId ? { machineId } : {}),
        })
        .then((result) => handleOutcome(result, () => adoptDirect(session, directory, true)))
        .catch(() => setInlineError("Adoption failed."))
        .finally(() => setBusy(null));
    },
    [busy, handleOutcome, machineId, rpc],
  );

  const visible = sessions?.slice(0, VISIBLE_SESSIONS) ?? [];
  const hiddenCount = Math.max(0, (sessions?.length ?? 0) - VISIBLE_SESSIONS);

  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (value) requestAnimationFrame(() => queryInputRef.current?.focus());
      }}
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start gap-2 px-2 py-2 font-normal text-muted-foreground"
        >
          <Icon name="Download" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left">
            Continue a session from another agent — Claude Code, Codex, Gemini CLI, OpenCode…
          </span>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} aria-hidden />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mt-2">
          <CardContent className="flex flex-col gap-3 p-4">
            {/* Machine — only when more than one is enrolled */}
            {machines && machines.length > 1 ? (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="adopt-machine"
                    className="shrink-0 text-xs font-normal text-muted-foreground"
                  >
                    From machine
                  </Label>
                  <Select
                    value={machineId || "__local__"}
                    onValueChange={(value) => {
                      setMachineId(value === "__local__" ? "" : value);
                      setSessions(null);
                      setMatches(null);
                      setInlineError(null);
                      setAlready(null);
                    }}
                  >
                    <SelectTrigger id="adopt-machine" className="h-8 flex-1" aria-label="Machine">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="__local__">
                          {(() => {
                            const primary = machines.find((m) => m.isPrimary);
                            return primary ? `${primary.name} — this machine` : "This machine";
                          })()}
                        </SelectItem>
                        {machines
                          .filter((machine) => !machine.isPrimary)
                          .map((machine) => (
                            <SelectItem
                              key={machine.id}
                              value={machine.id}
                              disabled={!machine.connected}
                            >
                              {machine.name}
                              {machine.connected ? "" : " — disconnected"}
                            </SelectItem>
                          ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                {remoteMachine ? (
                  <p className="text-xs leading-snug text-muted-foreground">
                    Sessions are read from {remoteMachine.name}; the adopted thread runs there, in
                    the session&apos;s own directory. Remote listings show no titles.
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Paste an id or resume command */}
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                ref={queryInputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setInlineError(null);
                  setMatches(null);
                  setAlready(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") adoptQuery();
                }}
                placeholder="Session id or resume command"
                aria-label="Session id or resume command"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                enterKeyHint="go"
                className="flex-1 font-mono text-xs"
              />
              <Button
                variant="secondary"
                onClick={() => adoptQuery()}
                disabled={!query.trim() || busy !== null}
                className="sm:shrink-0"
              >
                {busy === "query" ? "Adopting…" : "Adopt session"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Works with any supported agent — paste the session id or the command you would resume
              it with, e.g. <code className="font-mono">claude --resume &lt;id&gt;</code>,{" "}
              <code className="font-mono">codex resume &lt;id&gt;</code>, or just the id. The new
              thread continues in the session&apos;s own directory with full context.
            </p>

            {inlineError ? (
              <p role="alert" className="text-sm text-destructive">
                {inlineError}
              </p>
            ) : null}
            {already ? (
              <div
                role="alert"
                className="flex flex-col gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 sm:flex-row sm:items-center"
              >
                <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                  This session was already adopted into a thread.
                </p>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => navigate.toThread(already.threadId)}
                  >
                    Open thread
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={already.retry}
                    disabled={busy !== null}
                  >
                    Adopt again
                  </Button>
                </span>
              </div>
            ) : null}
            {matches ? (
              <div className="flex flex-col gap-1.5">
                {matches.map((match) => (
                  <SessionRowButton
                    key={`${match.agent}:${match.sessionId}`}
                    session={match}
                    subtitle={match.cwd ?? "directory unknown"}
                    busy={busy === `${match.agent}:${match.sessionId}`}
                    disabled={busy !== null}
                    onAdopt={() => adoptDirect(match, match.cwd ?? (cwd.trim() || null))}
                  />
                ))}
              </div>
            ) : null}

            {/* Secondary: browse recent sessions */}
            <Collapsible open={browseOpen} onOpenChange={setBrowseOpen}>
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between px-2 text-muted-foreground"
                >
                  Browse recent sessions
                  <Icon name={browseOpen ? "ChevronUp" : "ChevronDown"} aria-hidden />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="flex flex-col gap-2 pt-2">
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {projectIdProp === null ? (
                      <Select
                        value={pickedProjectId ?? ""}
                        onValueChange={(value) => setPickedProjectId(value || null)}
                      >
                        <SelectTrigger className="w-full sm:w-44 sm:shrink-0" aria-label="Project">
                          <SelectValue placeholder="Project…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            {(projects ?? []).map((project) => (
                              <SelectItem key={project.id} value={project.id}>
                                {project.name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    ) : null}
                    <div className="flex flex-1 items-center gap-2">
                      <Input
                        value={cwd}
                        onChange={(event) => setCwd(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !loading) load(cwd.trim() || null);
                        }}
                        placeholder="Directory"
                        aria-label="Session directory"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        enterKeyHint="go"
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => load(cwd.trim() || null)}
                        disabled={loading}
                        aria-label="Refresh sessions"
                        className="shrink-0"
                      >
                        <Icon name="ArrowReloadHorizontal" aria-hidden />
                      </Button>
                    </div>
                  </div>

                  {loading ? (
                    <div className="flex flex-col gap-1.5">
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-full" />
                      <Skeleton className="h-12 w-2/3" />
                    </div>
                  ) : listError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {listError}
                    </p>
                  ) : visible.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No agent sessions found for this directory
                      {remoteMachine ? ` on ${remoteMachine.name}` : ""}.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {visible.map((session) => (
                        <SessionRowButton
                          key={`${session.agent}:${session.sessionId}`}
                          session={session}
                          busy={busy === `${session.agent}:${session.sessionId}`}
                          disabled={busy !== null}
                          onAdopt={() => adoptDirect(session, cwd.trim() || null)}
                        />
                      ))}
                      {hiddenCount > 0 ? (
                        <p className="px-1 text-xs text-muted-foreground">
                          +{hiddenCount} older —{" "}
                          <code className="font-mono">bb handoff adopt list</code> shows them all.
                        </p>
                      ) : null}
                    </div>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}
