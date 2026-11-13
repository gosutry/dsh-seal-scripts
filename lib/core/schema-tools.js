/**
 * 两个新工具（0.3.0）：
 *
 * session_tool_create_read   回读回顾文件的「原文」区——含 ▸ 工具调用与 ◂ 结果，一个字节都不少——
 *                        三档读：骨架（去重）/ 分页（整段）/ 单块（一条调用连同它的结果）；
 *                        带 toolScript 参数就写盘：把一条链固化成一整套工具脚本，装上工具组。
 * session_tool_call      直接跑工具组里的工具脚本：一条或连着几条，顺序执行，逐条报退出码与输出。
 *
 * 定位复用 session_mem_write 那一套（file，或 date + nth），读原文不剥工具调用
 * （session_mem_write 的窄读仍然只给对话，0.2.7 的取舍不动）。
 */

import fsp from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { resolveMemoryFile, resolveMemoryByDay, estimateTokens } from './tool.js'
import { parseMemory } from './memory-file.js'
import { MARK } from './render.js'
import {
  installToolScript, listToolScripts, loadToolScript, catalogText, assertToolScriptId, resolveInside,
  toolSequenceRoot, TOOL_SCRIPT_FILE, sha256OfFile
} from './schema.js'
import { runScript, normalizeTimeout, normalizeMaxOutput, interpreterOf } from './schema-runner.js'
import { readHostLimits, describeHostLimits } from './host-limits.js'

/**
 * 把返回值收成「能无损过 JSON」的形态（0.4.11 修正）。
 *
 * 宿主要求工具返回值是 lossless JSON：对象里带一个 undefined 就会整次调用失败
 * （实测报错 "value is not lossless JSON"）——正常跑完的那条 runs[i].pid 就是 undefined。
 * 这里递归丢掉 undefined，其它值原样保留（null 保留，它和「没有这个字段」语义不同）。
 * @param {unknown} value
 * @returns {unknown}
 */
export function jsonSafe(value) {
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item))
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue
      out[key] = jsonSafe(item)
    }
    return out
  }
  return value
}

export const TOOL_CREATE_READ_NAME = 'session_tool_create_read'
export const TOOL_CREATE_WRITE_NAME = 'session_tool_create_write'
export const TOOL_CALL_TOOL_NAME = 'session_tool_call'

/** 原文里 ▸ 块的状态行前缀：render.js 写死了「报错：」。 */
const ERROR_PREFIX = MARK.result + '报错'

/* ────────────────────────── 读：原文 ────────────────────────── */

/**
 * 读一份回顾的原文区（含工具调用）。
 * @returns {Promise<{file:string, path:string, body:string, summary:string, meta:object}>}
 */
export async function readBodyOf({ dshHome, cwd, file }) {
  const abs = resolveMemoryFile(dshHome, cwd, file)
  const text = await fsp.readFile(abs, 'utf8')
  const parsed = parseMemory(text)
  if (!parsed.id) throw new Error('this file has no review section markers, so it is not a review file: ' + file)
  return {
    file: path.basename(abs),
    path: abs,
    body: parsed.sections.body ?? '',
    summary: parsed.sections.sum ?? '',
    meta: parsed.meta ?? {}
  }
}

/** 定位：file 或 date(+nth)。两个工具共用。 */
export async function locateMemory(args, { dshHome, cwd }) {
  const hasFile = typeof args.file === 'string' && args.file.trim() !== ''
  const hasDate = args.date !== undefined
  if (!hasFile && !hasDate) {
    throw new Error('pass either file (a review file name) or date (YYYY-MM-DD, first review by default) to locate a review')
  }
  if (hasFile && hasDate) throw new Error('file and date are mutually exclusive')
  if (hasFile) return String(args.file).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.date).trim())) {
    throw new Error('date must be YYYY-MM-DD (local date): ' + String(args.date))
  }
  return resolveMemoryByDay({
    dshHome, cwd,
    date: String(args.date).trim(),
    nth: args.nth === undefined ? 1 : args.nth
  })
}

/**
 * 把原文切成「块」：一次 ▸ 调用 + 紧跟着的缩进行 + 配对的 ◂ 状态。
 *
 * 两个必须承认的事实（render.js 的写法决定的，不是偷懒）：
 *
 *   1. ◂ 状态行在结果正文「之后」——render.js 先写结果正文，再写「◂ 完成 / ◂ 报错：…」。
 *      所以一条调用的输出，落在它的 ◂ 之前，而不是之后。
 *   2. 同一条模型消息里的多个调用先连着写（参数各占一段缩进），结果再按同样顺序出场；
 *      于是第 2 条调用后面的缩进段，可能是第 1 条调用的输出。**文本层面分不开**，
 *      这里不做猜测：块内保留「发起 + 紧随的缩进段」，另把 ◂ 之前那一段记作结果区，
 *      重叠时也照记，宁可多给一段，不伪造配对。
 *
 * 配对只认先进先出：第一个 ◂ 配第一个还没结果的 ▸。
 * @param {string} body
 * @returns {Array<object>}
 */
