<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/readme/mark-dark.svg">
  <img src="assets/readme/mark-light.svg" width="56" height="56" alt="">
</picture>

# Handoff

**Move a whole session between agents and machines, in both directions.**

Hand a bb thread off to Codex, Claude Code, Kimi, opencode, Cursor and more,<br>
or adopt a terminal session that never ran in bb at all.

<a href="https://github.com/vburojevic/bb-plugin-handoff/releases/latest"><img src="https://img.shields.io/github/v/release/vburojevic/bb-plugin-handoff?style=flat-square&color=57606a&label=release" alt="Latest release"></a>
<a href="https://getbb.app"><img src="https://img.shields.io/badge/bb-%E2%89%A5%200.49-57606a?style=flat-square" alt="Requires bb 0.49 or newer"></a>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-57606a?style=flat-square" alt="MIT license"></a>
<a href="https://github.com/get-bb/marketplace"><img src="https://img.shields.io/badge/BB%20Community-marketplace-57606a?style=flat-square" alt="Listed in the BB Community marketplace"></a>

</div>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/handoff-panel-dark.png">
  <img src="assets/screenshots/handoff-panel.png" width="100%" alt="The Hand off panel beside a Claude Code thread: Codex picked as the target, with model, thinking effort and workspace below">
</picture>

<p align="center"><sub>Every screenshot on this page is a real bb window, shot against a throwaway demo project.</sub></p>

## Install

```sh
bb plugin install handoff
```

Or straight from this repository:

```sh
bb plugin install git:https://github.com/vburojevic/bb-plugin-handoff.git
```

> [!NOTE]
> Requires bb 0.49 or newer. No keys, no configuration, no external services: it only talks to your own bb and the session files already on your disks. Older bb keeps the last release it supports, because bb only updates a plugin to a release whose engine range it meets.

## Why

No agent can load another agent's session file. Claude Code's JSONL means nothing to Codex, Codex's rollouts mean nothing to opencode, and a session is pinned to the machine whose disk it sits on. So the portable thing isn't the session format. It's a **rendered transcript plus the working state it talks about**.

That's the whole idea, applied in both directions:

|              | From                                                                 | To                                                        |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------------- |
| **Hand off** | a bb thread on any provider                                          | a new thread on any other provider, any enrolled machine |
| **Adopt**    | a Claude Code, Codex, Gemini or OpenCode session in your terminal    | a bb thread in the same directory, with its history       |

```mermaid
flowchart LR
  T["bb thread<br>any provider"] -->|hand off| D["handoff document<br>transcript + working state"]
  D --> N["new bb thread<br>any provider, any machine"]
  S["terminal session<br>Claude Code, Codex,<br>Gemini CLI, OpenCode"] -->|adopt| A["bb thread<br>same directory, full history"]
```

## Hand off: bb thread to any agent

Open any thread's right panel (<kbd>⌘</kbd> <kbd>J</kbd>) and add the **Hand off** tab. Pick a target; everything else has a sane default.

<table>
<tr>
<td width="50%" valign="top">

#### Any installed provider is a target

The panel reads bb's live catalog, so Codex, Claude Code, Kimi Code, opencode, Cursor, Pi, Hermes and anything else you've installed show up, with the unavailable ones sunk to the bottom rather than hidden.

</td>
<td width="50%" valign="top">

#### Model and thinking effort

They are the target's own, not the source's: pick `gpt-5.6-sol` on Codex or leave it at the provider default, then choose from exactly the reasoning levels that model accepts.

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### The workspace is a choice, not a guess

Continue in the same working directory (uncommitted changes and all), the project checkout, a fresh worktree, or a blank personal workspace.

</td>
<td width="50%" valign="top">

#### Optional briefing

Before the transfer, the outgoing agent writes a short status note (current state, decisions made, gotchas) that travels as its own section of the document. Skipped automatically when it's mid-turn or stops to ask you something.

</td>
</tr>
</table>

### See exactly what the next agent gets

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/handoff-document-dark.png">
  <img src="assets/screenshots/handoff-document.png" width="100%" alt="The handoff document preview: source thread, provider and workspace, then how-to-continue instructions for the next agent">
</picture>

**Preview** renders the document byte for byte before anything is spawned: source thread and provider, workspace and branch, a link to the source provider's own raw session file, explicit "how to continue" instructions, and the full transcript. That means every user and assistant message, tool call with its arguments and result, command output, reasoning summary, plan and file change, pulled from bb's provider-independent event log rather than from any one agent's format.

