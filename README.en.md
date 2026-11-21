# dsh-seal-scripts

[简体中文](./README.md) | **English**

> Seal the scripts that worked. Keep what compaction threw away.

[![version](https://img.shields.io/npm/v/dsh-seal-scripts?color=4a7cff)](https://www.npmjs.com/package/dsh-seal-scripts)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.2--rc.1%20%3C1.0.0-6f42c1)](https://github.com/deepseek-ai/dsh)
[![deps](https://img.shields.io/badge/runtime%20deps-0-brightgreen)](./package.json)

**Sealed scripts**: a chain that just worked is sealed into a tool script — a directory, a manifest entry, one line in the system prompt; next time it runs with a single sentence.

**Reviews**: when DSH compacts the context, the shadowed transcript is written to a review file, decays by calendar day and is injected back; the model can read the original from a clue. Reviews are also the raw material for sealing across sessions.

## Contents

- [Features](#sec-features)
- [Install](#sec-install)
- [Quick start](#sec-quickstart)
- [Sealed scripts](#sec-tools)
- [Session management](#sec-sessions)
- [Reviews](#sec-reviews)
- [Configuration and settings page](#sec-config)
- [Data and backup](#sec-data)
- [Compatibility and degradation](#sec-compat)
- [Known limitations](#sec-limits)
- [Development](#sec-dev)

<a name="sec-features"></a>

## Features

#### Sealed scripts

- **One chain → one tool script**: full script text, entry, args, steps, provenance, per-file sha256.
- **In the system prompt**: the toolSequence block lists every sealed tool, one line each.
- **Runs as written**: args as an argv array, never through a shell; interpreter chosen by the run field.
- **Verifiable**: sha256 compared before running; a hand-edited script is refused unless explicitly allowed.
- **Portable**: store-only zip; import previews first, index rebuilt from the files on disk.

#### Context reviews

- **Captured on compaction**: no model call; tool calls and arguments kept verbatim.
- **Four-level decay**: original → summary → diary → keywords; a read bumps and pins the level.
- **Cross-workspace search**: workspace → children → siblings → parents; outer rings need permission.
- **Diary nudges**: asked once when the diary or keywords are empty.

#### Engineering

- Zero runtime dependencies, Node built-ins only; UI and injected text follow DSH's 8 languages, model-facing errors and receipts are English.
- A missing host capability disables that block only.
- Plain-text data: copy `session-memory/` for a backup.

<a name="sec-install"></a>

## Install

Add the package in the plugin manager (package name, local path, tarball, or Git URL). `--profile` is required, e.g. `web`:

~~~bash
dsh plugin --profile web add dsh-seal-scripts
dsh plugin --profile web add /path/to/dsh-seal-scripts
~~~

The second line is a local directory, registered as a link dependency. Restart the profile to load it.

Requirements: host `@deepseek-ai/dsh` `>=0.2.2-rc.1`, `<1.0.0` (peer, not forced); Node `>=18`.

After the restart, Settings shows **Tool (script) manager**.

<a name="sec-quickstart"></a>

## Quick start

1. **Master switch**: Settings → Tool (script) manager → Options → turn on **Auto review** (off by default; nothing is created while off).
2. **Run a chain end to end**.
3. **Seal it**: ask the model to turn the steps above into a tool.
4. **Reuse it**: "run <id>"; add "show me the commands first, do not run" to preview.

~~~text
You: turn that packaging flow into a tool
Model: (session_tool_create_write) installed dsh-plugin-pack at .../toolSequence/dsh-plugin-pack
       entry pack.sh, params source_dir out_dir

(new session)
You: run dsh-plugin-pack, the source dir is /sdcard/Download/my-src
Model: (session_tool_call) exit 0, N files, sha256 matches the manifest
~~~

<a name="sec-tools"></a>

## Sealed scripts

#### Why this is not a note

A note cannot run, and rebuilding commands on the spot differs every time. What gets stored is the script itself: the lines that worked, byte for byte, argument order included.

#### How to trigger it

| What you say | What happens | When to use |
|---|---|---|
| turn the steps above into a tool | seals the steps that just ran | same session, commands still in context |
| turn the workflow from an earlier session into a tool | reads review originals first with `session_tool_create_read`, then seals | new session, new machine, old history |

The version that ran is stored, not a draft; editing after installing means re-sending the context.

#### What gets created

~~~
$DSH_HOME/session-memory/toolSequence/
    _index.json             registry: id, title, purpose, entry, args, steps, per-file sha256
    <id>/
        toolScript.json     manifest: full script text, docs, hashes, provenance
        <script>            the file that actually runs (.sh / .js .mjs .cjs / .ps1 / .bat .cmd)
        README.md           generated from the manifest
        <notes>.md          read-only notes (never executed)
    _runs/                  full stdout/stderr log of every run
    <id>.bak-<timestamp>/   previous directory kept on reinstall or import
~~~

#### How the model learns about it

The system prompt gains a toolSequence block, one line each: `· id (title): purpose｜entry <entry>｜args <p1> <p2>`. No entry or character cap; purpose shown in full.

| Mode | Behaviour | Cost |
|---|---|---|
| Before a new session (default) | computed at the first assembly, fixed until the session ends | installing or removing a tool mid-session leaves the prompt unchanged |
| Live per session | computed every turn | one cache miss on the next message |

Changing the mode refreshes every remembered session immediately.

#### The three tools

| Tool | Purpose | Key arguments |
|---|---|---|
| `session_tool_create_write` | seal a chain | `toolScript{ id, title, purpose, entry, scripts[], docs[], params, steps, timeoutMs }`; `replace` overwrites |
| `session_tool_create_read` | read review originals, read-only | `file` or `date`+`nth`; `mode` = outline / raw / block; `cursor`, `chars`, `line`, `span` |
| `session_tool_call` | run as written | `toolScript`, `step`, `args`, `stdin`, `cwd`, `dryRun`, `calls`, `stopOnError`, `allowDrift`, `timeoutMs`, `maxOutputBytes` |

- No arguments: lists every tool script.
- `dryRun: true`: echoes the arguments and cwd only.
- `calls: []`: runs in order, no count limit, reporting exit code, duration and logs per entry.

#### Validation when sealing

| Item | Rule |
|---|---|
| `id` | starts with a lowercase letter, only `a-z0-9-`, no length limit |
| file name | starts alphanumeric, letters, digits and . _ - only, no paths, no leading dot |
| `run` vs extension | bash→`.sh`; node→`.js/.mjs/.cjs`; ps1→`.ps1`; cmd→`.bat/.cmd` |
| size | no cap |
| `title` / `purpose` | non-empty; any length |
| `entry` / `steps` | must name files in `scripts`; entry defaults to the first |
| `timeoutMs` | any positive ms, clamped to the host maxTimeoutMs, defaults to the host timeoutMs |
| docs | must be `.md`, not `README.md`, no duplicates |
| script body | non-empty; must not contain `<!--ovr:` |
| same id exists | refused without `replace`; the error quotes the first 12 hex chars of the manifest sha256 |

`steps` only declares order and never chains; `params` only declares argv order and names are not validated.

#### Execution semantics

| Item | Value |
|---|---|
| interpreter | bash; node uses `process.execPath`; ps1 uses Windows PowerShell (`pwsh` elsewhere); cmd uses `%ComSpec% /d /c` (falls back to `sh` off Windows) |
| argv | interpreter args + absolute script path + args, as an array, never through a shell |
| cwd | `workspace`, `toolScript`, or an absolute path inside either |
| environment | inherits `process.env`, plus `TOOL_NAME`, `TOOL_SCRIPT`, `TOOL_ROOT`, `DSH_HOME` |
| timeout | follows the DSH terminal settings (120 s default, capped by maxTimeoutMs); on expiry it moves to the background and the reply carries pid and the log path; explicit stop: SIGTERM → 2 s → SIGKILL; process group on POSIX, `taskkill /T /F` on Windows |
| output | DSH maxOutputBytes; every run written to `_runs/` and the reply carries the file path |
| result | `{ exitCode, signal, timedOut, background, pid, logFile, stdout, stderr, truncated, spill }` |
| argument count | more than `params` declares fails before running; fewer is fine |
| drift | sha256 compared first; mismatch refuses, `allowDrift: true` allows it and marks `drift` |
| containment | only files inside the script directory run; unknown script names refused |

#### Import / export

- **Export**: Sealed tools tab → Export. Packs `toolSequence.zip` (store) into the session workspace and returns the path — no browser download.
- **Import**: pick a zip → `dryRun` preview → confirm to write; an existing directory is kept as `.bak-<timestamp>`.
- `_index.json` in the package is not trusted; the index is rebuilt from disk. `_runs`, backups, escaping paths and invalid ids are skipped.
- No size cap; the zip-bomb guard compares extracted bytes + 16 MB against free disk space. zip64 and encrypted archives are not supported.

#### Clear cache

Two clicks (the first only changes the button label):

- **Deleted**: `<id>.bak-<timestamp>` rollback directories, every log in `_runs/`.
- **Kept**: `_index.json` and every `<id>/` directory.
- Only "valid id + `.bak-` + digits" directories count; a staged import package is skipped.
- One entry that cannot be removed does not abort the run; the receipt reports counts and bytes.

<a name="sec-sessions"></a>

## Session management

The Sessions tab lists this machine's sessions grouped by workspace and manages each one: import a package, delete it, or delete it after producing a review.

#### The list

- **Grouped by workspace**: one block per workspace that has sessions, headed by the workspace path; empty workspaces take no space.
- **One row each**: the session title (the id in grey while a title does not exist yet), with an **Archived** badge when the session is archived.
- **Unreadable logs are named**: when a log cannot be decoded the list says so at the top instead of showing it as an empty session.

#### Import

- **One button**: the leftmost **Import** in the footer takes a `dsh-session-<id>.zip`; no hand-built directories. When the host cannot write zstd the button is disabled and says why.
- **Preview first**: the dry run says whether the id will be renamed and whether it hangs under that session as a branch; nothing is written until you confirm.
- **Openable immediately**: the log is packed the way DSH stores it (a one-line header frame plus a body frame) and then `attachSession` registers it; images and files land under the attachment store by sha256; the host is told the list gained a session, so the main window shows it at once, with no restart.
- **Collisions are not forced**: an id that already exists anywhere on this machine gets a new id and the original stays untouched; a same-workspace collision also hangs under that session as a branch (`parentSession`), another workspace gets a plain rename. A session that carries inherited history (`isSeeded:true`) records its real inherited count and still opens and branches.
- **Backed up first**: the workspace roster and projection cache are copied into `会话导入备份-<time>/` inside the target workspace before writing.

#### Delete

- **Two taps**: the first tap only turns the button into Confirm; the second deletes.
- **Live sessions are closed first**: cancel → wait idle → flush → release the write handle, then remove the directory; if it cannot be closed, the delete is refused and the log is kept.
- **Removed from the list**: the directory is deleted and the session is detached from its workspace, so it leaves the list at once.
- **Leftovers are reported**: when the engine still holds a reference, the receipt says so ("it may be remembered until restart") instead of pretending it is clean.

#### Delete + review

- **Review first, then delete**: compact, wait for the review to be split out, validate, and only then delete.
- **No delete on failure**: any failing step keeps the session; the worst case is "compaction succeeded, split failed, session still there", and that compaction is irreversible.
- **Log**: each failing step writes a line to `session-memory/_compact-delete.log`, otherwise only one English error remains.
- **Result**: the review it produces shows up on the Reviews tab and decays by calendar day.

<a name="sec-reviews"></a>

## Reviews and context memory

The shadowed transcript is kept as a file and can be read back when it matters.

#### When a review is created

- Only on **compaction**: written as one review file (summary + original + empty diary).
- Tool calls and arguments are kept verbatim, never truncated.
- Spawned subagent sessions produce nothing; with Auto review off, not even detection happens.
- Delete + review triggers one on purpose: compact → confirm the review landed → delete. Any failed step aborts.
- Compaction runs through the host command registry: the service is mounted per agent preset and isolated, so the plugin root never calls it — `/compact` is executed by the command handler.
- Once compaction ends, the plugin reads the newest `compaction/summary` and splits the review.
- Every failed step is logged to `session-memory/_compact-delete.log` (trimmed to its last 64 KB past 256 KB).

#### Four levels

| Day | Level | What the model sees |
|---|---|---|
| the day of compaction | 3 | the original dialogue (tool calls and errors filtered) |
| day 2 | 2 | the compaction summary |
| days 3–28 | 1 | the diary |
| day 29 and later | 0 | keywords plus the file name |

Local calendar days. Only reading this workspace's own review bumps and pins the level (0→1, 1→2) and stops decay; child, sibling and parent reviews are read-only.

#### Cross-workspace search

The unit is a workspace review folder. Order: this workspace → children → siblings → the parent → the parent's siblings → their level-1 and level-2 children. Outer rings need `allowOuter`.

Hits go keywords first, then summary, then original; within a workspace they sort by level, matched terms, then compaction time.

#### Diary nudges

At level 1 or 0, an empty diary or empty keywords trigger one nudge:

- **In context** (default): appended to the review text, disappears once written.
- **In the system prompt**: a trailing prompt section.

#### Injection and preview

- Reviews enter the context every turn, oldest first.
- The preview box runs the same assembly function as the real injection (selecting one review shows only that one).
- A failed assembly gives the model a diagnostic (how many, total size, largest file) instead of silently showing no reviews.

#### The two review tools

Installed only while Auto review is on.

| Tool | Purpose | Key arguments |
|---|---|---|
| `session_mem_read` | find a review from a clue, one hit per call | `need` (required), `skip`, `allowOuter` |
| `session_mem_write` | read one original; write keywords and diary, in batch | `file` or `date`+`nth`; `keywords`, `diary`; `writes[]` |

- Locator only = the Original section: dialogue only, tool calls stripped.
- Writing many uses `writes[]`; all-or-nothing.
- Neither tool changes depth.

#### How it relates to sealing

Reviews are the raw-material store: the model uses `session_tool_create_read` to recover commands and arguments, then `session_tool_create_write` to seal them.

<a name="sec-config"></a>

## Configuration and settings page

There is one config file, `$DSH_HOME/session-memory/_options.json`; changes apply immediately and are shared by all workspaces. Settings → **Tool (script) manager** → **Options** edits the same file.

#### The four tabs

| Tab | Contents |
|---|---|
| Sealed tools (`toolList` in the English UI) | tool path, the injected prompt text, list toggle and refresh mode, import / export / clear cache |
| Sessions | sessions grouped by workspace; Delete, Delete + review (both confirmed) |
| Reviews | calendar filter, review list with depth badges, injection preview, delete one |
| Options | four groups: Sealed tools, Recall injection, Review content, Review depth |

#### Every option field

| Field | Values | Default | Meaning |
|---|---|---|---|
| `autoReviewEnabled` | bool | `false` | master switch: no reviews, no injection, no review tools when off |
| `injectEnabled` | bool | `true` | recall injection and diary nudges (not the tool list) |
| `toolListEnabled` | bool | `true` | inject the toolSequence block and install/remove the three `session_tool_*` tools |
| `toolListRefresh` | `newSession` / `realtime` | `newSession` | when the list is recomputed |
| `fullLoad` | bool | `false` | keep tool calls and errors at level 3 (full re-injection) |
| `reminderChannel` | `context` / `system` | `context` | where the diary nudge goes |
| `stopLowering` | bool | `false` | reviews keep their recorded level, no daily decay |
| `loadLevel` | `follow` / 0–3 | `follow` | force a level at load time (recorded depth unchanged) |

Two couplings: with Auto review off, `injectEnabled` reads as off (the stored value is untouched); with Stop lowering on, Load level falls back to follow.

#### UI language

Follows DSH: settings strings, injected review text, diary reminders and the toolSequence block all switch. A review file is written with the header and section titles of the language active **at capture time**; switching later only changes the display (all 8 spellings are accepted). Errors and receipts the tools return to the model are English.

<a name="sec-data"></a>

## Data and backup

~~~
$DSH_HOME/session-memory/
    _options.json                 options
    _locale.json                  language
    _health.json                  last success/failure per workspace
    _compact-delete.log           per-step diagnostics (trimmed past 256 KB)
    <workspace key>/
        <stamp>-<id>.md           review text (plain text, readable and searchable)
        <same name>.json          load cache (rebuilt from file time if lost)
        _assembly.json.migrated-*  leftover of the old index (never auto-deleted)
    toolSequence/                 tool scripts (machine level, shared)
~~~

- The workspace key uses the host `sessions/` encoding: `/` becomes `-`, non-ASCII becomes `~XXXX`.
- Backup: copy the whole `session-memory/`. Migration: put it at the same place on the new machine and install the same plugin.
- Uninstalling deletes no data.

<a name="sec-compat"></a>

## Compatibility and degradation

Missing host capabilities disable the matching block only (the settings page lists what is missing):

| Missing | Effect |
|---|---|
| `systemPrompt.context` | recall injection off |
| `systemPrompt.section` | diary nudge section and toolSequence block do not appear |
| `tools.register` | none of the five tools is installed |
| `webServer.register` | settings endpoints not installed |
| `agents.create` / `resume` | deleting a live session falls back to tier 2 (plugin-built teardown) |
| `commands.execute`, or `command-compact` not mounted | Delete + review is unavailable; plain delete still works |

Two tiers for deleting a live session: (1) the `dispose` returned by `agents.create` / `resume`, captured by the lifecycle hook; (2) no handle — the plugin builds its own `cancel({kind:'disposed'})` → `whenIdle()` → `scope.dispose()`. Tier 2 only stops the agent; unregistering belongs to the host closure with no public API, so the delete succeeds with a `warnings` entry (the settings page says the engine may still remember it until restart).

Session logs are multi-frame zstd, split by frame header; without native `zlib.zstdDecompressSync` the built-in decoder takes over.

<a name="sec-limits"></a>

## Known limitations

- Tool scripts have **no delete or edit in the UI**: reinstall to overwrite (a `.bak-` is kept) or remove the directory (the registry keeps the entry and later runs report a missing directory).
- `steps` never chain automatically; use `calls`.
- Reviews are created on compaction only; the Reviews tab has no full-text search.
- Subagent sessions produce no reviews and no diary nudges.
- Import and export cover tool scripts only; copy `session-memory/` for reviews.
- Delete + review needs `command-compact` mounted on that session's preset.
- With the plugin-built teardown, the engine may still remember the session until it restarts.

<a name="sec-dev"></a>

## Development

~~~
index.js            plugin entry (exports name / apply / inject)
cordis.patch.yml    inserts the plugin into the host loader
lib/core/           host-side logic: storage, decay, tool definitions, script runner
lib/host/           host service adapters: 12 HTTP endpoints, capability probe, session delete
lib/client.js       settings page (React, registered at settings.section)
~~~

- Zero runtime dependencies, ESM, Node `>=18`.
- Tests `node --test test/*.test.mjs` (not shipped in the package).
- Packaging `npm pack`; whitelist is the `files` field of `package.json`.

## License

[MIT](./LICENSE) © dsh-seal-scripts contributors

Repository: <https://github.com/gosutry/dsh-seal-scripts> · Issues: <https://github.com/gosutry/dsh-seal-scripts/issues>