export function parseBlocks(body) {
  const lines = String(body ?? '').split('\n')
  const blocks = []
  const pending = []
  let cur = null
  let run = []            // 自上一个结构行以来的缩进行（去掉两格前缀）
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith(MARK.call)) {
      const text = line.slice(MARK.call.length)
      const at = text.indexOf(': ')
      const name = (at === -1 ? text : text.slice(0, at)).trim()
      const firstArg = at === -1 ? '' : text.slice(at + 2).trim()
      cur = {
        line: i + 1, endLine: i + 1, name, firstArg,
        argLines: [], status: '', failed: false,
        resultText: [], resultLine: null
      }
      blocks.push(cur)
      pending.push(cur)
      run = []
      continue
    }
    if (line.startsWith(MARK.result)) {
      const target = pending.shift() ?? null
      if (target) {
        target.status = line.slice(MARK.result.length).trim()
        target.failed = line.startsWith(ERROR_PREFIX)
        target.resultText = run.slice()
        target.resultLine = i + 1
        target.endLine = i + 1
      }
      cur = null
      run = []
      continue
    }
    if (line.startsWith(MARK.user) || line.startsWith(MARK.model)) {
      cur = null
      run = []
      continue
    }
    if (line.startsWith('  ') || line.trim() === '') {
      if (line.trim() !== '') {
        const clean = line.replace(/^  /, '')
        run.push(clean)
        if (cur) {
          cur.argLines.push(clean)
          cur.endLine = i + 1
        }
      }
      continue
    }
  }
  return blocks
}

/**
 * 骨架：按「工具名 + 第一个参数行」去重，给行号与成败。
 * 一份 1 MB 的回顾实测 468 次调用 → 去重后 288 条，够模型看出跑过哪些活。
 * 0.4.11：默认不再截到 400 条（那是个纯数值天花板），要看多少给多少；
 * 显式 maxItems 才限制。
 * @param {Array<object>} blocks
 * @param {{maxItems?:number}} options
 * @returns {{calls:number, failures:number, distinct:number, groups:Array<object>}}
 */
export function outlineOf(blocks, { maxItems = Infinity } = {}) {
  const groups = new Map()
  for (const b of blocks) {
    const key = b.name + '|' + b.firstArg.slice(0, 120)
    let g = groups.get(b.name)
    if (!g) { g = { tool: b.name, count: 0, failed: 0, items: new Map() }; groups.set(b.name, g) }
    g.count++
    if (b.failed) g.failed++
    const item = g.items.get(key)
    if (item) {
      item.count++
      if (b.failed) item.failed++
    } else {
      g.items.set(key, {
        line: b.line,
        firstArg: b.firstArg.length > 160 ? b.firstArg.slice(0, 158) + '…' : b.firstArg,
        failed: b.failed,
        count: 1
      })
    }
  }
  const out = []
  let printed = 0
  let distinct = 0
  for (const g of [...groups.values()].sort((a, b) => b.count - a.count)) {
    const items = [...g.items.values()].sort((a, b) => a.line - b.line)
    distinct += items.length
    const room = maxItems === Infinity ? items.length : Math.max(0, maxItems - printed)
    const shown = items.slice(0, room)
    printed += shown.length
    out.push({
      tool: g.tool,
      count: g.count,
      failed: g.failed,
      distinct: items.length,
      shown: shown.length,
      omitted: items.length - shown.length,
      items: shown
    })
  }
  return {
    calls: blocks.length,
    failures: blocks.filter((b) => b.failed).length,
    distinct,
    groups: out
  }
}

/** 骨架渲染成人读得懂的几段文字。 */
export function renderOutline({ file, body, outline, filePath }) {
  const lines = []
  lines.push('Original outline · ' + file + ' (' + filePath + ')')
  lines.push('Body ' + Buffer.byteLength(body, 'utf8') + ' bytes / ' + body.split('\n').length + ' lines' +
    '; ' + outline.calls + ' tool calls (' + outline.failures + ' failed); ' + outline.distinct + ' distinct after dedup')
  lines.push('')
  for (const g of outline.groups) {
    lines.push('▸ ' + g.tool + ' · ' + g.count + ' calls' + (g.failed > 0 ? ' (' + g.failed + ' failed)' : '') +
      ' · ' + g.distinct + ' distinct' + (g.omitted > 0 ? ' (showing ' + g.shown + ', the rest omitted)' : ''))
    for (const it of g.items) {
      lines.push('  L' + it.line + (it.failed ? ' [failed]' : '') + '  ' + (it.firstArg || '(no args)') +
        (it.count > 1 ? '   ×' + it.count : ''))
    }
    lines.push('')
  }
  lines.push('To see one call\'s full args and result: mode=block, line=<the number after L above>.')
  lines.push('To read the whole segment verbatim: mode=raw (paged by cursor). To seal it: install the scripts as a toolScript.')
  return lines.join('\n')
}

/* ─────────────────────── 工具一：session_tool_create_read ─────────────────────── */

/** 读这一侧的参数校验；写那一侧另有 validateWriteArgs（0.3.3 拆开）。 */
function validateReadArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  const mode = args.mode === undefined ? 'outline' : String(args.mode)
  if (!['outline', 'raw', 'block'].includes(mode)) throw new Error('mode accepts only outline / raw / block: ' + mode)
  if (args.toolScript !== undefined || args.replace !== undefined) {
    throw new Error('this tool is read-only; use ' + TOOL_CREATE_WRITE_NAME + ' to install a toolScript')
  }
  if (args.cursor !== undefined && (!Number.isInteger(args.cursor) || args.cursor < 0)) throw new Error('cursor is a 0-based character offset')
  // 0.4.11：去掉 1000~200000 的死区间——分页只要求「是个正整数」。
  if (args.chars !== undefined && (!Number.isInteger(args.chars) || args.chars <= 0)) {
    throw new Error('chars must be a positive integer (characters per page, default 40000)')
  }
  if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1)) throw new Error('line is a 1-based body line number (use the number after L in the outline)')
  if (args.span !== undefined && (!Number.isInteger(args.span) || args.span < 0)) throw new Error('span must be an integer from 0 (extra lines in a block)')
  if (args.maxItems !== undefined && (!Number.isInteger(args.maxItems) || args.maxItems < 1)) throw new Error('maxItems must be a positive integer')
  return mode
}

