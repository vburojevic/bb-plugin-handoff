# bb-plugin-handoff

Pass a whole session to another agent, **across providers** — capture the full
transcript of a bb thread and continue it on Codex, Claude Code, opencode,
Kimi, or any installed provider in a new thread.

## How it works

1. **Capture** — pages the thread's provider-independent event log
   (`bb.sdk.threads.events.list`), which carries every user/assistant message,
   tool call with arguments and results, command execution with output,
   reasoning summary, plan, and file change — for any provider.
2. **Native session discovery** — locates the source provider's raw session
   file (Claude Code: `~/.claude/projects/<cwd-slug>/<session>.jsonl`,
   Codex: `~/.codex/sessions/…`) on the thread's host and links it in the
   document for raw-fidelity reference.
3. **Render** — produces a single markdown handoff document: source metadata,
   latest result, "how to continue" instructions, and the full transcript
   (size-budgeted with head+tail retention).
4. **Deliver** — uploads the document as a project attachment and spawns a new
   thread on the target provider via `bb.sdk.threads.spawn`, reusing the same
   workspace by default so the next agent sees uncommitted work.

No provider can natively load another provider's session format; the handoff
document is the provider-official path. Verified live: a Claude Code session
handed off to Kimi continued with full context awareness.

## Install

```sh
bb plugin install git:https://github.com/vburojevic/bb-plugin-handoff.git@main
# or from a local checkout:
bb plugin install .
```

## Use — UI

In any thread: right panel (`⌘J`) → `+` new tab (`⌘T`) → **Hand off**.
Pick a target agent, optionally a model, workspace mode, and a note; preview
the exact document; start the handoff and land in the new thread.

## Use — CLI

```sh
bb handoff --self --to codex                 # hand off the current thread
bb handoff <thread-id> --to acp-opencode \
  --model <model> --workspace worktree \
  --instructions "Finish the tests first"
bb handoff <thread-id> --dry-run             # capture stats only
bb handoff export --self --out handoff.md    # for use outside bb:
codex exec - < handoff.md                    #   e.g. pipe into codex
bb handoff targets                           # list available providers
bb handoff list                              # past handoffs
```

Agents get the same capability through the bundled `handoff` skill — asking an
agent to "continue this in Codex" triggers it.

## Development

```sh
npm install
npx vitest run        # unit tests (pure capture/render logic + orchestration)
npx tsc --noEmit      # typecheck
bb plugin install .   # register with your bb
bb plugin dev         # watch loop: rebuild + reload on save
```

`components/ui/` is vendored shadcn-model source from the BB component
registry (pinned in `components.json`) — edit freely, update with
`npx shadcn add @bb/<name>`.
