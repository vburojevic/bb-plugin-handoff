// bb-plugin-handoff — frontend: two surfaces, one per direction.
//
// Out: the "Hand off" thread panel — an operate-mode surface inside bb's
// shell that reads as one quiet form (route header source → target, target
// picker, workspace, notes) with a sticky action footer that turns into a
// live progress rail during a handoff.
// In: the "Adopt agent session" compose-screen section (adopt/section.tsx).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { AdoptSection } from "./adopt/section";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { omitUndefined } from "@/lib/rpc-input";
import { cn } from "@/lib/utils";

type WorkspaceMode = "reuse" | "checkout" | "worktree" | "personal";

interface Machine {
  id: string;
  name: string;
  connected: boolean;
  isSource: boolean;
  hasCheckout: boolean;
}

interface PrepStats {
  title: string;
  providerId: string;
  turns: number;
  entries: number;
  docBytes: number;
  nativeSessionPath: string | null;
  workspacePath: string | null;
  branchName: string | null;
  hasEnvironment: boolean;
  sourceState: "idle" | "busy" | "blocked";
}

interface TargetProvider {
  id: string;
  displayName: string;
  available: boolean;
  logoUrl: string | null;
}

interface HandoffRow {
  sourceThreadId: string;
  sourceProvider: string;
  targetThreadId: string;
  targetProvider: string;
  model: string | null;
  reasoningLevel?: ReasoningLevel | null;
  workspace: WorkspaceMode;
  at: number;
  verification?: "pending" | "confirmed" | "failed";
  targetMachine?: string | null;
}

const BRIEFING_TOAST: Record<string, string> = {
  included: " — briefing included",
  "skipped-busy": " — briefing skipped, the source agent was busy",
  "skipped-blocked": " — briefing skipped, the source agent is waiting on you",
  "skipped-unanswered": " — briefing skipped, no answer in time",
};

const STAGES = [
  { key: "capturing", label: "Capture" },
  { key: "briefing", label: "Briefing" },
  { key: "working-state", label: "Working state" },
  { key: "rendering", label: "Render" },
  { key: "uploading", label: "Upload" },
  { key: "spawning", label: "Start thread" },
] as const;

const WORKSPACE_OPTIONS: {
  value: WorkspaceMode;
  icon: "FolderOpen" | "Fork" | "Laptop" | "FolderGit";
  label: string;
  description: string;
  /** Wording when the handoff lands on a different machine. */
  crossMachine?: { label: string; description: string };
}[] = [
  {
    value: "reuse",
    icon: "FolderOpen",
    label: "Same workspace",
    description: "The next agent sees the exact working state, including uncommitted changes.",
  },
  {
    value: "checkout",
    icon: "FolderGit",
    label: "Project checkout",
    description: "This project's own checkout, not the thread's workspace.",
    crossMachine: {
      label: "Project checkout there",
      description: "This project's checkout on that machine. Uncommitted work travels as a patch.",
    },
  },
  {
    value: "worktree",
    icon: "Fork",
    label: "New worktree",
    description: "An isolated copy of the repo — the original workspace stays untouched.",
    crossMachine: {
      label: "New worktree there",
      description:
        "A fresh worktree on that machine, based on this thread's branch when it exists there.",
    },
  },
  {
    value: "personal",
    icon: "Laptop",
    label: "Personal",
    description: "No repo checkout; a blank personal workspace on the same machine.",
    crossMachine: {
      label: "Personal",
      description: "No repo checkout; a blank personal workspace on that machine.",
    },
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Roving radio-group keyboard support: arrow keys move the selection among
 * the enabled values (Home/End jump to the ends) and keep focus on the newly
 * selected radio.
 */
function radioKeyNav(
  event: React.KeyboardEvent<HTMLElement>,
  values: string[],
  current: string | null,
  select: (value: string) => void,
) {
  if (values.length === 0) return;
  const index = current ? values.indexOf(current) : -1;
  let nextIndex: number;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1 + values.length) % values.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + values.length) % values.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = values.length - 1;
  } else {
    return;
  }
  event.preventDefault();
  const container = event.currentTarget;
  select(values[nextIndex]!);
  requestAnimationFrame(() => {
    container.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus();
  });
}

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function ProviderMark({ provider, className }: { provider: TargetProvider; className?: string }) {
  if (provider.logoUrl) {
    return (
      <img
        src={provider.logoUrl}
        alt=""
        className={cn("shrink-0 rounded-md border border-border bg-background object-contain p-1", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-border bg-muted text-[10px] font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      {provider.displayName.slice(0, 2)}
    </span>
  );
}

function RouteChip({
  children,
  placeholder = false,
  animateIn = false,
}: {
  children: React.ReactNode;
  placeholder?: boolean;
  animateIn?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs font-medium",
        placeholder
          ? "border-dashed border-border text-muted-foreground"
          : "border-border bg-muted/60 text-foreground",
        animateIn && "animate-in fade-in-0 slide-in-from-left-2 duration-300",
      )}
    >
      {children}
    </span>
  );
}

type ReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "ultracode"
  | "max"
  | "ultra";

type ModelOption = {
  model: string;
  displayName: string;
  isDefault: boolean;
  defaultReasoningEffort: ReasoningLevel;
  supportedReasoningEfforts: { reasoningEffort: ReasoningLevel; description: string }[];
};

const EFFORT_LABELS: Record<ReasoningLevel, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  ultracode: "Ultracode",
  max: "Max",
  ultra: "Ultra",
};

