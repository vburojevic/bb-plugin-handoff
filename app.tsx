// bb-plugin-handoff — frontend: the "Hand off" thread panel.
//
// Operate-mode surface inside bb's shell: the panel reads as one quiet form —
// route header (source → target), target picker, workspace, notes — with a
// sticky action footer that turns into a live progress rail during a handoff.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
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
import { cn } from "@/lib/utils";

type WorkspaceMode = "reuse" | "worktree" | "personal";

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
  workspace: WorkspaceMode;
  at: number;
}

const STAGES = [
  { key: "capturing", label: "Capture" },
  { key: "rendering", label: "Render" },
  { key: "uploading", label: "Upload" },
  { key: "spawning", label: "Start thread" },
] as const;

const WORKSPACE_OPTIONS: {
  value: WorkspaceMode;
  icon: "FolderOpen" | "Fork" | "Laptop";
  label: string;
  description: string;
}[] = [
  {
    value: "reuse",
    icon: "FolderOpen",
    label: "Same workspace",
    description: "The next agent sees the exact working state, including uncommitted changes.",
  },
  {
    value: "worktree",
    icon: "Fork",
    label: "New worktree",
    description: "An isolated copy of the repo — the original workspace stays untouched.",
  },
  {
    value: "personal",
    icon: "Laptop",
    label: "Personal",
    description: "No repo checkout; a blank personal workspace on the same machine.",
  },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

function HandoffPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();

  const [stats, setStats] = useState<PrepStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [providers, setProviders] = useState<TargetProvider[] | null>(null);
  const [providerId, setProviderId] = useState<string>("");
  const [models, setModels] = useState<{ model: string; displayName: string }[]>([]);
  const [model, setModel] = useState<string>("__default__");
  const [workspace, setWorkspace] = useState<WorkspaceMode>("reuse");
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [history, setHistory] = useState<HandoffRow[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<{ doc: string; docBytes: number; truncated: boolean } | null>(null);
  const [previewError, setPreviewError] = useState(false);

  useRealtime("handoff:progress", (payload) => {
    const data = payload as { sourceThreadId?: string; stage?: string };
    if (data.sourceThreadId === threadId && data.stage) setStage(data.stage);
  });

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setStatsError(null);
    rpc
      .call("prepareHandoff", { threadId })
      .then((result) => {
        if (cancelled) return;
        setStats(result);
        if (!result.hasEnvironment) setWorkspace("worktree");
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatsError(error instanceof Error ? error.message : String(error));
      });
    rpc
      .call("listTargets", { threadId })
      .then((result) => !cancelled && setProviders(result.providers))
      .catch(() => !cancelled && setProviders([]));
    rpc
      .call("history", null)
      .then((result) => !cancelled && setHistory(result.handoffs.slice(0, 8)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, retryNonce]);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setModels([]);
    setModel("__default__");
    rpc
      .call("listModels", { threadId, providerId })
      .then((result) => !cancelled && setModels(result.models))
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, providerId]);

  const selectedProvider = useMemo(
    () => providers?.find((provider) => provider.id === providerId) ?? null,
    [providers, providerId],
  );
  const providerName = useCallback(
    (id: string) => providers?.find((provider) => provider.id === id)?.displayName ?? id,
    [providers],
  );
  const sourceProvider = useMemo(
    () => providers?.find((provider) => provider.id === stats?.providerId) ?? null,
    [providers, stats],
  );

  const openPreview = useCallback(() => {
    setPreviewOpen(true);
    if (preview || previewError) return;
    rpc
      .call("previewHandoff", { threadId })
      .then(setPreview)
      .catch(() => setPreviewError(true));
  }, [rpc, threadId, preview, previewError]);

  const start = useCallback(async () => {
    if (!providerId) return;
    setPending(true);
    setStage("capturing");
    try {
      const result = await rpc.call("startHandoff", {
        threadId,
        providerId,
        ...(model !== "__default__" ? { model } : {}),
        workspace,
        ...(instructions.trim() ? { extraInstructions: instructions.trim() } : {}),
      });
      toast.success(`Handed off to ${selectedProvider?.displayName ?? providerId}`);
      navigate.toThread(result.newThreadId);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Handoff failed");
      setPending(false);
      setStage(null);
    }
  }, [rpc, threadId, providerId, model, workspace, instructions, navigate, selectedProvider]);

  const stageIndex = STAGES.findIndex((step) => step.key === stage);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-6 p-4">
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
                  No agents found on this machine. Install a provider CLI (codex, claude, opencode…)
                  and reload.
                </p>
              ) : (
                <div role="radiogroup" aria-label="Target agent" className="grid grid-cols-2 gap-2">
                  {providers.map((provider) => {
                    const selected = provider.id === providerId;
                    const isCurrent = provider.id === stats?.providerId;
                    return (
                      <button
                        key={provider.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
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
            {models.length > 0 ? (
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

            {/* Workspace */}
            <div className="flex flex-col gap-2">
              <Label>Workspace</Label>
              <div role="radiogroup" aria-label="Workspace" className="flex flex-col gap-1.5">
                {WORKSPACE_OPTIONS.map((option) => {
                  const selected = workspace === option.value;
                  const disabled = option.value === "reuse" && stats ? !stats.hasEnvironment : false;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
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
                          {disabled ? "This thread has no workspace to share." : option.description}
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
            {history.length > 0 ? (
              <div className="flex flex-col gap-1">
                <Separator className="mb-3" />
                <p className="mb-1 text-sm font-medium">Previous handoffs</p>
                {history.map((row) => (
                  <button
                    key={`${row.at}-${row.targetThreadId}`}
                    type="button"
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
                      </span>
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
                {STAGES.map((step, index) => {
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
    icon: "Repeat",
    layout: "flush",
    component: HandoffPanel,
  });
});