/** 写盘那一侧的返回文本。 */
function renderWriteResult(res) {
  const lines = [
    'Installed toolScript: ' + res.id,
    'Directory: ' + res.dir,
    'Files:',
    ...res.files.map((f) => '  · ' + f.name + ' (' + f.kind + ' · ' + f.bytes + ' bytes · sha256 ' + f.sha256.slice(0, 12) + '…)'),
    res.backup ? 'Previous version kept at: ' + res.backup : '',
    'Index: ' + res.indexPath,
    '',
    'Ready to run: session_tool_call({ toolScript: "' + res.id + '" }); add dryRun: true to see the commands first.',
    'This toolScript\'s name and purpose enter the system prompt (the toolSequence section) on the next assembly.'
  ]
  return lines.filter((l) => l !== '').join('\n')
}

/**
 * 工具定义（读）：只回读原文，三档，绝不写盘。
 * @param {{dshHome:string, logger?:object}} options
 * @returns {object}
 */
export function buildToolCreateReadDefinition({ dshHome, logger }) {
  return {
    name: TOOL_CREATE_READ_NAME,
    description: [
      'Read one recall of this workspace back as original text: every tool call with its arguments and result.',
      'Use when the user asks how something was done and those steps are no longer in context (compacted away, or an earlier session).',
      'Read it yourself instead of asking the user to repeat the steps.',
      '- outline (default): calls deduplicated by tool name + first argument, with line numbers and failures.',
      '- raw: the body verbatim, paged with cursor.',
      '- block: one call with its args and result.',
      'To run those commands again, install them with ' + TOOL_CREATE_WRITE_NAME + '.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: 'Recall file name in this workspace.' },
        date: { type: 'string', description: 'Local date YYYY-MM-DD; use instead of file.' },
        nth: { type: 'integer', description: 'Which recall of that date (default 1, by compaction time).' },
        mode: { type: 'string', enum: ['outline', 'raw', 'block'], description: 'Read mode (default outline).' },
        cursor: { type: 'integer', description: 'raw: character offset to continue from (returned as nextCursor).' },
        chars: { type: 'integer', description: 'raw: chunk size in characters (positive; default 40000).' },
        line: { type: 'integer', description: 'block: 1-based body line from the outline (the number after L).' },
        span: { type: 'integer', description: 'block: extra lines to include after that block (default 0).' },
        maxItems: { type: 'integer', description: 'outline: max distinct calls to list (default: all).' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['outline', 'raw', 'block'] },
          file: { type: 'string' },
          path: { type: 'string' },
          text: { type: 'string' },
          calls: { type: 'number' },
          failures: { type: 'number' },
          distinct: { type: 'number' },
          nextCursor: { type: 'number' },
          totalChars: { type: 'number' },
          done: { type: 'boolean' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }]
    },
    async execute(args, exec) {
      const mode = validateReadArgs(args)
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') throw new Error(TOOL_CREATE_READ_NAME + ' needs to know the current workspace')
      const file = await locateMemory(args, { dshHome, cwd })
      const one = await readBodyOf({ dshHome, cwd, file })
      const body = one.body

      // ── 读：整段分页 ──
      if (mode === 'raw') {
        const cursor = args.cursor === undefined ? 0 : args.cursor
        const chars = args.chars === undefined ? 40000 : args.chars
        const slice = body.slice(cursor, cursor + chars)
        const next = cursor + slice.length
        const done = next >= body.length
        return jsonSafe({
          mode: 'raw', file: one.file, path: one.path,
          text: slice,
          nextCursor: done ? body.length : next,
          totalChars: body.length,
          done
        })
      }

      const blocks = parseBlocks(body)

      // ── 读：单块展开 ──
      if (mode === 'block') {
        if (args.line === undefined) throw new Error('block requires line (the number after L in the outline)')
        const lines = body.split('\n')
        if (args.line > lines.length) throw new Error('line exceeds the body line count (' + lines.length + '): ' + args.line)
        const target = pickBlockAt(blocks, args.line)
        if (!target) throw new Error('no tool call near L' + args.line + '; use mode=outline to see the outline first')
        const span = args.span === undefined ? 0 : Math.max(0, Number(args.span) || 0)
        const from = target.line
        const to = Math.min(lines.length, Math.max(target.endLine, args.line) + span)
        const slice = lines.slice(from - 1, to).join('\n')
        const head = 'L' + from + '–' + to + ' · ' + target.name +
          (target.failed ? ' · [this call failed]' : (target.status ? ' · ' + target.status : ' · no result (execution interrupted)'))
        const parts = [head, '', slice]
        // 结果区：◂ 之前那一段。和块内的缩进段一致时就不再抄一遍（同一段字不写两次）。
        const same = target.resultText.length === target.argLines.length &&
          target.resultText.every((l, i) => l === target.argLines[i])
        if (target.resultText.length > 0 && !same) {
          const capped = target.resultText.slice(0, 40)
          parts.push('', '【Result】the content right before ◂ (the previous call\'s output may share the same indentation and cannot be separated textually):')
          parts.push(capped.join('\n'))
          if (target.resultText.length > capped.length) parts.push('… (' + (target.resultText.length - capped.length) + ' more lines; use mode=raw to fetch them by line number)')
        }
        return jsonSafe({
          mode: 'block', file: one.file, path: one.path,
          text: parts.join('\n')
        })
      }

      // ── 读：骨架（默认） ──
      const outline = outlineOf(blocks, { maxItems: args.maxItems === undefined ? Infinity : args.maxItems })
      return jsonSafe({
        mode: 'outline', file: one.file, path: one.path,
        calls: outline.calls, failures: outline.failures, distinct: outline.distinct,
        text: renderOutline({ file: one.file, filePath: one.path, body, outline })
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Read recall original',
      kind: 'other',
      rawInput: args && (args.file || args.date || args.mode || 'outline')
    })
  }
}

