---
name: handoff
description: Pass the whole current session to another agent/provider (e.g. continue a Claude Code session in Codex) in a new thread. Use when the user asks to hand off, switch providers, continue with another agent/model, or export the session for use outside bb.
---

# Session handoff

Pass a session's complete context to a different provider. The plugin captures
the full transcript from bb's event log (all providers), renders a handoff
document, and spawns a new thread on the target provider seeded with it.

## Commands

- `bb handoff --self --to <provider>` — hand off the current thread. Providers
  from `bb handoff targets` (e.g. `codex`, `claude-code`, `acp-opencode`).
- `bb handoff <thread-id> --to <provider> [--model <model>] [--workspace reuse|worktree|personal] [--instructions <text>]`
- `bb handoff <thread-id|--self> --dry-run` — capture stats only, no thread.
- `bb handoff export <thread-id|--self> [--out <path>]` — write the handoff
  markdown to a file for use outside bb: `codex exec - < handoff.md` or
  `claude -p "$(cat handoff.md)"`.
- `bb handoff list` — past handoffs.

## When to use

- "Continue this in Codex / Claude / another model" → `bb handoff --self --to <provider>`
- "Hand this off / give this to another agent" → same, ask which provider if unclear.
- Default `--workspace reuse` keeps the same files so the next agent sees
  uncommitted work. Use `worktree` for an isolated copy.
- After starting a handoff, tell the user the new thread id and stop working on
  the task yourself — the receiving agent owns it now.
