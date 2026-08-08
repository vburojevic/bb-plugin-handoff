# bb-plugin-handoff

Move a whole session between agents, **in both directions**:

- **Hand off** — capture the full transcript of a bb thread and continue it on
  Codex, Claude Code, opencode, Kimi, or any installed provider in a new thread.
- **Adopt** — take a session that ran *outside* bb in a terminal (Claude Code,
  Codex, Gemini CLI) and continue it as a bb thread in the same directory.

Same problem, two directions: no provider can natively load another provider's
session format, so a rendered transcript is the portable path between them.

## Handing off (bb thread → any provider)

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

Verified live: a Claude Code session handed off to Kimi continued with full
context awareness.

## Adopting (external session → bb thread)

| Agent       | Session store                                  | Continues on                          |
| ----------- | ---------------------------------------------- | ------------------------------------- |
| Claude Code | `~/.claude/projects/<cwd-slug>/*.jsonl`        | `claude-code`                         |
| Codex CLI   | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex`                               |
| Gemini CLI  | `~/.gemini/tmp/<sha256(cwd)>/chats/*.json`     | `claude-code` (no bb Gemini provider) |

- Finds session files for a working directory across all supported agents and
  picks the newest (or the one you name), or locates a pasted id globally.
- Converts the transcript (user + assistant messages, tool-call summaries)
  into a handoff document.
- Spawns a bb thread **in the same directory**, so files are exactly where the
  session left them. The transcript rides along as agent-only context: the bb
  timeline stays clean, the agent gets its full history and confirms where
  things stand.
- The thread runs on the session's own provider family when bb has it;
  otherwise it falls back to `claude-code`. Override with `--thread-provider`.
- The project is auto-matched from the directory (longest project-source
  prefix); if none covers it, one is created.

A session can only be adopted once; pass `--force` to re-adopt.

## Install

```sh
bb plugin install git:https://github.com/vburojevic/bb-plugin-handoff.git@main
# or from a local checkout:
bb plugin install .
```

## Use — UI

- **Hand off**: in any thread, right panel (`⌘J`) → `+` new tab (`⌘T`) →
  **Hand off**. Pick a target agent, optionally a model, workspace mode, and a
  note; preview the exact document; start the handoff and land in the new thread.
- **Adopt**: on the new-thread (compose) screen, expand **Continue a session
  from another agent**. Paste a session id or a whole resume command, or browse
  recent sessions by project/directory and tap one.

## Use — CLI

```sh
# Hand off
bb handoff --self --to codex                 # hand off the current thread
bb handoff <thread-id> --to acp-opencode \
  --model <model> --workspace worktree \
  --instructions "Finish the tests first"
bb handoff <thread-id> --dry-run             # capture stats only
bb handoff export --self --out handoff.md    # for use outside bb:
codex exec - < handoff.md                    #   e.g. pipe into codex
bb handoff targets                           # list available providers
bb handoff list                              # past handoffs

# Adopt — run from inside a live terminal session, or paste an id
bb handoff adopt                             # newest session for this directory
bb handoff adopt 9ace2fd5                    # by id or prefix, any directory
bb handoff adopt "claude --resume 9ace2fd5-d8ae-4946-a0a0-9ff58a6795df"
bb handoff adopt "codex resume 019fd95c-907f-7eb1-8dfc-2aad427ffc09"
bb handoff adopt list --cwd <path>           # what's adoptable here
bb handoff adopt session --dry-run           # plan only
```

Agents get both capabilities through the bundled `handoff` skill — asking an
agent to "continue this in Codex" or "adopt my terminal session" triggers it.

## Layout

```
capture.ts  handoff.ts   handing off: event-log capture → document → spawn
adopt/                   adopting: external session stores → bb thread
  agents/                one adapter per agent (list / find / parse)
  transcript.ts          shared block model + budgeted markdown rendering
  adopt-core.ts          query parsing, global lookup, adoption engine
  cli.ts  rpc.ts  section.tsx
```

Adding an agent: implement `AgentAdapter` from `adopt/transcript.ts` in
`adopt/agents/<name>.ts` (`list(cwd)` discovery, `find(id)` global lookup,
`parse(file)` → transcript blocks) and register it in `adopt/agents/index.ts`.

## Limitations

- Adoption reads sessions from the machine running the bb server (threads
  spawn on the primary host).
- Continuation is transcript-based: the new thread is a fresh provider session
  seeded with the prior conversation, not a native resume of the original
  session file. Work done in the old session *after* adopting is not carried
  over.
- Transcripts are size-capped (adopt: 150k chars by default); the opening
  request and recent tail are kept, oldest middle messages dropped first.
- Not adoptable: agents that don't persist full transcripts locally (Amp
  stores threads server-side; Cursor keeps them in app-internal databases).

## Development

```sh
npm install
npm test              # 42 unit tests (capture/render, adopt engine + adapters)
npm run typecheck
bb plugin install .   # register with your bb
bb plugin dev         # watch loop: rebuild + reload on save
```

`components/ui/` is vendored shadcn-model source from the BB component
registry (pinned in `components.json`) — edit freely, update with
`npx shadcn add @bb/<name>`.