/* ─────────────────────── 工具二：session_tool_create_write ─────────────────────── */

/** 写这一侧的参数校验：只收 toolScript / replace / 可选定位（定位只用来记出处）。 */
function validateWriteArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  if (args.toolScript === undefined) throw new Error('toolScript is required: { id, title, purpose, entry, scripts }')
  if (args.toolScript === null || typeof args.toolScript !== 'object' || Array.isArray(args.toolScript)) throw new Error('toolScript must be an object')
  for (const k of ['mode', 'cursor', 'chars', 'line', 'span', 'maxItems']) {
    if (args[k] !== undefined) throw new Error('installing a toolScript does not take ' + k + ': that is an argument of ' + TOOL_CREATE_READ_NAME)
  }
  if (args.file !== undefined && typeof args.file !== 'string') throw new Error('file must be a string (only pass it to record provenance)')
  if (args.file !== undefined && args.date !== undefined) throw new Error('file and date are mutually exclusive')
  if (args.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.date))) throw new Error('date must be YYYY-MM-DD')
  if (args.nth !== undefined && (!Number.isInteger(args.nth) || args.nth < 1)) throw new Error('nth must be an integer starting at 1')
  if (args.replace !== undefined && typeof args.replace !== 'boolean') throw new Error('replace must be a boolean')
}

/**
 * 工具定义（写）：把一条链装成一个工具脚本。**不需要**先有一份回顾文件——
 * file/date 只是可选的「出处记账」，不给也能装。
 */
export function buildToolCreateWriteDefinition({ dshHome, logger }) {
  return {
    name: TOOL_CREATE_WRITE_NAME,
    description: [
      'Seal a proven command chain into a toolScript: scripts plus a manifest under $DSH_HOME/session-memory/toolSequence/<id>/.',
      'Use only when you just ran those commands here, ' + TOOL_CREATE_READ_NAME + ' read it back from a recall, or the user says the way is worth keeping. A recall is one source, not a prerequisite.',
      'Source can also be material the user handed over or a workspace procedure (skill, AGENTS.md, handover note): copy its commands as written. If the user wants the script itself, that is scripts[].',
      '- The artifact is scripts; a markdown note is not runnable and is not the output.',
      '- Copy what ran, do not invent it. Seal only what repeats: the whole repeated chain, not only its tail.',
      '- Fixed parts into scripts; per-run choices into params argv; secrets never into a script, read at run time.',
      '- Keep scripts quiet: one conclusion line, the platform error text on failure.',
      '- Exit code is the verdict: a failing script must exit non-zero.',
      'Pass only a script that already ran clean, never a draft: retries re-send the whole context.',
      'Installs immediately.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['toolScript'],
      properties: {
        file: { type: 'string', description: 'Optional: recall file name to record as provenance.' },
        date: { type: 'string', description: 'Optional: local date YYYY-MM-DD for provenance; use instead of file.' },
        nth: { type: 'integer', description: 'Optional: which recall of that date (default 1, by compaction time).' },
        toolScript: {
          type: 'object',
          description: 'The toolScript to install: the whole chain as scripts.',
          properties: {
            id: { type: 'string', description: 'Slug id: a-z0-9- only, starts with a letter, no length limit.' },
            title: { type: 'string', description: 'What this toolScript is called, in the user language.' },
            purpose: { type: 'string', description: 'One line: what it does. Shows in the system prompt, so keep it short.' },
            params: { type: 'array', items: { type: 'string' }, description: 'argv order of the entry script; shown in the toolSequence catalog line so the next call knows what to pass. Not validated — a wrong order silently shifts the arguments (params: ["prompt","workdir"] reads as $1 and $2).' },
            entry: { type: 'string', description: 'Entry script file name; defaults to the first script.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Script names in pipeline order.' },
            timeoutMs: { type: 'integer', description: 'Per-step timeout in ms (default: the host timeoutMs; clamped to the host maxTimeoutMs).' },
            provenance: {
              type: 'object',
              description: 'Where it came from: recall file, body line, seq.',
              properties: {
                memory: { type: 'string' },
                line: { type: 'integer' },
                seq: { type: 'integer' }
              }
            },
            scripts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Script file name; must match the extension of run.' },
                  run: { type: 'string', enum: ['bash', 'node', 'ps1', 'cmd'], description: 'Must match the file extension: bash/.sh, node/.js/.mjs/.cjs, ps1/.ps1, cmd/.bat/.cmd. ps1 runs Windows PowerShell 5.1; node runs the host runtime (PATH has no node).' },
                  content: { type: 'string', description: 'The script itself; no recall section markers (## Summary / ## Original / ## Diary) inside.' },
                  params: { type: 'array', items: { type: 'string' }, description: 'Same argv order for this step; omit when the step takes no arguments.' }
                }
              }
            },
            docs: {
              type: 'array',
              description: 'Read-only notes (paths, pitfalls, speed baselines) — stored, never executed. Names must be unique; README.md is reserved for the generated file.',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, content: { type: 'string' } }
              }
            }
          }
        },
        replace: { type: 'boolean', description: 'Required when the id is already installed: overwrite it (old dir kept as .bak-*).' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['write'] },
          id: { type: 'string' },
          dir: { type: 'string' },
          files: { type: 'array', items: { type: 'object' } },
          catalog: { type: 'string' },
          text: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }]
    },
    async execute(args, exec) {
      validateWriteArgs(args)
      const spec = { ...args.toolScript }
      if (args.file !== undefined || args.date !== undefined) {
        const cwd = exec?.agent?.session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') throw new Error(TOOL_CREATE_WRITE_NAME + ' needs the current workspace when file/date is given')
        const mem = await locateMemory(args, { dshHome, cwd })
        const kept = spec.provenance && typeof spec.provenance === 'object' ? spec.provenance : {}
        spec.provenance = { ...kept, memory: typeof kept.memory === 'string' && kept.memory !== '' ? kept.memory : mem }
      }
      const res = await installToolScript({ dshHome, spec, replace: args.replace === true })
      let catalog = ''
      try { catalog = catalogText(dshHome, 'zh') } catch { catalog = '' }
      return {
        mode: 'write', id: res.id, dir: res.dir,
        files: res.files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256, kind: f.kind })),
        text: renderWriteResult(res), catalog
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Install toolScript',
      kind: 'other',
      rawInput: args && args.toolScript ? args.toolScript.id : undefined
    })
  }
}