Oversized transcripts are budgeted, not truncated blindly: the opening request and the recent tail are kept, and the oldest middle is dropped first.

### Hand off from *here*, not from the top

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/handoff-from-here-dark.png">
  <img src="assets/screenshots/handoff-from-here.png" width="100%" alt="A message's action bar beside the Hand off panel, scoped to that message with a banner saying everything after it stays out">
</picture>

Hover any message, then **Hand off from here**. The panel re-scopes to the conversation *up to that message*: the false start, the abandoned approach and everything after it stay out of the document. The banner shows exactly where the cut lands, and clearing it restores the full thread.

### Send it to another machine

<img src="assets/screenshots/target-machine.png" width="100%" alt="The machine picker offering another enrolled machine as the handoff target">

Pick a different enrolled machine and the whole panel re-scopes to it: its provider catalog, its models, its checkouts. A workspace can't span machines, so the modes adapt:

| Workspace  | Same machine                      | Another machine                                                       |
| ---------- | --------------------------------- | --------------------------------------------------------------------- |
| `reuse`    | the thread's own environment      | not possible: an environment lives on one host                        |
| `checkout` | the project's checkout            | that machine's checkout of the same project                           |
| `worktree` | isolated worktree, default branch | isolated worktree, based on the thread's branch when it exists there  |
| `personal` | blank workspace                   | blank workspace over there                                            |

A personal-workspace handoff lands in bb's own Personal project, since bb only creates personal workspaces there.

A machine hop is the one case where a transcript alone would mislead: the files it discusses are on a disk the next agent can't see. So the handoff also:

- captures the source working tree's git state (branch, HEAD, dirty files),
- writes everything uncommitted as a patch **on the target machine**, with `git apply --3way` instructions in the document, while the originals never move,
- rewrites the document so the source path and raw session file are named as living on the *other* machine, not offered as readable,
- warns when the thread's branch doesn't exist over there and falls back to the default branch instead of failing.

## Adopt: terminal session to bb thread

The other direction. You've been working in a plain terminal, it's turning into real work, and you want it in bb, with its history, in its own directory.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/adopt-session-dark.png">
  <img src="assets/screenshots/adopt-session.png" width="100%" alt="The Adopt agent session section on the new-thread screen, listing a recent Claude Code session for the Aurora project">
</picture>

On the new-thread screen, expand **Continue a session from another agent**. Paste a session id, or the whole resume command you'd have typed:

```
claude --resume 9ace2fd5-d8ae-4946-a0a0-9ff58a6795df
codex resume 019fd95c-907f-7eb1-8dfc-2aad427ffc09
```

Or just browse recent sessions per project and tap one.

| Agent       | Session store                                  | Continues on                          |
| ----------- | ---------------------------------------------- | ------------------------------------- |
| Claude Code | `~/.claude/projects/<cwd-slug>/*.jsonl`        | `claude-code`                         |
| Codex CLI   | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `codex`                               |
| Gemini CLI  | `~/.gemini/tmp/<sha256(cwd)>/chats/*.json`     | `claude-code` (no bb Gemini provider) |
| OpenCode    | `~/.local/share/opencode/opencode.db` (SQLite) | `acp-opencode`                        |

- **Claude Code profiles.** Claude Code's store moves with `CLAUDE_CONFIG_DIR`. Adoption reads the configured directory, the default `~/.claude`, and any sibling profile directory (`~/.claude-work`, `~/.claude-personal`), so sessions started under a non-default profile are adoptable too, on this machine and on another one.
- **Same directory.** The new thread starts **in the session's own directory**, so the files are exactly where you left them.
- **Clean timeline.** The transcript rides along as agent-only context: your bb timeline stays clean, the agent gets the full history.
- **Project matching.** The project is matched from the directory (longest project-source prefix). If nothing covers it, one is created.
- **Live sessions.** A session with activity in the last ~10 minutes is flagged as "may still be running", both in the session list and to the new agent, which watches for concurrent edits.
- **Other machines.** `--machine <host>` adopts from another enrolled machine and runs the thread over there. Claude and Codex resolve from a session id alone; Gemini and OpenCode need `--cwd`, since their ids live inside a file and a SQLite row. The panel has the same axis: a **From machine** picker appears once a second machine is enrolled. And `bb handoff adopt` run from a bb thread that lives on another machine follows that machine automatically: its directory is over there, so that is where the sessions are read.

