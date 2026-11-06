# dsh-seal-scripts

[简体中文](./README.md) | **English**

> Seal the scripts that worked. Keep what compaction threw away.

[![version](https://img.shields.io/npm/v/dsh-seal-scripts?color=4a7cff)](https://www.npmjs.com/package/dsh-seal-scripts)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2%20%3C1.0.0-6f42c1)](https://github.com/deepseek-ai/dsh)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](./package.json)

**Sealed scripts are the point of this plugin.** A command chain that just worked is sealed on the spot into an executable tool script: a directory, a manifest, one line in the system prompt. Next time it runs with a single sentence — no re-deriving commands, no rewriting the script, no asking you to repeat yourself.

**Reviews are the base layer.** When DSH compacts the context, the shadowed transcript is written to disk as a review file, decays by calendar day, and is injected into context; when details matter, the model reads the original back from a clue. Reviews are also the raw material for sealing a workflow from an earlier session.

## Contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [Sealed scripts](#sealed-scripts)
- [Reviews](#reviews-and-context-memory)
- [Configuration](#configuration)
- [Settings page](#settings-page)
- [Data and backup](#data-and-backup)
- [Compatibility](#compatibility-and-degradation)
- [Known limitations](#known-limitations)
- [Development](#development)

## Features

**Sealed scripts**

- **One working chain → one tool script**: full script text, entry, args, steps, provenance and a per-file sha256, written in one go.
- **Present in the system prompt**: the tool list sits at the end of the prompt every turn (up to 24 entries), so the model knows what it can run.
- **Runs as written**: arguments travel as an argv array and never pass through a shell; the interpreter comes from the run field (bash / node / powershell / cmd).
- **Verifiable**: per-file sha256 is compared before running; a hand-edited script is refused unless you explicitly allow it.
- **Portable**: the whole set packs into a store-only zip; import previews before writing and rebuilds the index from the files on disk.

**Context reviews**

- **Written on compaction**: pure code, no model call; tool calls and their arguments are kept verbatim.
- **Four-level decay**: today original → next-day summary → diary → keyword index; reading it bumps one level and pins it.
- **Cross-workspace search**: this workspace → children → siblings → parents; outer rings need explicit permission.
- **Diary nudges**: while keywords or the diary are still empty the model is asked to finish them in one call; the nudge disappears once they are written.

**Engineering**

- Zero runtime dependencies, Node built-ins only. Chinese and English UI.
- A missing host capability disables that block only — no crash, no blank settings page.
- Plain-text data: copy `session-memory/` and you have a backup.

## Install

Add the package in the DSH plugin manager (package name, absolute local path, tarball, or Git URL):

~~~bash
# --profile is required (otherwise: required option "--profile" not specified)
dsh plugin --profile web add dsh-seal-scripts

# local directory: pnpm records it as a link dependency in that profile
dsh plugin --profile web add /path/to/dsh-seal-scripts
~~~

Or use Settings → Plugins → Add with a package name, absolute path, tarball, or Git URL. Restart the profile after installing.

Requirements:

- host `@deepseek-ai/dsh` `>=0.2.1-rc.2`, `<1.0.0` (peer dependency, not forced)
- Node `>=18` (without native zstd the built-in decoder takes over; functionality is unchanged)

After the restart, Settings shows **Tool (script) manager**.

## Quick start

1. **Open the master switch**: Settings → Tool (script) manager → Options → turn on **Auto review**. It is off by default; without it no review is created and cross-session sealing has no raw material.
2. **Run a chain end to end**: scrape a page, transcode, pack, connect over SSH — anything that really worked and that you will need again.
3. **Seal it**: ask the model to turn the steps above into a tool.
4. **Reuse it**: ask it to run `<id>`; add show me the commands first, do not run to preview.

A sample session (output is illustrative):

~~~text
You: turn that packaging flow into a tool
Model: (calls session_tool_create_write) installed tool script dsh-plugin-pack at .../toolSequence/dsh-plugin-pack
       entry pack.sh, params source_dir out_dir; it enters the system prompt on the next assembly.

(new session)
You: run dsh-plugin-pack, the source dir is /sdcard/Download/dsh-seal-scripts-0.4.6
Model: (calls session_tool_call) exit 0, N files, sha256 matches the manifest
~~~

## Sealed scripts

### Why this is not a note

Models are good at writing markdown about a method, and the note cannot run. They are also good at rebuilding commands on the spot, slightly differently each time. The artifact here is the script itself: the lines that worked, stored byte for byte, argument order included.

### How to trigger it

| What you say | What happens | When to use |
|---|---|---|
| turn the steps above into a tool | seals the steps that just ran | same session, commands still in context |
| turn the workflow from an earlier session into a tool | reads review originals first with `session_tool_create_read` (every tool call and its arguments), then seals | new session, new machine, old history |

The chain must have worked. What gets stored is the version that ran, not a draft — editing after installing means re-sending the whole context.

### What gets created

~~~
$DSH_HOME/session-memory/toolSequence/
    _index.json             registry: id, title, purpose, entry, args, steps, per-file sha256
    <id>/
        toolScript.json     manifest: full script text, docs, hashes, provenance (review file + line)
        <script>            the file that actually runs (.sh / .js .mjs .cjs / .ps1 / .bat .cmd)
        README.md           generated from the manifest at install time, for humans
        <notes>.md          read-only notes: pitfalls, paths, benchmarks (never executed)
    _runs/                  full logs of output that exceeded the cap
    <id>.bak-<timestamp>/   previous directory kept on reinstall or import
~~~

### How the model learns about it

The end of the system prompt gains a toolSequence block: at most 24 entries, and the whole block (header + guide + entries) is capped at 1600 characters, one line each — `· id (title): purpose｜entry <entry>｜args <p1> <p2>`. After sealing you never have to remind the model that the tool exists.

When that list refreshes (option **When the list is refreshed**):

| Mode | Behaviour | Cost |
|---|---|---|
| Before a new session (default) | computed once at the first assembly, then fixed until the session ends | installing or removing a tool mid-session leaves the prompt unchanged |
| Live per session | computed every turn | one cache miss on the next message (the whole session is resent) |

Changing that mode refreshes every remembered session to the current list — so there is a defined way out of the current session does not see the new tool case.

### The three tools

| Tool | Purpose | Key arguments |
|---|---|---|
| `session_tool_create_write` | seal a chain | `toolScript{ id, title, purpose, entry, scripts[], docs[], params, steps, timeoutMs }`; `replace` overwrites |
| `session_tool_create_read` | read review originals (tool calls and results included), read-only | `file` or `date`+`nth`; `mode` = outline / raw / block; `cursor`, `chars` paging; `line`, `span` for one call |
| `session_tool_call` | run as written | `toolScript`, `step`, `args`, `stdin`, `cwd`, `dryRun`, `calls`, `stopOnError`, `allowDrift`, `timeoutMs`, `maxOutputBytes` |

- Calling `session_tool_call` without arguments lists every tool script.
- `dryRun: true` echoes the arguments and cwd without running.
- `calls: []` runs up to 20 entries in order, reporting exit code, duration, stdout and stderr per entry.

### Validation when sealing

| Item | Rule |
|---|---|
| `id` | starts with a lowercase letter, 2–41 chars, only `a-z0-9-` |
| file name | starts alphanumeric, no leading dot, no path separators, up to 61 chars |
| `run` vs extension | bash→`.sh`; node→`.js/.mjs/.cjs`; ps1→`.ps1`; cmd→`.bat/.cmd` |
| size | one script ≤ 64 KB; one tool script (scripts + docs) ≤ 512 KB |
| `title` / `purpose` | non-empty; purpose ≤ 600 bytes (it enters the prompt; display truncates at 80 chars) |
| `entry` / `steps` | must name files in `scripts`; entry defaults to the first script |
| `timeoutMs` | 1000–600000, default 120000 |
| docs | must be `.md`, may not be called `README.md`, no duplicates |
| script body | non-empty; must not contain `<!--ovr:` (it would break review markers) |
| same id exists | refused without `replace`; the error quotes the first 12 hex chars of the manifest sha256 |

`steps` only declares pipeline order and never runs anything by itself; `params` only declares argv order and names are not validated.

### Execution semantics

| Item | Value |
|---|---|
| interpreter | bash→`bash` from PATH; node→current `process.execPath`; ps1→Windows PowerShell (or `pwsh` elsewhere); cmd→`%ComSpec% /d /c` (falls back to `sh` off Windows) |
| argv | interpreter arguments + absolute script path + your args, passed as an array, never through a shell |
| cwd | `workspace` (session workspace), `toolScript` (the script directory), or an absolute path inside either |
| environment | inherits `process.env`, plus `TOOL_NAME`, `TOOL_SCRIPT`, `TOOL_ROOT`, `DSH_HOME` |
| timeout | 120 s by default, 600 s maximum; SIGTERM → 2 s → SIGKILL; process group on POSIX, `taskkill /T /F` on Windows |
| output | 64 KB default, 1 MB maximum, stdout and stderr share the budget; overflow goes in full to `_runs/` and the reply carries the head plus the file path |
| result | `{ exitCode, signal, timedOut, stdout, stderr, truncated, spill }`; success is not judged for the caller |
| argument count | more arguments than `params` declares fails before running (they would shift); fewer is fine |
| drift | sha256 is compared first; mismatch refuses, `allowDrift: true` allows it and marks the result |
| containment | only files inside the tool script directory run; a script name missing from the manifest is refused |

### Import / export

- **Export**: Sealed tools tab → Export. Packs `toolSequence.zip` (store, no compression) straight into the current session workspace and returns the real path — no browser download. Over 24 MB is refused.
- **Import**: pick a zip → `dryRun` preview of what will be installed, overwritten and skipped → confirm to write. An existing directory is kept as `.bak-<timestamp>`.
- `_index.json` inside the package is not trusted; the index is rebuilt from the files on disk. `_runs`, backup directories, escaping paths and invalid ids are skipped.
- Limits: 64 MB per entry, 128 MB total; zip64 and encrypted archives are not supported.

## Reviews and context memory

The problem reviews solve: after compaction the earlier detail is normally gone. Now the shadowed transcript is kept as a file and can be read back when it matters.

### When a review is created

- Only on **compaction**: when DSH compacts, the shadowed events are written as one review file (summary + original + an empty diary section).
- Tool calls and their arguments are kept verbatim, never truncated — once the log is gone, this copy is the only original.
- Spawned subagent sessions produce nothing; with Auto review off, not even detection happens.
- Delete + review in the Sessions tab triggers one on purpose: compact, wait for the review to land, confirm a new one appeared, and only then delete. Any failed step aborts the deletion.

### Four levels

| Day | Level | What the model sees |
|---|---|---|
| the day of compaction | 3 | the original dialogue (tool calls and errors filtered out) |
| day 2 | 2 | the compaction summary |
| days 3–28 | 1 | the diary (written by the model) |
| day 29 and later | 0 | keywords plus the file name, as an index |

Days are local calendar days; the hour does not matter. When you point out a misremembered detail, the model reads the original back; only reading the workspace own copy bumps and pins the level (0→1, 1→2), and a pinned review stops decaying. Reviews of child, sibling and parent workspaces are read-only and do not change levels.

### Cross-workspace search

The unit is a workspace review folder, not a filesystem walk. Order: this workspace → its children (deepest first) → siblings (deepest first) → the parent → the parent siblings → their level-1, level-2 children, and so on. Outer rings are only read when `allowOuter` is true; otherwise the count is reported.

Granularity: keywords first, then summary, then original; the block that matches is returned whole. Within a workspace, hits sort by level, then matched terms, then compaction time.

### Diary nudges

At level 1 or 0 the model sees the diary or the keywords — both written by the model itself. While either is empty it is asked to finish, in one of two places:

- **In context** (default): appended to the review text in the same message; once written the text changes, the message is replaced and the nudge disappears.
- **In the system prompt**: supplied as a trailing prompt section. Compliance differs between the two; pick the one that works for you.

### Injection and preview

- Reviews enter the context every turn, oldest first.
- The preview box on the Reviews tab runs the same assembly function as the real injection: what you see is what that turn receives (selecting one review shows only that one).
- If assembly fails (a review too large) it does not silently become no reviews; the model gets a diagnostic: how many, total size, the largest file, what to do.

### How it relates to sealing

In one line: reviews are the raw-material store for sealing. Across sessions and machines the model uses `session_tool_create_read` to find the original commands and arguments, then `session_tool_create_write` to seal them. You do not need to tune the review side — turn on Auto review and keep the defaults.

## Configuration

Stored in `$DSH_HOME/session-memory/_options.json`; changes apply immediately and are shared by all workspaces.

| Field | Values | Default | Meaning |
|---|---|---|---|
| `autoReviewEnabled` | bool | `false` | master switch: no reviews, no injection, no review tools when off |
| `injectEnabled` | bool | `true` | recall injection and diary nudges (does not cover the tool list) |
| `toolListEnabled` | bool | `true` | inject the toolSequence block and install/remove the three `session_tool_*` tools |
| `toolListRefresh` | `newSession` / `realtime` | `newSession` | when the list is recomputed |
| `fullLoad` | bool | `false` | keep tool calls and errors at level 3 (warned: full re-injection after every compaction) |
| `reminderChannel` | `context` / `system` | `context` | diary nudge inside the review text or as a prompt section |
| `stopLowering` | bool | `false` | every review keeps its recorded level; no daily decay |
| `loadLevel` | `follow` / 0–3 | `follow` | force a level at load time (does not change the recorded depth) |

Two couplings: with Auto review off, the effective `injectEnabled` is always false (the stored value is untouched); with Stop lowering on, Load level falls back to follow.

## Settings page

Settings → **Tool (script) manager**, four tabs:

| Tab | Contents |
|---|---|
| Sealed tools (shown as `toolList` in the English UI) | tool path, the prompt text about to be injected, "Inject toolSequence list" toggle and refresh mode, import / export |
| Sessions | sessions grouped by workspace (title, archived badge), Delete / Delete + review, both confirmed |
| Reviews | calendar range filter, review list with depth badges, injection preview, delete one review |
| Options | four groups: Sealed tools, Recall injection, Review content, Review depth |

## Data and backup

~~~
$DSH_HOME/session-memory/
    _options.json                 options
    _locale.json                  language (zh / en)
    _health.json                  last success/failure per workspace
    <workspace key>/
        <stamp>-<id>.md           review text (the single source of truth, plain text, readable and searchable)
        <same name>.json          load cache for that review (rebuilt from file time if lost)
        _assembly.json.migrated-*  leftover of the old single-file index (never auto-deleted)
    toolSequence/                 tool scripts (machine level, shared by all workspaces)
~~~

- The workspace key uses the same encoding as the host `sessions/` folders: `/` becomes `-`, non-ASCII becomes `~XXXX`.
- Backup: copy the whole `session-memory/`. Migration: put it at the same place on the new machine and install the same plugin.
- Uninstalling the plugin deletes no data.

## Compatibility and degradation

Missing host capabilities disable the matching block; everything else keeps working (the settings page lists what is missing):

| Missing | Effect |
|---|---|
| `systemPrompt.context` | recall injection off |
| `systemPrompt.section` | diary nudge section and toolSequence block do not appear |
| `tools.register` | none of the five tools is installed |
| `webServer.register` | the settings endpoints are not installed |
| `agents.create` / `resume` | only Delete live session / Delete + review are off |

Session logs are multi-frame zstd and are split by frame header before decoding; when `zlib.zstdDecompressSync` is absent the built-in decoder takes over, so Node 18 still reads titles.

## Known limitations

- Tool scripts have **no delete or edit in the UI**: delete by reinstalling (a `.bak-` is kept) or by removing the directory — the registry keeps the entry and later runs report that the directory is missing.
- `steps` do not chain automatically; use `calls` for a sequence.
- Reviews are created on compaction only; the Reviews tab has a calendar filter and no full-text search.
- Subagent sessions produce no reviews and no diary nudges.
- Import and export cover tool scripts only, not reviews; copy `session-memory/` for those.

## Development

~~~
index.js            plugin entry (exports name / apply / inject only)
cordis.patch.yml    inserts the plugin into the host loader
lib/core/           host-side logic: storage, decay, tool definitions, script runner
lib/host/           host service adapters: 12 HTTP endpoints, capability probe, session delete
lib/client.js       settings page (React, registered at settings.section)
~~~

- Zero runtime dependencies, ESM, Node `>=18`.
- Tests: `node --test test/*.test.mjs` (the test directory is not part of the published package).
- Packaging: `npm pack`; the publish whitelist is the `files` field of `package.json`.

## License

[MIT](./LICENSE) © dsh-seal-scripts contributors

Repository: <https://github.com/gosutry/dsh-seal-scripts> · Issues: <https://github.com/gosutry/dsh-seal-scripts/issues>