/**
 * 找到这一行所在的块：落在块之间就取最近的上一个块；
 * 落在第一个块之前（用户先说了一句）就取第一个块——模型通常拿着骨架里的行号回来。
 */
export function pickBlockAt(blocks, line) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null
  let best = null
  for (const b of blocks) {
    if (b.line <= line && (!best || b.line > best.line)) best = b
  }
  return best ?? blocks[0]
}

/* ────────────────────────── 工具二：session_tool_call ────────────────────────── */

/** 把 cwd 说法收成绝对路径：workspace / toolScript / 明确路径（必须在两者之内）。 */
function resolveRunCwd(value, { cwd, dir }) {
  const raw = value === undefined ? 'workspace' : String(value)
  if (raw === 'workspace') return cwd
  if (raw === 'toolScript') return dir
  const abs = path.resolve(raw)
  const inWorkspace = inside(cwd, abs)
  const inToolScript = inside(dir, abs)
  if (!inWorkspace && !inToolScript) throw new Error('cwd must be workspace / toolScript, or a path inside either: ' + raw)
  return abs
}

/** a 是否等于 b 或 b 在 a 之内。 */
function inside(a, b) {
  const rel = path.relative(path.resolve(a), path.resolve(b))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 校验一次调用的形状。 */
function validateCallShape(call, where) {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) throw new Error(where + 'must be an object')
  if (typeof call.toolScript !== 'string' || call.toolScript.trim() === '') throw new Error(where + 'toolScript must not be empty')
  if (call.args !== undefined && (!Array.isArray(call.args) || call.args.some((a) => typeof a !== 'string' && typeof a !== 'number'))) {
    throw new Error(where + 'args must be an array of strings')
  }
  if (call.stdin !== undefined && typeof call.stdin !== 'string') throw new Error(where + 'stdin must be a string')
  if (call.timeoutMs !== undefined && !Number.isInteger(call.timeoutMs)) throw new Error(where + 'timeoutMs must be an integer')
  if (call.cwd !== undefined && typeof call.cwd !== 'string') throw new Error(where + 'cwd must be a string')
}

/**
 * 点名的工具脚本在磁盘上找不到时的报错（0.4.7）。
 *
 * 为什么必须抛：工具组清单按会话冻住（见 catalog-snapshot.js），删掉的脚本还会留在清单里，
 * 模型就会照着清单点名它。0.4.6 只把「✗ 没跑起来」写进正文交差，这次调用仍然算成功——
 * 模型会当成跑过，接着往下说。这里改成抛错：这次调用显示为失败，模型非知道不可。
 * 文案三件事讲全：叫的是什么、为什么清单里还有、现在怎么拿到真名单。
 * @param {string} id 模型点名的 toolScript id
 * @param {string} detail 底层原因（找不到清单 / 清单坏了）
 * @returns {string}
 */
function missingToolScriptMessage(id, detail) {
  return [
    '【Call blocked before anything ran】the toolSequence has no toolScript named ' + id + '.',
    'Underlying cause: ' + detail,
    'Why the list (system prompt) still shows it: the list is frozen per session — installing or removing toolScripts mid-session does not touch the system prompt, ' +
      'otherwise the whole conversation would be re-sent as uncached input. So a deleted script can keep appearing in the list until the list is refetched or the session changes.',
    'What to do: call ' + TOOL_CALL_TOOL_NAME + ' with no arguments to see the real list on disk; ' +
      'to make this session refetch the list from disk, toggle "When the list is refreshed" once in Settings, or start a new session.'
  ].join('\n')
}

