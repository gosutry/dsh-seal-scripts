# dsh-seal-scripts

[简体中文](./README.md) | **English**

> Seal a proven CLI chain into a tool script with a contract, replayable as written, with the session's actual call history as raw material.

[![version](https://img.shields.io/npm/v/dsh-seal-scripts?color=4a7cff)](https://www.npmjs.com/package/dsh-seal-scripts)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1%20%3C1.0.0-6f42c1)](https://github.com/deepseek-ai/dsh)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](./package.json)

## Contents

- [CLI solidification](#sec-class)
- [Install](#sec-install)
- [Quick start](#sec-quickstart)
- [Sealing](#sec-tools)
- [Reviews](#sec-reviews)
- [Session management](#sec-sessions)
- [Configuration](#sec-config)
- [Data and backup](#sec-data)
- [Compatibility](#sec-compat)
- [Known limitations](#sec-limits)
- [Development](#sec-dev)

<a name="sec-class"></a>

## CLI solidification

The binary sits on the machine, but **how to call it is composed by the model every time**; composed correctly, it is still correct only once. Solidifying means storing that run together with its contract, as a tool you can call again:

| Sealed | Where it lives | Effect on replay |
|---|---|---|
| Command text | `scripts[].content` + per-file sha256 | Byte-for-byte replay; hand edits rejected before running |
| Argument contract | `params` (argv order) + arity check | Extra arguments fail before running; fewer are allowed |
| Interpreter | `run` (bash / node / ps1 / cmd) | No environment guessing |
| Working directory | `cwd`: `workspace` / `toolScript` / inside either | No forgotten `cd`; paths outside are rejected |
| Runtime bounds | `timeoutMs`, output cap, timeout to background | Long jobs do not stall the chat; logs in `_runs/` |
| Provenance | `provenance`, hashes in `toolScript.json` | Knows which conversation it came from and whether it changed |

Four steps:

```text
1 run it      the model uses the CLI normally (ffmpeg / gh / git / its own script)
2 seal it     session_tool_create_write  ->  toolSequence/<id>/ dir + manifest + sha256
3 announce    the tool-group list at the end of the system prompt:
              id (title): purpose | entry | params
4 replay      session_tool_call{toolScript:"<id>", args:[...]}  ->  same argv, exit code reported
```

How it differs from typing the command:

- Script text is checked by sha256; hand edits are rejected (`allowDrift` overrides).
- argv array, never a shell; more args than `params` declares fails before running.
- Interpreter and cwd are fixed; only files inside the tool directory run, unknown script names rejected.
- A non-zero exit code fails the tool call; no fake success.
- The tool list stays in the system prompt; the whole set travels as a zip with an import preview.

<a name="sec-install"></a>

## Install

Add the package through the plugin manager (package name, local path, tarball or Git). `--profile` is required, e.g. `web`:

```bash
dsh plugin --profile web add dsh-seal-scripts          # latest from the registry
dsh plugin --profile web add dsh-seal-scripts@0.6.1    # pin a version
dsh plugin --profile web add /path/to/dsh-seal-scripts # local dir, linked dependency
```

`dsh plugin` forwards its arguments to pnpm inside the profile directory, so the npm route works too:

```bash
npm i dsh-seal-scripts            # install into the current Node environment
npx dsh plugin --profile web add dsh-seal-scripts
```

`npm i` alone only fills `node_modules`; it does not register the plugin into a profile — the command above (or the plugin manager) does that by package name.

Reload the profile after installing.

Requires host `@deepseek-ai/dsh` `>=0.2.2-rc.1`, `<1.0.0` (peer, optional) and Node `>=18`.

A **Tool (script) manager** section appearing in settings means it loaded.

<a name="sec-quickstart"></a>

## Quick start

1. Settings → Tool (script) manager → Options → enable "Automatic review" (off by default).
2. Run a command chain until it works.
3. Say "turn the above into a tool"; the model calls `session_tool_create_write`.
4. Say "run <id>"; add "show the command first, don't run it" for a `dryRun`.

```text
You:    turn that packaging flow into a tool
Model:  (session_tool_create_write) installed dsh-plugin-pack at …/toolSequence/dsh-plugin-pack
        entry pack.sh, params source_dir out_dir

(new session)
You:    run dsh-plugin-pack on /sdcard/Download/my-src
Model:  (session_tool_call) exit 0, N files, sha256 matches the manifest
```

<a name="sec-tools"></a>

## Sealing

#### Triggers

| You say | It does | Good for |
|---|---|---|
| Turn the above into a tool | Seals the steps that just ran | Same session, commands still in context |
| Turn that older session into a tool | Reads the review text via `session_tool_create_read`, then seals | New session, new machine |

The sealed copy is the one that ran, not a draft. Editing afterwards means resending the context (or `replace`).

#### Layout

```text
$DSH_HOME/session-memory/toolSequence/
    _index.json             catalog: id, title, purpose, entry, params, steps, per-file sha256
    <id>/
        toolScript.json     manifest: script text, docs, hashes, provenance
        <script>            the executed file (.sh / .js .mjs .cjs / .ps1 / .bat .cmd)
        README.md           generated from the manifest
        <notes>.md          read-only notes (never executed)
    _runs/                  full stdout/stderr per run
    <id>.bak-<ts>/          kept on replace / import
```

#### System-prompt injection

A "tool group" section is appended to the system prompt, one line per tool: `id (title): purpose | entry | params`. No count or length cap; the whole purpose text is used.

| Mode | Behaviour | Cost |
|---|---|---|
| Before a new session (default) | Computed once on first assembly, fixed for the session | Installing/removing mid-session leaves the prompt unchanged |
| Realtime | Recomputed every turn | One cache miss after each change |

Switching modes refreshes every remembered session immediately.

#### Tools

| Tool | Purpose | Key arguments |
|---|---|---|
| `session_tool_create_write` | Seal a chain | `toolScript{ id, title, purpose, entry, scripts[], docs[], params, steps, timeoutMs }`; `replace` |
| `session_tool_create_read` | Read review source text | `file` or `date`+`nth`; `mode` = outline / raw / block; `cursor`, `chars`, `line`, `span` |
| `session_tool_call` | Replay as written | `toolScript`, `step`, `args`, `stdin`, `cwd`, `dryRun`, `calls`, `stopOnError`, `allowDrift`, `timeoutMs`, `maxOutputBytes` |

- No arguments: list all tool scripts.
- `dryRun: true`: echo argv and cwd only.
- `calls: []`: run in order, unlimited entries, per-entry exit code, duration and log.

#### Seal-time validation

| Item | Rule |
|---|---|
| `id` | Starts with a lowercase letter, `a-z0-9-` only, no length limit |
| File names | Start alphanumeric; letters, digits, `. _ -` only; no paths, no leading dot |
| `run` vs extension | bash→`.sh`; node→`.js/.mjs/.cjs`; ps1→`.ps1`; cmd→`.bat/.cmd` |
| Size | No limit |
| `title` / `purpose` | Non-empty; purpose unlimited |
| `entry` / `steps` | Must name files in `scripts`; entry defaults to the first |
| `timeoutMs` | Positive ms; clamped to the host maxTimeoutMs at run time |
| Notes | Must be `.md`, not `README.md`, no duplicates |
| Body | Non-empty; must not contain `<!--ovr:` |
| Existing name | Rejected without `replace`, returning the first 12 chars of the manifest sha256 |

`steps` declares order only (no auto chaining); `params` declares argv order only (names unvalidated).

#### Execution

| Item | Value |
|---|---|
| Interpreter | bash; node via `process.execPath`; ps1 via Windows PowerShell (else `pwsh`); cmd via `%ComSpec% /d /c` (else `sh`) |
| argv | Interpreter flags + absolute script path + args, array form, never a shell |
| cwd | `workspace`, `toolScript`, or an absolute path inside either |
| Env | Inherits `process.env` plus `TOOL_NAME`, `TOOL_SCRIPT`, `TOOL_ROOT`, `DSH_HOME` |
| Timeout | Follows the DSH terminal settings (120 s default, maxTimeoutMs cap); on expiry the run moves to the background with pid and log path; stop = SIGTERM then SIGKILL after 2 s; process group on POSIX, `taskkill /T /F` on Windows |
| Output | DSH maxOutputBytes by default; every run is written to `_runs/` and the result carries the path |
| Return | `{ exitCode, signal, timedOut, background, pid, logFile, stdout, stderr, truncated, spill }` |
| Arity | More args than `params` fails before running; fewer is allowed |
| Drift | sha256 compared before running; mismatch rejected unless `allowDrift: true` (marked `drift`) |
| Scope | Only files inside the tool directory; unknown script names rejected |

#### Import / export

- **Export**: Tools tab → Export, packed as `toolSequence.zip` (store) into the current workspace, returning the path (no browser download).
- **Import**: pick a zip → `dryRun` preview → confirm; same-name directories kept as `.bak-<ts>`.
- The archive's `_index.json` is ignored; the index is rebuilt from landed files. `_runs`, backups, out-of-scope paths and invalid ids are skipped.
- No size limit; zip bombs are judged by "unpacked bytes + 16 MB vs free disk". No zip64, no encryption.

#### Clearing caches

Two clicks (the first only changes the button label):

- **Deletes**: `<id>.bak-<ts>` rollback directories and all `_runs/` logs.
- **Keeps**: `_index.json` and every `<id>/` directory.
- Only "valid id + `.bak-` + digits" directories; in-progress import temp dirs are skipped.
- One failure does not abort the sweep; the result reports counts and bytes.

<a name="sec-reviews"></a>

## Reviews

Reviews are the raw material for sealing: when a session is compacted, **tool calls and their arguments are persisted verbatim**, so the model can later recover the exact chain and seal it with `session_tool_create_write`. Without reviews, sealing can only happen inside a single session.

- Produced only on **compaction**: summary + original text + empty diary; tool calls and arguments kept verbatim.
- Not produced for subagent sessions; nothing is even checked while "Automatic review" is off.
- "Delete and review" triggers the chain explicitly; the session is deleted only after the review lands.
- Compaction runs through the host command table (`/compact` by the command handler); the latest `compaction/summary` is split into a review.
- Every failed step is logged to `session-memory/_compact-delete.log` (last 64 KB kept past 256 KB).

#### Four levels

| When | Level | Model sees |
|---|---|---|
| Compaction day | 3 | Original dialogue (tool calls and errors filtered) |
| Day 2 | 2 | Compaction summary |
| Day 3–28 | 1 | Diary |
| From day 29 | 0 | Keywords + file name |

Calendar days, local time. Only this workspace's own review, when read out, gains a level and locks (0→1, 1→2); child, sibling and parent workspaces are read-only and do not count.

#### Search scope

Order: this workspace → children → siblings → parent → parent's siblings → their 1–2 levels of children. Outer rings require `allowOuter`.

Match order: keywords, then summary, then original text; within a workspace by level, hit count, compaction time.

#### Reminders

At level 1 or 0, an empty diary or keyword set triggers one reminder: inline in the review body by default (it disappears once written), or as a system-prompt section.

#### Injection and preview

- Reviews are injected each turn, oldest first.
- The settings preview uses the same assembly function as real injection.
- Assembly failure yields a diagnostic (how many, how large, which is largest), never "no reviews".

#### Review tools

Installed only when "Automatic review" is on.

| Tool | Purpose | Key arguments |
|---|---|---|
| `session_mem_read` | Find a review by clue, one per call | `need` (required), `skip`, `allowOuter` |
| `session_mem_write` | Read one review's original text; write keywords and diary, batched | `file` or `date`+`nth`; `keywords`, `diary`; `writes[]` |

- Locator without content = read the "original" section: dialogue only, tool calls stripped.
- Batch via `writes[]`: all entries must validate before anything is written.
- Neither tool changes a review's level.

<a name="sec-sessions"></a>

## Session management

The Sessions tab lists local sessions grouped by workspace, reading persisted logs.

- Each group header is a workspace path; empty workspaces are omitted.
- One row per session: title (id placeholder in grey when not yet known), "Archived" badge when applicable.
- Unreadable logs are reported at the top instead of being shown as empty sessions.

#### Import

- "Import" at the far left of the footer; pick `dsh-session-<id>.zip`. Disabled with a reason when the host cannot write zstd.
- Dry run first (new id? branch?), write only after confirmation.
- Log becomes "header frame + body frame", then `attachSession`; images and files land in the attachment store by sha256; the host list is notified, no restart needed.
- A colliding id gets a new id, the original untouched; collisions inside the same workspace attach as a branch (`parentSession`).
- `workspace.json` and the directory registry are backed up into `会话导入备份-<time>/` before writing.

#### Delete

- Two-click confirmation.
- Live sessions are cancelled → idled → flushed → disposed before the directory is removed; refusal keeps the logs.
- The workspace entry is removed too, so the row disappears.
- If the engine still holds a reference the result says "may still remember it until restart".

#### Delete and review

- Compress into a review, wait for extraction, verify, then delete; any failure keeps the session.
- Every failed step is logged to `session-memory/_compact-delete.log`.
- The review appears on the Reviews tab and decays by calendar day.

<a name="sec-config"></a>

## Configuration

There is one config file, `$DSH_HOME/session-memory/_options.json`, shared by all workspaces and applied immediately. Settings → **Tool (script) manager** → **Options** edits the same file.

| Tab | Contents |
|---|---|
| Tools | Tool path, injected prompt text, list switch and refresh mode, import / export / clear cache |
| Sessions | Sessions grouped by workspace; import, delete, delete-and-review (both confirmed) |
| Reviews | Calendar filter, review list with level badges, injection preview, delete one |
| Options | Four groups: sealing, review injection, review content, review depth |

| Field | Values | Default | Meaning |
|---|---|---|---|
| `autoReviewEnabled` | bool | `false` | Master switch: no reviews, no injection, no review tools when off |
| `injectEnabled` | bool | `true` | Review injection and diary reminders (not the tool list) |
| `toolListEnabled` | bool | `true` | Inject the tool list and install the three `session_tool_*` tools |
| `toolListRefresh` | `newSession` / `realtime` | `newSession` | When the list is recomputed |
| `fullLoad` | bool | `false` | Keep tool calls and errors at level 3 (reloads everything) |
| `reminderChannel` | `context` / `system` | `context` | Where diary reminders appear |
| `stopLowering` | bool | `false` | Reviews keep their recorded level and stop decaying |
| `loadLevel` | `follow` / 0–3 | `follow` | Force a level at load time (does not change the recorded level) |

Two interactions: with automatic review off, review injection counts as off (the stored value is kept); with "stop lowering" on, the load level falls back to follow.

#### Language

UI text, injected review bodies, diary reminders and the tool list follow the DSH language setting. Review files record their headers in the language current **when written**; switching language only changes display (all 8 variants are recognised). Tool errors and receipts returned to the model are English.

<a name="sec-data"></a>

## Data and backup

```text
$DSH_HOME/session-memory/
    _options.json                 options
    _locale.json                  language
    _health.json                  last success/failure per workspace
    _compact-delete.log           compaction and delete-and-review diagnostics (>256 KB truncated)
    <workspace key>/
        <ts>-<id>.md              review body (plain text, readable and editable)
        <same>.json               load cache (rebuilt from file times if lost)
        _assembly.json.migrated-* legacy index leftovers (never deleted automatically)
    toolSequence/                 tool scripts (machine-wide, shared by all workspaces)
```

- Workspace keys use the host's `sessions/` encoding: `/` becomes `-`, non-ASCII as `~XXXX`.
- Backup = copy the whole `session-memory/`; migrate = same path on the new machine plus the same plugin.
- Uninstalling does not delete data.

<a name="sec-compat"></a>

## Compatibility

Missing host capabilities disable the matching part only (the settings page lists what is missing):

| Missing | Effect |
|---|---|
| `systemPrompt.context` | Review injection off |
| `systemPrompt.section` | No diary-reminder or tool-list section |
| `tools.register` | None of the five tools is installed |
| `webServer.register` | No settings API |
| `agents.create` / `resume` | Deleting a live session drops to fallback teardown |
| `commands.execute` or no `command-compact` in the preset | Delete-and-review unavailable; plain delete works |

Deleting a live session has two paths: ① the `dispose` returned by `agents.create` / `resume`, captured by the lifecycle; ② without a handle, a synthetic `cancel({kind:'disposed'})` → `whenIdle()` → `scope.dispose()`. Path ② can stop the agent but cannot unregister it from the host closure, so the delete succeeds with `warnings` ("deleted (may be remembered until engine restart)").

Session logs are multi-frame zstd, decoded frame by frame; the built-in decoder is used when `zlib.zstdDecompressSync` is unavailable. Importing sessions needs host zstd compression: without `zstdCompress` the Import button is disabled with a reason.

<a name="sec-limits"></a>

## Known limitations

- Tool scripts have **no UI for delete or edit**: replace them (keeping `.bak-`) or remove the directory by hand (the index keeps the entry and runs fail with "directory not found").
- `steps` never chain automatically; use `calls`.
- Reviews are produced only on compaction; the Reviews tab has a calendar filter but no full-text search.
- Subagent sessions produce no reviews and get no diary reminders.
- Import/export covers tool scripts only; reviews travel by copying `session-memory/`. Session zips are a separate import on the Sessions tab.
- Delete-and-review requires the preset to provide `command-compact`.
- Fallback teardown may leave the session remembered until the engine restarts.
- A freshly imported cold session shows `Untitled` in the sidebar until the host's title projection loads.

<a name="sec-dev"></a>

## Development

```text
index.js            plugin entry (exports name / apply / inject)
cordis.patch.yml    inserts the plugin into the host loader
lib/core/           host-side logic: persistence, decay, tool definitions, script runner
lib/host/           host service adapters: HTTP endpoints, capability probing, session import/delete
lib/client.js       settings UI (React, registered into settings.section)
```

- Zero runtime dependencies, ESM, Node `>=18`.
- Tests: `node --test test/*.test.mjs` (not shipped).
- Package: `npm pack`, whitelist in `package.json` `files`.

## License

[MIT](./LICENSE) © dsh-seal-scripts contributors

Repository: <https://github.com/gosutry/dsh-seal-scripts> · Issues: <https://github.com/gosutry/dsh-seal-scripts/issues>