> [!TIP]
> Agents get both directions through the bundled `handoff` skill. Asking an agent to "continue this in Codex" or "adopt my terminal session" is enough to trigger it.

## Reference

<details>
<summary><b>CLI</b></summary>

```sh
# Hand off
bb handoff --self --to codex                     # the current thread
bb handoff <thread-id> --to acp-opencode \
  --model <model> --effort high --workspace worktree \
  --instructions "Finish the tests first"
bb handoff <thread-id> --to codex --briefing     # ask the source agent for a note first
bb handoff <thread-id> --to codex --up-to-seq <n>   # only up to one message
bb handoff <thread-id> --to codex --machine mini    # continue on another machine
bb handoff <thread-id> --dry-run                 # capture stats only

bb handoff export --self --out handoff.md        # for use outside bb entirely:
codex exec - < handoff.md                        #   pipe the document anywhere

bb handoff targets [--machine <host>] [--json]   # providers per machine, + machines
bb handoff list [--json]                         # past handoffs (last 100)

# Adopt: run inside a live terminal session, or paste an id
bb handoff adopt                                 # newest session for this directory
bb handoff adopt 9ace2fd5                        # by id or prefix, any directory
bb handoff adopt "claude --resume 9ace2fd5-…"    # or the whole resume command
bb handoff adopt list --cwd <path>               # what's adoptable here
bb handoff adopt list --machine mini --cwd <path>   # …and over there
```

`--effort` takes `none`, `low`, `medium`, `high`, `xhigh`, `ultracode`, `max` or `ultra`; the levels a model accepts vary by model, so omit it to use the target model's own default.

</details>

<details>
<summary><b>How it works</b></summary>

```
capture.ts  handoff.ts   handing off: event-log capture → document → spawn
machines.ts              the machine axis: target host + workspace planning,
                         working-tree capture, patch delivery
adopt/                   adopting: external session stores → bb thread
  agents/                one adapter per agent (list / find / parse)
  transcript.ts          shared block model + budgeted markdown rendering
  adopt-core.ts          query parsing, global lookup, adoption engine
  remote.ts              the same stores read over bb's host file API and a
                         short-lived host terminal
```

Adding an agent means implementing `AgentAdapter` from `adopt/transcript.ts` in `adopt/agents/<name>.ts` (`list(cwd)` for discovery, `find(id)` for global lookup, `parse(file)` for transcript blocks) and registering it in `adopt/agents/index.ts`.

</details>

<details>
<summary><b>Development</b></summary>

```sh
npm install
npm test            # 179 unit tests: capture/render, transfer planning,
                    # adopt engine + adapters, remote store readers, CLI guards
npm run typecheck
bb plugin install . # register this checkout with your bb
bb plugin dev       # watch loop: rebuild + reload on save
```

The plugin builds against the [`@get-bb/plugin-sdk`](https://www.npmjs.com/package/@get-bb/plugin-sdk) package; `bb plugin types .` keeps its pin and the shimmed packages in step with your bb.

`components/ui/` is vendored shadcn-model source from the BB component registry (pinned in `components.json`). Edit freely, and update with `npx shadcn add @bb/<name>`.

</details>

## Limitations

- **Continuation is transcript-based**, not a native resume: the new thread is a fresh provider session seeded with the prior conversation. Work done in the old session *after* the handoff isn't carried over.
- **Cross-machine carries a patch, not a workspace** (capped at 2 MB). When the changes don't fit, the patch keeps the files that fit whole and the document names the rest. Untracked build output, ignored files and anything outside the repo stay behind.
- **Remote reads need the machine connected.** Discovery there runs one short-lived terminal (POSIX `sh`, `stat`, `find`, plus `sqlite3` for OpenCode). Without it, adoption by explicit session id still works for Claude and Codex through the file API alone.
- **Remote listings are directory-scoped** (`--cwd` is required, since the invoking directory is a path on *this* machine) and show no titles, since reading one would cost a round trip per session.
- **Transcripts are size-capped** (adopt: 150k chars by default).
- **Not adoptable:** agents that don't persist full transcripts locally. Amp keeps threads server-side, and Cursor keeps them in app-internal databases.

## License

[MIT](LICENSE) © Vedran Burojevic

<br>

<p align="center"><sub>More plugins for bb: <a href="https://github.com/vburojevic/bb-plugins"><b>vburojevic/bb-plugins</b></a></sub></p>