/**
 * 0.4.10：开跑前的契约，一次校验完。
 *
 * 0.4.6–0.4.9 这些错只会变成正文里的一行「✗ … 没跑起来」，宿主仍判定这次调用成功。
 * 现在一律抛错：调用失败（红），而且整批一条都不跑——不会出现「前两条跑了、第三条才说不合格」。
 * 唯一的例外是「脚本真的跑了，但 exit≠0 / 超时」：那是结果，不是契约错，仍按结果回报（带 stdout/stderr）。
 * @param {{req:object, id:string, manifest:object, dir:string}} item
 * @param {{cwd:string, args:object, allowDrift:boolean}} ctx
 * @returns {{step:string, script:object, file:string, runCwd:string, timeoutMs:number, argvArgs:string[]}}
 */
function planOne({ req, manifest, dir }, { cwd, args, allowDrift }) {
  const scripts = Array.isArray(manifest.scripts) ? manifest.scripts : []
  const step = req.step === undefined ? manifest.entry : String(req.step)
  const script = scripts.find((s) => s && s.name === step)
  if (!script) {
    throw new Error('this toolScript has no such script: ' + step + ' (available: ' + scripts.map((s) => s.name).join(', ') + ')')
  }
  const file = resolveInside(dir, step)
  if (!fsSync.existsSync(file)) {
    throw new Error('the manifest lists this script but the file is missing on disk: ' + step + ' (reinstall this toolScript; do not delete files by hand)')
  }
  const hashes = manifest.hashes && typeof manifest.hashes === 'object' ? manifest.hashes : {}
  const expected = typeof hashes[step] === 'string' ? hashes[step] : ''
  if (expected !== '' && !allowDrift && sha256OfFile(file) !== expected) {
    throw new Error('script sha256 does not match the manifest, refusing to run (' + step + '). ' +
      'If you just edited it by hand, reinstall the toolScript (' + TOOL_CREATE_WRITE_NAME + ' + replace), or pass allowDrift: true explicitly this time.')
  }
  // 未知执行方式：run 只收 bash / node / ps1 / cmd；安装时已校验，这里是兜底。
  interpreterOf(script.run)
  const runCwd = resolveRunCwd(req.cwd === undefined ? args.cwd : req.cwd, { cwd, dir })
  const timeoutMs = normalizeTimeout(req.timeoutMs === undefined
    ? (args.timeoutMs === undefined ? manifest.timeoutMs : args.timeoutMs)
    : req.timeoutMs)
  // 参数契约：只在声明了 params 时校验，且只拦「比声明的多」——少传是合法的（可选参数、脚本默认值）。
  const declared = Array.isArray(script.params) && script.params.length > 0
    ? script.params
    : (Array.isArray(manifest.params) ? manifest.params : [])
  const argvArgs = (req.args ?? []).map(String)
  if (declared.length > 0 && argvArgs.length > declared.length) {
    throw new Error('got ' + argvArgs.length + ' arguments, but ' + step + ' declares only ' + declared.length +
      ' (' + declared.join(' ') + '); extras would shift positions. Put them in the toolScript params instead of forcing them in')
  }
  return { step, script, file, runCwd, timeoutMs, argvArgs }
}

/**
 * 工具定义：直接跑工具组里的工具脚本（一条或连着几条）。
 * @param {{dshHome:string, logger?:object}} options
 * @returns {object}
 */
