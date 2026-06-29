# opencode-compaction-guard

[![CI & Publish](https://github.com/viiqswim/opencode-compaction-guard/actions/workflows/publish.yml/badge.svg)](https://github.com/viiqswim/opencode-compaction-guard/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/opencode-compaction-guard.svg)](https://www.npmjs.com/package/opencode-compaction-guard)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An [OpenCode](https://github.com/anomalyco/opencode) plugin that **prevents** and **auto-recovers** from the error that makes a session permanently unrecoverable after auto-compaction (or after an interrupted tool call):

```
messages.N: `tool_use` ids were found without `tool_result` blocks immediately
after: toolu_XXXX. Each `tool_use` block must have a corresponding `tool_result`
block in the next message.
```

When this happens, Anthropic returns a `400` and **every subsequent message in
the session fails** — including `continue`. Without this plugin your only escape
is to abandon the session (open a new terminal) or do manual DB surgery.

## The problem

Anthropic's API requires that every `tool_use` block is immediately followed by
its matching `tool_result` block. Two things in OpenCode can break that pairing:

1. **Interrupted / aborted tool calls** — a tool left in `pending`/`running`
   state produces a `tool_use` with no `tool_result`.
2. **Session compaction** — when OpenCode trims a long session, the slice
   boundary can split a `tool_use` from its `tool_result`, and on auto-compaction
   it can re-fire and wedge the session into a non-recoverable loop.

This is a known, still-unreleased-fix bug. See **Prior art & references** below.

## What this plugin does (two layers)

Think of it as a **seatbelt** and an **airbag**.

1. **Prevent (`experimental.chat.messages.transform`)** — runs before every
   request *and* before compaction. It finds any tool call stuck in
   `pending`/`running` state and converts it to an error result, so every
   `tool_use` always has a paired `tool_result`. This eliminates the most common
   orphan source before it ever reaches Anthropic.

2. **Recover (`event` → `session.error`)** — if an orphan still slips through and
   Anthropic returns the `400`, the plugin automatically reverts the failed
   trailing turn (the same "undo the last turn" you'd otherwise do by hand) and
   shows a toast. Your session keeps working instead of dying. It is **debounced
   (20s per session)** so it can never loop, and the revert is reversible with
   `/unrevert`.

## Install

### Option A — one line (recommended)

Add the package to the `plugin` array in your OpenCode config
(`~/.config/opencode/opencode.json` or your project's `opencode.json`):

```jsonc
{
  "plugin": [
    "opencode-compaction-guard@latest"
  ]
}
```

Restart OpenCode. Done.

### Option B — manual (no npm)

Download [`plugin/compaction-tool-pair-guard.mjs`](plugin/compaction-tool-pair-guard.mjs)
into your global plugin folder:

```bash
mkdir -p ~/.config/opencode/plugin
curl -fsSL https://raw.githubusercontent.com/viiqswim/opencode-compaction-guard/main/plugin/compaction-tool-pair-guard.mjs \
  -o ~/.config/opencode/plugin/compaction-tool-pair-guard.mjs
```

Restart OpenCode. It loads automatically — no config changes needed, and it
applies to every project and every worktree.

## How do I know it's working?

OpenCode captures the plugin's `console.log` output. When it acts you'll see
lines prefixed `[compaction-tool-pair-guard]`, e.g.:

```
[compaction-tool-pair-guard] healed 1 dangling tool call(s) before request
[compaction-tool-pair-guard] reverted message <id> to recover session <id>
```

…and the recovery path also pops a toast: **"Session recovered."**

## Known limitations (read this)

- The **prevent** layer fully covers the *interrupted-tool* orphan class.
- The pure *compaction-slice* orphan class is created **downstream of where any
  plugin hook can reach** to prevent it, so for that class the plugin relies on
  the **recover** (auto-revert) path rather than stopping it from happening.
- This is a **stopgap, not the upstream fix.** The real fix belongs in
  OpenCode's message-conversion / compaction logic. Track
  [anomalyco/opencode#27594](https://github.com/anomalyco/opencode/issues/27594).
  When a release ships the fix, you can remove this plugin.

## Compatibility

- Built against the `@opencode-ai/plugin` `1.3.x` hook API; uses only stable
  public hooks (`event`, `experimental.chat.messages.transform`) and SDK methods
  (`session.messages`, `session.revert`, `tui.showToast`).
- Most relevant to **Anthropic / Claude** models, which enforce strict
  `tool_use`/`tool_result` pairing. Harmless on other providers.

## Prior art & references

This plugin packages and combines approaches already identified by the
community — credit to those investigations:

- The "convert pending/running tool calls to error results" heal is essentially
  the approach in **[anomalyco/opencode#8497](https://github.com/anomalyco/opencode/issues/8497)**.
- The "revert on `session.error`" recovery was described in a comment on
  **[anomalyco/opencode#1662](https://github.com/anomalyco/opencode/issues/1662)**.
- Root-cause analysis of the compaction slice / auto-retrigger:
  **[#27594](https://github.com/anomalyco/opencode/issues/27594)**,
  **[#14367](https://github.com/anomalyco/opencode/issues/14367)**,
  **[#17065](https://github.com/anomalyco/opencode/issues/17065)**,
  **[#21326](https://github.com/anomalyco/opencode/issues/21326)**,
  **[#10616](https://github.com/anomalyco/opencode/issues/10616)**.

## License

[MIT](LICENSE)