interface HandoffScope {
  upToSeq: number;
  messagePreview: string;
  messageRole: "user" | "assistant";
}

/** Parse the params a messageAction's openPanel call handed this tab. */
function parseScope(params: unknown): HandoffScope | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  const upToSeq = record.upToSeq;
  if (typeof upToSeq !== "number" || !Number.isInteger(upToSeq) || upToSeq <= 0) return null;
  return {
    upToSeq,
    messagePreview: typeof record.messagePreview === "string" ? record.messagePreview : "",
    messageRole: record.messageRole === "user" ? "user" : "assistant",
  };
}

function HandoffPanel({ threadId, params }: { threadId: string; params?: unknown }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const initialScope = useMemo(() => parseScope(params), [params]);
  const [scopeCleared, setScopeCleared] = useState(false);
  const scope = scopeCleared ? null : initialScope;
  const upToSeq = scope?.upToSeq;

  const [stats, setStats] = useState<PrepStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [providers, setProviders] = useState<TargetProvider[] | null>(null);
  const [providerId, setProviderId] = useState<string>("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [model, setModel] = useState<string>("__default__");
  /** "" while no model is resolved yet; otherwise a level that model accepts. */
  const [effort, setEffort] = useState<ReasoningLevel | "">("");
  const [workspace, setWorkspace] = useState<WorkspaceMode>("reuse");
  const [machines, setMachines] = useState<Machine[]>([]);
  const [sourceMachineId, setSourceMachineId] = useState<string | null>(null);
  /** "" means "stay on the source machine". */
  const [machineId, setMachineId] = useState<string>("");
  const [briefing, setBriefing] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [history, setHistory] = useState<HandoffRow[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<{ doc: string; docBytes: number; truncated: boolean } | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useRealtime("handoff:verify", (payload) => {
    const data = payload as { targetThreadId?: string; verification?: string };
    if (!data.targetThreadId || (data.verification !== "confirmed" && data.verification !== "failed")) {
      return;
    }
    setHistory((rows) =>
      rows.map((row) =>
        row.targetThreadId === data.targetThreadId
          ? { ...row, verification: data.verification as "confirmed" | "failed" }
          : row,
      ),
    );
  });

  useRealtime("handoff:progress", (payload) => {
    const data = payload as { sourceThreadId?: string; stage?: string };
    if (data.sourceThreadId !== threadId || !data.stage) return;
    // "failed" and unknown stages are ignored: the rpc rejection resets the UI.
    if (data.stage === "done" || STAGES.some((step) => step.key === data.stage)) {
      setStage(data.stage);
    }
  });

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setStatsError(null);
    rpc
      .call("prepareHandoff", omitUndefined({ threadId, upToSeq }))
      .then((result) => {
        if (cancelled) return;
        setStats(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatsError(error instanceof Error ? error.message : String(error));
      });
    rpc
      .call("history", null)
      .then((result) => !cancelled && setHistory(result.handoffs))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, retryNonce, upToSeq]);

  // Providers are per machine: re-ask whenever the target machine changes, and
  // drop a selection the new machine cannot run.
  useEffect(() => {
    let cancelled = false;
    setProviders(null);
    rpc
      .call("listTargets", { threadId, ...(machineId ? { machineId } : {}) })
      .then((result) => {
        if (cancelled) return;
        setProviders(result.providers);
        setMachines(result.machines);
        setSourceMachineId(result.sourceMachineId);
        setProviderId((current) =>
          current && !result.providers.some((p) => p.id === current && p.available) ? "" : current,
        );
      })
      .catch(() => !cancelled && setProviders([]));
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, retryNonce, machineId]);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setModels([]);
    setModel("__default__");
    setModelsLoading(true);
    rpc
      .call("listModels", { threadId, providerId, ...(machineId ? { machineId } : {}) })
      .then((result) => !cancelled && setModels(result.models))
      .catch(() => !cancelled && setModels([]))
      .finally(() => !cancelled && setModelsLoading(false));
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, providerId, machineId]);

  const selectedProvider = useMemo(
    () => providers?.find((provider) => provider.id === providerId) ?? null,
    [providers, providerId],
  );
  // "Provider default" is not a model, so resolve it to the one the provider
  // marks default — that is whose effort levels the picker must offer.
  const activeModel = useMemo(
    () =>
      (model === "__default__"
        ? models.find((entry) => entry.isDefault)
        : models.find((entry) => entry.model === model)) ?? null,
    [models, model],
  );
  const efforts = activeModel?.supportedReasoningEfforts ?? [];
  // Supported levels are per model, so changing the model re-seeds from that
  // model's own default instead of carrying a level it may not accept.
  useEffect(() => {
    setEffort(activeModel?.defaultReasoningEffort ?? "");
  }, [activeModel]);
  // Available targets first; unavailable ones sink to the end but stay visible.
  const sortedProviders = useMemo(
    () =>
      providers === null
        ? null
        : [...providers].sort((a, b) => Number(b.available) - Number(a.available)),
    [providers],
  );
  const selectableProviderIds = useMemo(
    () => (sortedProviders ?? []).filter((provider) => provider.available).map((provider) => provider.id),
    [sortedProviders],
  );
  // Handoffs involving this thread when any exist, recent global ones otherwise.
  const historyView = useMemo(() => {
    const scoped = history.filter(
      (row) => row.sourceThreadId === threadId || row.targetThreadId === threadId,
    );
    return {
      rows: (scoped.length > 0 ? scoped : history).slice(0, 8),
      scopedToThread: scoped.length > 0,
    };
  }, [history, threadId]);
  const providerName = useCallback(
    (id: string) => providers?.find((provider) => provider.id === id)?.displayName ?? id,
    [providers],
  );
  const sourceProvider = useMemo(
    () => providers?.find((provider) => provider.id === stats?.providerId) ?? null,
    [providers, stats],
  );

  const targetMachine = useMemo(
    () => (machineId ? (machines.find((machine) => machine.id === machineId) ?? null) : null),
    [machines, machineId],
  );
  const sourceMachine = useMemo(
    () => machines.find((machine) => machine.id === sourceMachineId) ?? null,
    [machines, sourceMachineId],
  );
  const crossMachine = targetMachine != null && targetMachine.id !== sourceMachineId;

  /** Why a workspace mode cannot be used right now, or null when it can. */
  const workspaceBlocker = useCallback(
    (mode: WorkspaceMode): string | null => {
      const machine = targetMachine ?? sourceMachine;
      if (mode === "reuse") {
        if (crossMachine) {
          return `The thread's workspace is on ${sourceMachine?.name ?? "the source machine"}, not ${targetMachine?.name}.`;
        }
        return stats && !stats.hasEnvironment ? "This thread has no workspace to share." : null;
      }
      if (mode === "checkout" && machine && !machine.hasCheckout) {
        return `This project has no checkout on ${machine.name}.`;
      }
      if (mode === "worktree" && crossMachine && targetMachine && !targetMachine.hasCheckout) {
        return `No checkout on ${targetMachine.name} to build a worktree from.`;
      }
      return null;
    },
    [crossMachine, sourceMachine, targetMachine, stats],
  );

  // Keep the selection valid as the machine (or the thread's environment) changes.
  useEffect(() => {
    if (!workspaceBlocker(workspace)) return;
    const fallback = WORKSPACE_OPTIONS.find((option) => !workspaceBlocker(option.value));
    if (fallback) setWorkspace(fallback.value);
  }, [workspace, workspaceBlocker]);

  // A scope change (cleared banner) invalidates any cached preview.
  useEffect(() => {
    setPreview(null);
    setPreviewError(false);
  }, [upToSeq]);

  const openPreview = useCallback(() => {
    setPreviewOpen(true);
    if (preview || previewError) return;
    rpc
      .call("previewHandoff", omitUndefined({ threadId, upToSeq }))
      .then(setPreview)
      .catch(() => setPreviewError(true));
  }, [rpc, threadId, upToSeq, preview, previewError]);

  // `pending` swaps the button for the progress rail, but only on the next
  // render — a second activation in the same tick still gets through. The
  // server refuses a concurrent handoff of the same thread; this just keeps
  // the common case from ever asking.
  const starting = useRef(false);

  const start = useCallback(async () => {
    if (!providerId || starting.current) return;
    starting.current = true;
    setPending(true);
    setStage("capturing");
    try {
      const result = await rpc.call("startHandoff", {
        threadId,
        providerId,
        ...(model !== "__default__" ? { model } : {}),
        ...(effort ? { reasoningLevel: effort } : {}),
        workspace,
        ...(machineId ? { machineId } : {}),
        briefing,
        ...(instructions.trim() ? { extraInstructions: instructions.trim() } : {}),
        ...(upToSeq ? { upToSeq } : {}),
      });
      const where = result.crossMachine ? ` on ${result.targetMachine}` : "";
      toast.success(
        `Handed off to ${selectedProvider?.displayName ?? providerId}${where}${BRIEFING_TOAST[result.briefing] ?? ""}`,
      );
      if (result.patchPath) {
        toast.info(`Uncommitted work carried over as ${result.patchPath}`);
      }
      for (const note of result.notes) toast.warning(note);
      navigate.toThread(result.newThreadId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Handoff failed");
      starting.current = false;
      setPending(false);
      setStage(null);
    }
  }, [
    rpc,
    threadId,
    providerId,
    model,
    effort,
    workspace,
    machineId,
    briefing,
    instructions,
    upToSeq,
    navigate,
    selectedProvider,
  ]);

  const railStages = STAGES.filter(
    (step) =>
      (step.key !== "briefing" || briefing) && (step.key !== "working-state" || crossMachine),
  );
  const stageIndex = railStages.findIndex((step) => step.key === stage);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-6 p-4">
            {/* Partial-scope banner (opened from a message action) */}
            {scope ? (
              <div className="flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/5 p-2.5">
                <Icon name="Fork" className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium leading-tight">
                    Handing off up to a selected message
                  </span>
                  {scope.messagePreview ? (
                    <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">
                      {scope.messageRole === "user" ? "You" : "Assistant"}: {scope.messagePreview}
                    </span>
                  ) : null}
                  <span className="text-xs leading-snug text-muted-foreground">
                    Everything after that message stays out of the handoff.
                  </span>
                </span>
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    onClick={() => setScopeCleared(true)}
                    aria-label="Use the full thread instead"
                    className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <Icon name="X" className="size-3.5" aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent>Use the full thread instead</TooltipContent>
                </Tooltip>
              </div>
            ) : null}

            {/* Route header */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2" aria-label="Handoff route">
                <RouteChip>
                  {sourceProvider ? (
                    <ProviderMark
                      provider={sourceProvider}
                      className="size-3.5 rounded-sm border-0 bg-transparent p-0"
                    />
                  ) : (
                    <Icon name="MessageSquare" className="size-3 text-muted-foreground" aria-hidden />
                  )}
                  {sourceProvider?.displayName ?? stats?.providerId ?? "…"}
                </RouteChip>
                <Icon name="ArrowRight" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                {selectedProvider ? (
                  <RouteChip key={selectedProvider.id} animateIn>
                    <ProviderMark provider={selectedProvider} className="size-3.5 rounded-sm border-0 bg-transparent p-0" />
                    {selectedProvider.displayName}
                  </RouteChip>
                ) : (
                  <RouteChip placeholder>choose a target</RouteChip>
                )}
              </div>
              {statsError ? (
                <Alert variant="destructive">
                  <AlertTitle>Couldn&apos;t read this session</AlertTitle>
                  <AlertDescription className="flex flex-col items-start gap-2">
                    {statsError}
                    <Button size="sm" variant="outline" onClick={() => setRetryNonce((n) => n + 1)}>
                      <Icon name="RotateCcw" aria-hidden />
                      Retry
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : stats ? (
                <div className="flex flex-col gap-1">
                  <p className="truncate text-sm font-medium">{stats.title}</p>
                  <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground tabular-nums">
                    <span>{stats.turns} {stats.turns === 1 ? "turn" : "turns"}</span>
                    <span aria-hidden>·</span>
                    <span>{stats.entries} entries</span>
                    <span aria-hidden>·</span>
                    <span>{formatBytes(stats.docBytes)}</span>
                    {stats.branchName ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="inline-flex items-center gap-1">
                          <Icon name="GitBranch" className="size-3" aria-hidden />
                          {stats.branchName}
                        </span>
                      </>
                    ) : null}
                    {stats.nativeSessionPath ? (
                      <>
                        <span aria-hidden>·</span>
                        <Tooltip>
                          <TooltipTrigger className="inline-flex cursor-default items-center gap-1 text-foreground/80">
                            <Icon name="FileText" className="size-3" aria-hidden />
                            raw session linked
                          </TooltipTrigger>
                          <TooltipContent className="max-w-72">
                            The source provider&apos;s own session file was located and referenced in
                            the handoff document, so the next agent can consult the raw transcript.
                          </TooltipContent>
                        </Tooltip>
                      </>
                    ) : null}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Skeleton className="h-5 w-2/3" />
                  <Skeleton className="h-4 w-1/2" />
                </div>
              )}
            </div>

            {/* Machine — only meaningful once more than one is enrolled */}
            {machines.length > 1 ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="handoff-machine">Machine</Label>
                <Select
                  value={machineId || "__source__"}
                  onValueChange={(value) => setMachineId(value === "__source__" ? "" : value)}
                >
                  <SelectTrigger id="handoff-machine">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="__source__">
                        {sourceMachine ? `${sourceMachine.name} — this thread's machine` : "This thread's machine"}
                      </SelectItem>
                      {machines
                        .filter((machine) => machine.id !== sourceMachineId)
                        .map((machine) => (
                          <SelectItem key={machine.id} value={machine.id} disabled={!machine.connected}>
                            {machine.name}
                            {machine.connected ? "" : " — disconnected"}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {crossMachine ? (
                  <p className="text-xs leading-snug text-muted-foreground">
                    The new thread runs on {targetMachine?.name}, working from that machine&apos;s
                    files. Anything uncommitted here travels with it as a patch the next agent can
                    apply.
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Target picker */}
            <div className="flex flex-col gap-2">
              <Label>Continue with</Label>
              {providers === null ? (
                <div className="grid grid-cols-2 gap-2">
                  <Skeleton className="h-[52px]" />
                  <Skeleton className="h-[52px]" />
                  <Skeleton className="h-[52px]" />
                  <Skeleton className="h-[52px]" />
                </div>
              ) : providers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No agents found on {targetMachine?.name ?? "this machine"}. Install a provider CLI
                  (codex, claude, opencode…) there and reload.
                </p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label="Target agent"
                  className="grid grid-cols-2 gap-2"
                  onKeyDown={(event) =>
                    radioKeyNav(event, selectableProviderIds, providerId || null, setProviderId)
                  }
                >
                  {(sortedProviders ?? []).map((provider) => {
                    const selected = provider.id === providerId;
                    const isCurrent = provider.id === stats?.providerId;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        tabIndex={
                          selected || (!providerId && provider.id === selectableProviderIds[0])
                            ? 0
                            : -1
                        }
                        disabled={!provider.available}
                        onClick={() => setProviderId(provider.id)}
                        className={cn(
                          "group flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                          "active:scale-[0.99]",
                          selected
                            ? "border-primary/50 bg-primary/5"
                            : "border-border hover:bg-accent/50",
                          !provider.available && "cursor-not-allowed opacity-50",
                        )}
                      >
                        <ProviderMark provider={provider} className="size-7" />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium leading-tight">
                            {provider.displayName}
                          </span>
                          {!provider.available || isCurrent ? (
                            <span className="text-[11px] leading-tight text-muted-foreground">
                              {!provider.available ? "Unavailable" : "Current agent"}
                            </span>
                          ) : null}
                        </span>
                        {selected ? (
                          <Icon
                            name="CircleCheck"
                            className="size-4 shrink-0 text-primary animate-in zoom-in-50 duration-200"
                            aria-hidden
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Model */}
            {providerId && modelsLoading ? (
              <div className="flex flex-col gap-2">
                <Label>Model</Label>
                <Skeleton className="h-9 w-full" />
              </div>
            ) : models.length > 0 ? (
              <div className="flex flex-col gap-2 animate-in fade-in-0 duration-200">
                <Label htmlFor="handoff-model">Model</Label>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id="handoff-model">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="__default__">Provider default</SelectItem>
                      {models.map((entry) => (
                        <SelectItem key={entry.model} value={entry.model}>
                          {entry.displayName}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {/* Thinking effort — only when the model offers a real choice. */}
            {efforts.length > 1 ? (
              <div className="flex flex-col gap-2 animate-in fade-in-0 duration-200">
                <Label htmlFor="handoff-effort">Thinking effort</Label>
                <Select
                  value={effort}
                  onValueChange={(value) => setEffort(value as ReasoningLevel)}
                >
                  <SelectTrigger id="handoff-effort">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {efforts.map((entry) => (
                        <SelectItem key={entry.reasoningEffort} value={entry.reasoningEffort}>
                          {EFFORT_LABELS[entry.reasoningEffort] ?? entry.reasoningEffort}
                          {entry.reasoningEffort === activeModel?.defaultReasoningEffort
                            ? " (default)"
                            : ""}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {efforts.find((entry) => entry.reasoningEffort === effort)?.description ? (
                  <p className="text-xs text-muted-foreground">
                    {efforts.find((entry) => entry.reasoningEffort === effort)?.description}
                  </p>
                ) : null}
              </div>
            ) : null}

            {/* Workspace */}
            <div className="flex flex-col gap-2">
              <Label>Workspace</Label>
              <div
                role="radiogroup"
                aria-label="Workspace"
                className="flex flex-col gap-1.5"
                onKeyDown={(event) => {
                  const enabled = WORKSPACE_OPTIONS.filter(
                    (option) => !workspaceBlocker(option.value),
                  ).map((option) => option.value);
                  radioKeyNav(event, enabled, workspace, (value) =>
                    setWorkspace(value as WorkspaceMode),
                  );
                }}
              >
                {WORKSPACE_OPTIONS.map((rawOption) => {
                  const wording =
                    crossMachine && rawOption.crossMachine ? rawOption.crossMachine : rawOption;
                  const option = { ...rawOption, ...wording };
                  const selected = workspace === option.value;
                  const blocker = workspaceBlocker(option.value);
                  const disabled = blocker !== null;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      tabIndex={selected ? 0 : -1}
                      disabled={disabled}
                      onClick={() => setWorkspace(option.value)}
                      className={cn(
                        "flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        selected ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/50",
                        disabled && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <Icon
                        name={option.icon}
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="text-sm font-medium leading-tight">{option.label}</span>
                        <span className="text-xs leading-snug text-muted-foreground">
                          {blocker ?? option.description}
                        </span>
                      </span>
                      <span
                        aria-hidden
                        className={cn(
                          "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                          selected ? "border-primary" : "border-muted-foreground/40",
                        )}
                      >
                        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Briefing */}
            <button
              type="button"
              role="checkbox"
              aria-checked={briefing}
              onClick={() => setBriefing((value) => !value)}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                briefing ? "border-primary/50 bg-primary/5" : "border-border hover:bg-accent/50",
              )}
            >
              <Icon
                name="BubbleChatQuestion"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium leading-tight">
                  Ask {sourceProvider?.displayName ?? "the current agent"} for a briefing
                </span>
                <span className="text-xs leading-snug text-muted-foreground">
                  Before the transfer, the outgoing agent writes a short status note — current
                  state, decisions, gotchas — that travels with the handoff. Skipped automatically
                  if it&apos;s busy; adds up to ~90s.
                </span>
                {briefing && stats && stats.sourceState !== "idle" ? (
                  <span className="mt-0.5 flex items-start gap-1 text-xs leading-snug text-muted-foreground">
                    <Icon name="AlertTriangle" className="mt-px size-3 shrink-0" aria-hidden />
                    {stats.sourceState === "blocked"
                      ? "The agent is waiting on an answer from you right now, so the briefing would be skipped."
                      : "The agent is mid-turn right now, so the briefing would be skipped."}
                  </span>
                ) : null}
              </span>
              <span
                aria-hidden
                className={cn(
                  "mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                  briefing
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40",
                )}
              >
                {briefing ? <Icon name="Check" className="size-2.5" aria-hidden /> : null}
              </span>
            </button>

            {/* Notes */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="handoff-notes">Note for the next agent</Label>
              <Textarea
                id="handoff-notes"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="e.g. Finish the failing tests first; don't refactor the API."
                rows={3}
                className="resize-none"
              />
            </div>

            {/* History */}
            {historyView.rows.length > 0 ? (
              <div className="flex flex-col gap-1">
                <Separator className="mb-3" />
                <p className="mb-1 text-sm font-medium">
                  {historyView.scopedToThread ? "Handoffs of this thread" : "Recent handoffs"}
                </p>
                {historyView.rows.map((row) => (
                  <button
                    key={`${row.at}-${row.targetThreadId}`}
                    type="button"
                    title={new Date(row.at).toLocaleString()}
                    onClick={() => navigate.toThread(row.targetThreadId)}
                    className="group -mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
                      {timeAgo(row.at)}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
                      <span className="truncate">{providerName(row.sourceProvider)}</span>
                      <Icon name="ArrowRight" className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate font-medium">
                        {providerName(row.targetProvider)}
                        {row.model ? ` · ${row.model}` : ""}
                        {row.reasoningLevel
                          ? ` · ${EFFORT_LABELS[row.reasoningLevel] ?? row.reasoningLevel}`
                          : ""}
                      </span>
                      {row.targetMachine ? (
                        <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] leading-tight text-muted-foreground">
                          {row.targetMachine}
                        </span>
                      ) : null}
                      {row.verification === "confirmed" ? (
                        <Icon
                          name="CircleCheck"
                          className="size-3 shrink-0 text-primary"
                          aria-label="The receiving agent confirmed the pickup"
                        />
                      ) : row.verification === "failed" ? (
                        <Icon
                          name="AlertTriangle"
                          className="size-3 shrink-0 text-destructive"
                          aria-label="The receiving thread may not have picked up the context"
                        />
                      ) : null}
                    </span>
                    <Icon
                      name="ExternalLink"
                      className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                      aria-hidden
                    />
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t bg-background p-3">
          {pending ? (
            <div className="flex items-center justify-between gap-3" aria-live="polite">
              <div className="flex items-center gap-3">
                {railStages.map((step, index) => {
                  const done = stage === "done" || index < stageIndex;
                  const active = index === stageIndex && stage !== "done";
                  return (
                    <span
                      key={step.key}
                      className={cn(
                        "flex items-center gap-1.5 text-xs transition-colors",
                        done || active ? "text-foreground" : "text-muted-foreground/60",
                      )}
                    >
                      {done ? (
                        <Icon name="Check" className="size-3 text-primary" aria-hidden />
                      ) : active ? (
                        <Icon name="Loading" className="size-3 animate-spin" aria-hidden />
                      ) : (
                        <span className="size-1.5 rounded-full bg-current opacity-40" aria-hidden />
                      )}
                      {step.label}
                    </span>
                  );
                })}
              </div>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                → {selectedProvider?.displayName ?? providerId}
              </span>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <Button variant="ghost" size="sm" onClick={openPreview} disabled={!stats}>
                <Icon name="FileText" aria-hidden />
                Preview
              </Button>
              <Button onClick={() => void start()} disabled={!providerId || !stats}>
                {selectedProvider ? `Hand off to ${selectedProvider.displayName}` : "Hand off"}
                <Icon name="ArrowRight" aria-hidden />
              </Button>
            </div>
          )}
        </div>

        {/* Preview dialog */}
        <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
          <DialogContent className="sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Handoff document</DialogTitle>
              <DialogDescription>
                {preview
                  ? `${formatBytes(preview.docBytes)} — exactly what the next agent receives${preview.truncated ? " (preview shortened)" : ""}`
                  : "Rendering the document…"}
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[65vh] overflow-y-auto rounded-md border bg-muted/30 p-4">
              {previewError ? (
                <p className="text-sm text-destructive">Couldn&apos;t render the preview.</p>
              ) : preview ? (
                <Markdown content={preview.doc} />
              ) : (
                <div className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              )}
            </div>
            {preview && !previewError ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(preview.doc)
                      .then(() =>
                        toast.success(
                          preview.truncated
                            ? "Copied the shortened preview"
                            : "Copied the handoff markdown",
                        ),
                      )
                      .catch(() => toast.error("Couldn't copy to the clipboard"));
                  }}
                >
                  <Icon name="Copy" aria-hidden />
                  Copy markdown
                </Button>
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "handoff",
    title: "Hand off",
    icon: "ArrowTurnForward",
    layout: "flush",
    component: HandoffPanel,
  });
  app.slots.messageAction({
    id: "handoff-from-here",
    title: "Hand off from here",
    icon: "ArrowTurnForward",
    run: ({ message, openPanel }) => {
      const opened = openPanel({
        actionId: "handoff",
        title: "Hand off",
        params: {
          upToSeq: message.sourceSeqEnd,
          messagePreview: message.text.replace(/\s+/g, " ").trim().slice(0, 200),
          messageRole: message.role,
        },
      });
      if (!opened) toast.error("Couldn't open the Hand off panel here.");
    },
  });
  app.slots.homepageSection({
    id: "adopt",
    title: "Adopt agent session",
    component: AdoptSection,
  });
});