export function buildToolCallToolDefinition({ dshHome, logger }) {
  return {
    name: TOOL_CALL_TOOL_NAME,
    description: [
      'Run an installed toolScript as-is, from the scripts recorded when it worked.',
      '- toolScript: run its entry. step: another script of that toolScript. calls[]: several in a row, sequentially, each with its own exit code and output.',
      '- No arguments: lists the installed toolScripts.',
      '- dryRun: true prints the argv without executing; use it when unsure.',
      '- More args than the step declares fails before anything runs; fewer is fine.',
      '- Do not rewrite the scripts or re-derive their commands: they are the record of what worked.',
      '- Only files inside the toolScript dir run; args go as argv, never through a shell.',
      'Timeout and per-stream output cap follow the host terminal settings; a run that hits its timeout is NOT killed — it moves to the background and keeps writing to a log file (pid and path are returned; stop it with the shell tool).'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        toolScript: { type: 'string', description: 'The toolScript id (an installed one).' },
        step: { type: 'string', description: 'Script file name inside the toolScript; defaults to its entry.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments for the script (argv); more than the step declares fails before running, fewer is allowed.' },
        stdin: { type: 'string', description: 'Written to the script stdin when given.' },
        cwd: { type: 'string', description: 'workspace (default) | toolScript | a path inside either.' },
        timeoutMs: { type: 'integer', description: 'Per-step timeout in ms (default: toolScript setting; capped at the host maxTimeoutMs).' },
        maxOutputBytes: { type: 'integer', description: 'Per-step stdout+stderr cap (default: the host maxOutputBytes).' },
        dryRun: { type: 'boolean', description: 'Print argv without executing.' },
        allowDrift: { type: 'boolean', description: 'Run even if the script no longer matches the manifest hash.' },
        stopOnError: { type: 'boolean', description: 'Stop the batch at the first failure (default false: run all, report each).' },
        calls: {
          type: 'array',
          description: 'Several steps in a row: [{ toolScript, step?, args?, stdin?, timeoutMs?, cwd? }].',
          items: {
            type: 'object',
            properties: {
              toolScript: { type: 'string' },
              step: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } },
              stdin: { type: 'string' },
              timeoutMs: { type: 'integer' },
              cwd: { type: 'string' }
            }
          }
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['list', 'run', 'dry'] },
          text: { type: 'string' },
          runs: { type: 'array', items: { type: 'object' } },
          failed: { type: 'number' },
          skipped: { type: 'number' },
          // 0.4.11 起：超时转后台时带这一项（有几条转后台了）。
          // 宿主按 additionalProperties: false 校验输出，这一项不声明就会让整次调用判失败。
          background: { type: 'number' },
          // 宿主终端设置没读全时的说明（只在读不全时出现）。
          limitsNote: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }]
    },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') throw new Error(TOOL_CALL_TOOL_NAME + ' needs to know the current workspace')

      // 不带参数：列名单（注入被关掉时也能看见有什么）
      if (args.toolScript === undefined && args.calls === undefined) {
        const list = await listToolScripts(dshHome)
        const text = list.length === 0
          ? 'The toolSequence is empty. To install a toolScript, write the chain you just ran with ' + TOOL_CREATE_WRITE_NAME + ' as a toolScript (commands can come from the current context, or be recovered from a review original with ' + TOOL_CREATE_READ_NAME + ').'
          : ['ToolSequence · ' + list.length + ' toolScript(s):', ...list.map((b) =>
            '· ' + b.id + ' (' + b.title + '): ' + b.purpose + '｜entry ' + b.entry +
            (b.params.length > 0 ? '｜args ' + b.params.join(' ') : '') +
            (b.steps.length > 0 ? '｜steps ' + b.steps.join(' → ') : '')),
          '', 'Run: session_tool_call({ toolScript: "<id>" }); add dryRun: true to see the commands first.'].join('\n')
        return jsonSafe({ mode: 'list', text })
      }

      // 组装这一次要跑的清单
      const requests = []
      if (Array.isArray(args.calls)) {
        if (args.toolScript !== undefined || args.step !== undefined) {
          throw new Error('with calls, do not also pass top-level toolScript / step: each item carries its own')
        }
        if (args.calls.length === 0) throw new Error('calls must not be an empty array')
        // 0.4.11：去掉「一次最多 20 条」的死上线，按给的顺序全跑。
        args.calls.forEach((c, i) => { validateCallShape(c, 'calls[' + i + ']：'); requests.push(c) })
      } else {
        validateCallShape({ toolScript: args.toolScript, args: args.args, stdin: args.stdin, timeoutMs: args.timeoutMs, cwd: args.cwd }, '')
        requests.push({ toolScript: args.toolScript, step: args.step, args: args.args, stdin: args.stdin, timeoutMs: args.timeoutMs, cwd: args.cwd })
      }

      const stopOnError = args.stopOnError === true
      const dryRun = args.dryRun === true
      const allowDrift = args.allowDrift === true
      // 0.4.11：默认值与天花板都来自宿主终端设置（读不到时按 DSH 默认值并注明原因）。
      const limits = readHostLimits()
      const limitsNote = describeHostLimits(limits)
      const limitsMissed = limits.missed.length > 0
      const cap = normalizeMaxOutput(args.maxOutputBytes, limits)

      // 0.4.7：点名要先点得着——所有 toolScript 先找齐，再动手跑。
      // 这样「点到已删除的脚本」是一条硬拦截：抛错 → 这次调用失败，而且一条都不会跑，
      // 不会出现「前两条跑了、第三条才说不存在」的半截状态。
      const resolved = []
      for (const req of requests) {
        const id = assertToolScriptId(req.toolScript)
        try {
          resolved.push({ req, id, ...(await loadToolScript(dshHome, id)) })
        } catch (err) {
          throw new Error(missingToolScriptMessage(id, String(err?.message ?? err)), { cause: err })
        }
      }

      // 0.4.10：每一行的契约先全部校验（脚本名 / 文件在不在 / 哈希 / cwd / 参数个数 / 执行方式）。
      // 任何一条不合格就抛错 → 这次调用失败，整批一条都不跑。
      const planned = resolved.map((item) => ({ ...item, ...planOne(item, { cwd, args, allowDrift }) }))

      const runs = []
      let skipped = 0
      let stopped = false

      for (const p of planned) {
        if (stopped) { skipped++; continue }
        if (dryRun) {
          runs.push(jsonSafe({
            toolScript: p.id, step: p.step, run: p.script.run,
            argv: [p.step, ...p.argvArgs],
            cwd: p.runCwd, timeoutMs: p.timeoutMs, maxOutputBytes: cap, limits: limitsNote, status: 'dry'
          }))
          continue
        }
        let res
        try {
          res = await runScript({
            dshHome, toolScriptId: p.id, dir: p.dir, manifest: p.manifest, step: p.step,
            args: p.argvArgs, stdin: p.req.stdin,
            cwd: p.runCwd, timeoutMs: p.timeoutMs, maxOutputBytes: cap, allowDrift
          })
        } catch (err) {
          // 只有真跑才会暴露的错（解释器不在、spawn 失败）：补上现场后照样抛，不吞。
          const done = runs.length > 0
            ? '\n\nthe ' + runs.length + ' call(s) that finished first in this invocation (output preserved):\n' + renderRuns({ runs, dryRun: false, skipped: 0 })
            : ''
          throw new Error('this call did not start, so the whole invocation counts as failed: ' + p.id + ' / ' + p.step + '\n' +
            String(err?.message ?? err) + done, { cause: err })
        }
        // 0.4.11：超时不再杀进程，转后台继续跑——这不是失败，是「还没跑完」。
        const background = res.background === true
        const ok = !background && res.exitCode === 0 && !res.timedOut
        runs.push(jsonSafe({
          toolScript: p.id, step: p.step,
          status: background ? 'background' : (ok ? 'ok' : 'fail'),
          exitCode: res.exitCode, signal: res.signal, timedOut: res.timedOut,
          background, pid: res.pid, logFile: res.logFile, stderrFile: res.stderrFile,
          durationMs: res.durationMs, truncated: res.truncated, spill: res.spill,
          drift: res.drift, timeoutMs: p.timeoutMs, maxOutputBytes: cap,
          stdout: res.stdout, stderr: res.stderr, argv: res.argv
        }))
        if (!ok && !background && stopOnError) stopped = true
      }

      // 0.4.12：脚本自己跑失败（非零退出码）也算失败——整次调用抛错（红）。
      // 但输出一个字都不丢：异常正文里带上每条的 ✔/✗、exit code、stdout、stderr。
      // 「超时转后台」不算失败：那是还没跑完，pid 与日志路径照常回传。
      const crashed = runs.filter((r) => r.status === 'fail')
      if (crashed.length > 0) {
        const names = crashed.map((r) => r.toolScript + ' / ' + r.step +
          '(exit ' + (r.exitCode === null ? 'null' : r.exitCode) + (r.timedOut ? ', killed on timeout' : '') + ')').join(', ')
        throw new Error(
          '【Invocation failed】' + crashed.length + ' call(s) did not run: ' + names + '\n\n' +
          renderRuns({ runs, dryRun: false, skipped })
        )
      }

      const failed = runs.filter((r) => r.status === 'fail' || r.status === 'error').length
      const background = runs.filter((r) => r.status === 'background').length
      return jsonSafe({
        mode: dryRun ? 'dry' : 'run',
        failed, skipped,
        ...background > 0 ? { background } : {},
        ...limitsMissed && !dryRun ? { limitsNote } : {},
        runs,
        text: renderRuns({ runs, dryRun, skipped })
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args && Array.isArray(args.calls) ? 'Run ' + args.calls.length + ' toolSequence steps' : 'Run toolScript',
      kind: 'other',
      rawInput: args && (args.toolScript || (Array.isArray(args.calls) ? 'calls: ' + args.calls.length : 'list'))
    })
  }
}

