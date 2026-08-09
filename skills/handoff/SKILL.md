---
name: handoff
description: Move a session between agents and between machines, in either direction — hand the current bb thread off to another agent/provider (e.g. continue a Claude Code session in Codex) and optionally onto another enrolled machine, or adopt a session that ran outside bb (Claude Code, Codex, Gemini CLI, OpenCode) on this or another machine as a bb thread. Use when the user asks to hand off, switch providers, continue with another agent/model, move or resume work on another machine, export the session for use outside bb, or continue/adopt/import an external terminal session into bb.
---

# Session handoff

Move a whole session between agents, in both directions.

- **Out (hand off)** — capture the current bb thread's full transcript from
  bb's event log (works for every provider), render a handoff document, and
  spawn a new thread on the target provider seeded with it.
- **In (adopt)** — take a session that ran *outside* bb in a terminal (Claude
  Code, Codex, Gemini CLI, or OpenCode), and continue it as a bb thread in the
  same directory with its full history.

Both directions cross machines with `--machine <host>`: hand a thread off to
another enrolled machine, or adopt a session that lives on one.

## Commands — handing off

- `bb handoff --self --to <provider>` — hand off the current thread. Providers
  from `bb handoff targets` (e.g. `codex`, `claude-code`, `acp-opencode`).
- `bb handoff <thread-id> --to <provider> [--model <model>] [--workspace reuse|worktree|personal] [--instructions <text>]`
- `bb handoff <thread-id|--self> --to <provider> --up-to-seq <n>` — hand off
  only the context up to one chat message (its `sourceSeqEnd`); everything
  after that message is excluded from the handoff document. This is what the
  "Hand off from here" per-message action uses.
- `bb handoff <thread-id> --to <provider> --briefing` — first ask the source
  agent (if idle) to write a handoff briefing; it travels as its own section of
  the handoff document. Skipped automatically when the source thread is busy —
  so it is pointless on `--self` (that thread is busy running the command;
  put your notes in `--instructions` instead).
- `bb handoff <thread-id|--self> --dry-run` — capture stats only, no thread.
- `bb handoff export <thread-id|--self> [--out <path>]` — write the handoff
  markdown to a file for use outside bb: `codex exec - < handoff.md` or
  `claude -p "$(cat handoff.md)"`.
- `bb handoff <thread-id|--self> --to <provider> --machine <host name|id>` —
  run the new thread on another enrolled machine. `--workspace` then means:
  `checkout` (that machine's checkout of the same project — the default when
  `--machine` is given), `worktree` (fresh worktree there, based on this
  thread's branch when it exists), or `personal` (blank). `reuse` is
  same-machine only — an environment cannot span machines.
  The source workspace's uncommitted changes are written as a patch to
  `/tmp/bb-handoff-<thread>.patch` on the target machine, and the handoff
  document tells the receiving agent to `git apply --3way` it. Use `--dry-run`
  first to see the target workspace, the branch decision, and how much
  uncommitted work would travel.
- `bb handoff list` — past handoffs. `list` and `targets` take `--json` for
  machine-readable output (`targets --machine <host>` lists that machine's
  providers, plus every enrolled machine); `bb handoff help` prints the usage
  overview.

## Commands — adopting

- `bb handoff adopt` — adopt the newest external session for the current
  directory. Run it from inside a live terminal session and it adopts *that*
  session.
- `bb handoff adopt <id | resume command>` — paste a session id, an id prefix,
  or a whole resume command (`claude --resume <id>`, `codex resume <id>`); the
  id is located across every agent's session store, in any directory.
- `bb handoff adopt list [--cwd <path>] [--agent claude|codex|gemini|opencode]`
  — show adoptable sessions for a directory, newest first.
- `bb handoff adopt <id> --machine <host name|id> [--home <path>] [--cwd <path>]`
  — adopt a session living on another enrolled machine; the thread runs there,
  in the session's own directory. Claude Code and Codex are found by id alone;
  Gemini and OpenCode need `--cwd` (or an exact id). With `--cwd` and no id,
  the newest session for that directory over there is adopted.
- `bb handoff adopt list --machine <host> --cwd <path>` — what is adoptable in
  a directory on another machine. `--cwd` is required there: the invoking
  directory is a path on *this* machine.
- Useful flags: `--dry-run` (plan only), `--force` (re-adopt a session already
  adopted), `--thread-provider <id>` (continue on a different bb provider),
  `--json`.

## When to use

- "Continue this in Codex / Claude / another model" → `bb handoff --self --to <provider>`
- "Hand this off / give this to another agent" → same, ask which provider if unclear.
- Default `--workspace reuse` keeps the same files so the next agent sees
  uncommitted work. Use `worktree` for an isolated copy.
- "Continue this on my other Mac / the remote box / <machine name>", "move this
  to <machine>" → add `--machine <host>` (see `bb handoff targets` for the
  names). Say which workspace it landed in and whether uncommitted work
  travelled — on a machine hop the files are not simply there.
- After starting a handoff, tell the user the new thread id and stop working on
  the task yourself — the receiving agent owns it now. The plugin watches the
  receiving thread's first turn and records on the handoff history whether the
  pickup was confirmed (`bb handoff list --json` shows `verification`). If the receiving agent
  later asks you a question via `bb thread tell`, answer it, but do not resume
  working on the task.
- If you received a handoff document, it names the source thread — when
  something essential is unclear, ask that thread directly
  (`bb thread tell <id> "<question>" --mode queue`, then `bb thread wait <id>`
  and `bb thread output <id>`), then continue on your own.
- "Continue my terminal Claude/Codex session in bb", "adopt/import this
  session" → `bb handoff adopt` (from that session's directory), or paste the
  id. The adopted thread is a *separate* thread that continues the transcript;
  work done in the original session after adopting is not carried over.