/** 跑完之后的回报文本：一条一块，失败先说清楚在哪一步。 */
export function renderRuns({ runs, dryRun, skipped }) {
  const lines = []
  if (dryRun) lines.push('Echo only, nothing executed (dryRun) — check the argv before running for real.')
  for (const r of runs) {
    if (r.status === 'dry') {
      lines.push('▸ ' + r.toolScript + ' / ' + r.step + '（' + r.run + '）')
      lines.push('  argv: ' + JSON.stringify(r.argv))
      lines.push('  cwd: ' + r.cwd + '  timeout: ' + r.timeoutMs + 'ms  output cap: ' + r.maxOutputBytes + ' bytes')
      if (r.limits) lines.push('  ' + r.limits)
      continue
    }
    if (r.status === 'error') {
      lines.push('✗ ' + r.toolScript + (r.step ? (' / ' + r.step) : '') + ' did not start: ' + r.error)
      continue
    }
    if (r.status === 'background') {
      // 0.4.10 及以前这里是「超时已终止」；0.4.11 起进程活着，输出继续往日志里写。
      lines.push('⏳ ' + r.toolScript + ' / ' + r.step + '  【still running after ' + r.timeoutMs +
        'ms; moved to background】pid ' + r.pid)
      lines.push('  It was not killed; it keeps running and will keep writing to this file:')
      lines.push('  ' + r.logFile + (r.stderrFile ? '（stderr: ' + r.stderrFile + '）' : ''))
      const head = String(r.stdout ?? '').replace(/\s+$/, '')
      if (head !== '') lines.push('  —— output so far ——', head)
      const errHead = String(r.stderr ?? '').replace(/\s+$/, '')
      if (errHead !== '') lines.push('  —— stderr ——', errHead)
      lines.push('  To follow it: read that file (tail it); to stop it: kill ' + r.pid)
      continue
    }
    const head = (r.status === 'ok' ? '✔ ' : '✗ ') + r.toolScript + ' / ' + r.step +
      '  exit ' + (r.exitCode === null ? 'null' : r.exitCode) +
      '  ' + r.durationMs + 'ms' +
      (r.drift ? '  【script hash differs from the manifest; explicitly allowed this time】' : '')
    lines.push(head)
    const out = String(r.stdout ?? '').replace(/\s+$/, '')
    const err = String(r.stderr ?? '').replace(/\s+$/, '')
    if (out !== '') lines.push(out)
    if (err !== '') lines.push('--- stderr ---', err)
    if (r.truncated) lines.push('(output truncated; full content: ' + (r.spill || 'spill failed') + ')')
  }
  if (skipped > 0) lines.push(skipped + ' call(s) did not run (an earlier one failed, so stopOnError took effect).')
  return lines.join('\n')
}

/* ────────────────────────── 给注入与设置页复用 ────────────────────────── */

export { catalogText, toolSequenceRoot, TOOL_SCRIPT_FILE, estimateTokens }
