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
import path from 'node:path'
import { resolveMemoryFile, resolveMemoryByDay, estimateTokens } from './tool.js'
import { parseMemory } from './memory-file.js'
import { MARK } from './render.js'
import {
  installToolScript, listToolScripts, loadToolScript, catalogText, assertToolScriptId, resolveInside,
  toolSequenceRoot, TOOL_SCRIPT_FILE
} from './schema.js'
import { runScript, normalizeTimeout, normalizeMaxOutput } from './schema-runner.js'

export const TOOL_CREATE_READ_NAME = 'session_tool_create_read'
export const TOOL_CREATE_WRITE_NAME = 'session_tool_create_write'
export const TOOL_CALL_TOOL_NAME = 'session_tool_call'

/** 原文里 ▸ 块的状态行：render.js 写死了「完成」与「报错：」。 */
const DONE_MARK = MARK.result + '完成'
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
  if (!parsed.id) throw new Error('这份文件没有回顾分区标记，不是回顾文件：' + file)
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
    throw new Error('要么给 file（回顾文件名），要么给 date（YYYY-MM-DD，默认第 1 份）来定位哪一份回顾')
  }
  if (hasFile && hasDate) throw new Error('file 与 date 只能给一个')
  if (hasFile) return String(args.file).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(args.date).trim())) {
    throw new Error('date 要写成 YYYY-MM-DD（本地日期）：' + String(args.date))
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
 * @param {Array<object>} blocks
 * @param {{maxItems?:number}} options
 * @returns {{calls:number, failures:number, distinct:number, groups:Array<object>}}
 */
export function outlineOf(blocks, { maxItems = 400 } = {}) {
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
    const room = Math.max(0, maxItems - printed)
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
  lines.push('原文骨架 · ' + file + '（' + filePath + '）')
  lines.push('正文 ' + Buffer.byteLength(body, 'utf8') + ' 字节 / ' + body.split('\n').length + ' 行' +
    '；工具调用 ' + outline.calls + ' 次（失败 ' + outline.failures + ' 次）；去重后 ' + outline.distinct + ' 条')
  lines.push('')
  for (const g of outline.groups) {
    lines.push('▸ ' + g.tool + ' · 共 ' + g.count + ' 次' + (g.failed > 0 ? '（失败 ' + g.failed + '）' : '') +
      ' · 去重 ' + g.distinct + ' 条' + (g.omitted > 0 ? '（这里显示 ' + g.shown + ' 条，其余没列）' : ''))
    for (const it of g.items) {
      lines.push('  L' + it.line + (it.failed ? ' [失败]' : '') + '  ' + (it.firstArg || '（无参数）') +
        (it.count > 1 ? '   ×' + it.count : ''))
    }
    lines.push('')
  }
  lines.push('要看某一条的完整参数与结果：mode=block, line=<上面那个 L 后面的数字>。')
  lines.push('要按原样读完整段：mode=raw（cursor 分页）。要固化：把 scripts 装进 toolScript。')
  return lines.join('\n')
}

/* ─────────────────────── 工具一：session_tool_create_read ─────────────────────── */

/** 读这一侧的参数校验；写那一侧另有 validateWriteArgs（0.3.3 拆开）。 */
function validateReadArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象')
  const mode = args.mode === undefined ? 'outline' : String(args.mode)
  if (!['outline', 'raw', 'block'].includes(mode)) throw new Error('mode 只收 outline / raw / block：' + mode)
  if (args.toolScript !== undefined || args.replace !== undefined) {
    throw new Error('这个工具只读；装工具脚本用 ' + TOOL_CREATE_WRITE_NAME)
  }
  if (args.cursor !== undefined && (!Number.isInteger(args.cursor) || args.cursor < 0)) throw new Error('cursor 是 0 起的字符偏移')
  if (args.chars !== undefined && (!Number.isInteger(args.chars) || args.chars < 1000 || args.chars > 200000)) {
    throw new Error('chars 要在 1000~200000 之间（默认 40000）')
  }
  if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1)) throw new Error('line 是 1 起的正文行号（用骨架里的 L 后面的数字）')
  if (args.span !== undefined && (!Number.isInteger(args.span) || args.span < 0)) throw new Error('span 是 0 起的整数（block 里多带几行）')
  if (args.maxItems !== undefined && (!Number.isInteger(args.maxItems) || args.maxItems < 1)) throw new Error('maxItems 要是正整数')
  return mode
}

/** 写盘那一侧的返回文本。 */
function renderWriteResult(res) {
  const lines = [
    '已装好工具脚本：' + res.id,
    '目录：' + res.dir,
    '文件：',
    ...res.files.map((f) => '  · ' + f.name + '（' + f.kind + ' · ' + f.bytes + ' 字节 · sha256 ' + f.sha256.slice(0, 12) + '…）'),
    res.backup ? '旧版本留在：' + res.backup : '',
    '索引：' + res.indexPath,
    '',
    '现在就能跑：session_tool_call({ toolScript: "' + res.id + '" })；先看命令就加 dryRun: true。',
    '这个工具脚本的名字与用途会在下一轮装配时进入系统提示词（工具组那一段）。'
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
        chars: { type: 'integer', description: 'raw: chunk size in characters, 1000-200000 (default 40000).' },
        line: { type: 'integer', description: 'block: 1-based body line from the outline (the number after L).' },
        span: { type: 'integer', description: 'block: extra lines to include after that block (default 0).' },
        maxItems: { type: 'integer', description: 'outline: max distinct calls to list (default 400).' }
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
      if (typeof cwd !== 'string' || cwd === '') throw new Error(TOOL_CREATE_READ_NAME + ' 需要知道当前工作区')
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
        return {
          mode: 'raw', file: one.file, path: one.path,
          text: slice,
          nextCursor: done ? body.length : next,
          totalChars: body.length,
          done
        }
      }

      const blocks = parseBlocks(body)

      // ── 读：单块展开 ──
      if (mode === 'block') {
        if (args.line === undefined) throw new Error('block 要给 line（骨架里 L 后面的数字）')
        const lines = body.split('\n')
        if (args.line > lines.length) throw new Error('line 超过正文行数（' + lines.length + '）：' + args.line)
        const target = pickBlockAt(blocks, args.line)
        if (!target) throw new Error('L' + args.line + ' 附近没有工具调用；用 mode=outline 先看骨架')
        const span = args.span === undefined ? 0 : Math.max(0, Number(args.span) || 0)
        const from = target.line
        const to = Math.min(lines.length, Math.max(target.endLine, args.line) + span)
        const slice = lines.slice(from - 1, to).join('\n')
        const head = 'L' + from + '–' + to + ' · ' + target.name +
          (target.failed ? ' · 【这一条报错了】' : (target.status ? ' · ' + target.status : ' · 没有结果（执行中断）'))
        const parts = [head, '', slice]
        // 结果区：◂ 之前那一段。和块内的缩进段一致时就不再抄一遍（同一段字不写两次）。
        const same = target.resultText.length === target.argLines.length &&
          target.resultText.every((l, i) => l === target.argLines[i])
        if (target.resultText.length > 0 && !same) {
          const capped = target.resultText.slice(0, 40)
          parts.push('', '【结果区】紧挨着 ◂ 之前的内容（同一段缩进里可能混着上一条调用的输出，文本分不开）：')
          parts.push(capped.join('\n'))
          if (target.resultText.length > capped.length) parts.push('…（还有 ' + (target.resultText.length - capped.length) + ' 行，用 mode=raw 按行号取）')
        }
        return {
          mode: 'block', file: one.file, path: one.path,
          text: parts.join('\n')
        }
      }

      // ── 读：骨架（默认） ──
      const outline = outlineOf(blocks, { maxItems: args.maxItems === undefined ? 400 : args.maxItems })
      return {
        mode: 'outline', file: one.file, path: one.path,
        calls: outline.calls, failures: outline.failures, distinct: outline.distinct,
        text: renderOutline({ file: one.file, filePath: one.path, body, outline })
      }
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
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象')
  if (args.toolScript === undefined) throw new Error('要给 toolScript：{ id, title, purpose, entry, scripts }')
  if (args.toolScript === null || typeof args.toolScript !== 'object' || Array.isArray(args.toolScript)) throw new Error('toolScript 必须是对象')
  for (const k of ['mode', 'cursor', 'chars', 'line', 'span', 'maxItems']) {
    if (args[k] !== undefined) throw new Error('装工具脚本不收 ' + k + '：那是 ' + TOOL_CREATE_READ_NAME + ' 的参数')
  }
  if (args.file !== undefined && typeof args.file !== 'string') throw new Error('file 必须是字符串（只有想记出处时才给）')
  if (args.file !== undefined && args.date !== undefined) throw new Error('file 与 date 只能给一个')
  if (args.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.date))) throw new Error('date 要写成 YYYY-MM-DD')
  if (args.nth !== undefined && (!Number.isInteger(args.nth) || args.nth < 1)) throw new Error('nth 必须是 1 起的整数')
  if (args.replace !== undefined && typeof args.replace !== 'boolean') throw new Error('replace 必须是布尔值')
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
            id: { type: 'string', description: 'Slug id: a-z0-9- only, starts with a letter, 2-41 chars.' },
            title: { type: 'string', description: 'What this toolScript is called, in the user language.' },
            purpose: { type: 'string', description: 'One line: what it does. Shows in the system prompt, so keep it short.' },
            params: { type: 'array', items: { type: 'string' }, description: 'argv order of the entry script; shown in the toolSequence catalog line so the next call knows what to pass. Not validated — a wrong order silently shifts the arguments (params: ["prompt","workdir"] reads as $1 and $2).' },
            entry: { type: 'string', description: 'Entry script file name; defaults to the first script.' },
            steps: { type: 'array', items: { type: 'string' }, description: 'Script names in pipeline order.' },
            timeoutMs: { type: 'integer', description: 'Per-step timeout, 1000-600000 (default 120000).' },
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
                  content: { type: 'string', description: 'The script itself, max 64 KB; no recall section markers (## Summary / ## Original / ## Diary) inside.' },
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
        if (typeof cwd !== 'string' || cwd === '') throw new Error(TOOL_CREATE_WRITE_NAME + ' 给了 file/date 就需要知道当前工作区')
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
  if (!inWorkspace && !inToolScript) throw new Error('cwd 只能是 workspace / toolScript，或落在两者之内的路径：' + raw)
  return abs
}

/** a 是否等于 b 或 b 在 a 之内。 */
function inside(a, b) {
  const rel = path.relative(path.resolve(a), path.resolve(b))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 校验一次调用的形状。 */
function validateCallShape(call, where) {
  if (call === null || typeof call !== 'object' || Array.isArray(call)) throw new Error(where + '必须是对象')
  if (typeof call.toolScript !== 'string' || call.toolScript.trim() === '') throw new Error(where + 'toolScript 不能为空')
  if (call.args !== undefined && (!Array.isArray(call.args) || call.args.some((a) => typeof a !== 'string' && typeof a !== 'number'))) {
    throw new Error(where + 'args 必须是字符串数组')
  }
  if (call.stdin !== undefined && typeof call.stdin !== 'string') throw new Error(where + 'stdin 必须是字符串')
  if (call.timeoutMs !== undefined && !Number.isInteger(call.timeoutMs)) throw new Error(where + 'timeoutMs 必须是整数')
  if (call.cwd !== undefined && typeof call.cwd !== 'string') throw new Error(where + 'cwd 必须是字符串')
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
      'Each run is capped at 64 KB of output and 120 s by default.'
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
        timeoutMs: { type: 'integer', description: 'Per-step timeout, 1000-600000 (default: toolScript setting).' },
        maxOutputBytes: { type: 'integer', description: 'Per-step stdout+stderr cap (default 65536).' },
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
          skipped: { type: 'number' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }]
    },
    async execute(args, exec) {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('参数必须是对象')
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') throw new Error(TOOL_CALL_TOOL_NAME + ' 需要知道当前工作区')

      // 不带参数：列名单（注入被关掉时也能看见有什么）
      if (args.toolScript === undefined && args.calls === undefined) {
        const list = await listToolScripts(dshHome)
        const text = list.length === 0
          ? '工具组还是空的。要装一个工具脚本：把你刚跑通的那条链用 ' + TOOL_CREATE_WRITE_NAME + ' 写成 toolScript（命令可以来自当前上下文，也可以用 ' + TOOL_CREATE_READ_NAME + ' 从回顾原文里翻回来）。'
          : ['工具组 · ' + list.length + ' 个工具脚本：', ...list.map((b) =>
            '· ' + b.id + '（' + b.title + '）：' + b.purpose + '｜入口 ' + b.entry +
            (b.params.length > 0 ? '｜参数 ' + b.params.join(' ') : '') +
            (b.steps.length > 0 ? '｜步骤 ' + b.steps.join(' → ') : '')),
          '', '跑法：session_tool_call({ toolScript: "<id>" })；先看命令加 dryRun: true。'].join('\n')
        return { mode: 'list', text }
      }

      // 组装这一次要跑的清单
      const requests = []
      if (Array.isArray(args.calls)) {
        if (args.toolScript !== undefined || args.step !== undefined) {
          throw new Error('给了 calls 就别再给顶层 toolScript / step：每一项自带')
        }
        if (args.calls.length === 0) throw new Error('calls 不能是空数组')
        if (args.calls.length > 20) throw new Error('一次最多连着跑 20 条（' + args.calls.length + ' 条）')
        args.calls.forEach((c, i) => { validateCallShape(c, 'calls[' + i + ']：'); requests.push(c) })
      } else {
        validateCallShape({ toolScript: args.toolScript, args: args.args, stdin: args.stdin, timeoutMs: args.timeoutMs, cwd: args.cwd }, '')
        requests.push({ toolScript: args.toolScript, step: args.step, args: args.args, stdin: args.stdin, timeoutMs: args.timeoutMs, cwd: args.cwd })
      }

      const stopOnError = args.stopOnError === true
      const dryRun = args.dryRun === true
      const allowDrift = args.allowDrift === true
      const cap = normalizeMaxOutput(args.maxOutputBytes)
      const runs = []
      let skipped = 0
      let stopped = false

      for (const req of requests) {
        if (stopped) { skipped++; continue }
        const id = assertToolScriptId(req.toolScript)
        try {
          const { manifest, dir } = await loadToolScript(dshHome, id)
          const step = req.step === undefined ? manifest.entry : String(req.step)
          const script = (manifest.scripts ?? []).find((s) => s.name === step)
          if (!script) throw new Error('这个工具脚本里没有这个脚本：' + step + '（有：' + (manifest.scripts ?? []).map((s) => s.name).join('、') + '）')
          const file = resolveInside(dir, step)
          const runCwd = resolveRunCwd(req.cwd === undefined ? args.cwd : req.cwd, { cwd, dir })
          const timeoutMs = normalizeTimeout(req.timeoutMs === undefined ? (args.timeoutMs === undefined ? manifest.timeoutMs : args.timeoutMs) : req.timeoutMs)
          // 参数契约：只在声明了 params 时校验，且只拦「比声明的多」——少传是合法的（可选参数、脚本默认值）。
          const declared = Array.isArray(script.params) && script.params.length > 0
            ? script.params
            : (Array.isArray(manifest.params) ? manifest.params : [])
          const argvArgs = req.args ?? []
          if (declared.length > 0 && argvArgs.length > declared.length) {
            throw new Error('这次给了 ' + argvArgs.length + ' 个参数，但 ' + step + ' 只声明了 ' + declared.length +
              ' 个（' + declared.join(' ') + '）；多出来的会错位。要传就把它们写进 toolScript 的 params，别硬塞')
          }

          if (dryRun) {
            runs.push({
              toolScript: id, step, run: script.run,
              argv: [step, ...argvArgs.map(String)],
              cwd: runCwd, timeoutMs, status: 'dry'
            })
            continue
          }

          const res = await runScript({
            dshHome, toolScriptId: id, dir, manifest, step,
            args: argvArgs, stdin: req.stdin,
            cwd: runCwd, timeoutMs, maxOutputBytes: cap, allowDrift
          })
          const ok = res.exitCode === 0 && !res.timedOut
          runs.push({
            toolScript: id, step, status: ok ? 'ok' : 'fail',
            exitCode: res.exitCode, signal: res.signal, timedOut: res.timedOut,
            durationMs: res.durationMs, truncated: res.truncated, spill: res.spill,
            drift: res.drift,
            stdout: res.stdout, stderr: res.stderr, argv: res.argv
          })
          if (!ok && stopOnError) stopped = true
        } catch (err) {
          runs.push({ toolScript: String(req.toolScript), step: String(req.step ?? ''), status: 'error', error: String(err?.message ?? err) })
          if (stopOnError) stopped = true
        }
      }

      const failed = runs.filter((r) => r.status === 'fail' || r.status === 'error').length
      return {
        mode: dryRun ? 'dry' : 'run',
        failed, skipped,
        runs,
        text: renderRuns({ runs, dryRun, skipped })
      }
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
  if (dryRun) lines.push('只回显不执行（dryRun）——看清 argv 再真跑。')
  for (const r of runs) {
    if (r.status === 'dry') {
      lines.push('▸ ' + r.toolScript + ' / ' + r.step + '（' + r.run + '）')
      lines.push('  argv: ' + JSON.stringify(r.argv))
      lines.push('  cwd: ' + r.cwd + '  超时: ' + r.timeoutMs + 'ms')
      continue
    }
    if (r.status === 'error') {
      lines.push('✗ ' + r.toolScript + (r.step ? (' / ' + r.step) : '') + ' 没跑起来：' + r.error)
      continue
    }
    const head = (r.status === 'ok' ? '✔ ' : '✗ ') + r.toolScript + ' / ' + r.step +
      '  exit ' + (r.exitCode === null ? 'null' : r.exitCode) +
      '  ' + r.durationMs + 'ms' +
      (r.timedOut ? '  【超时已终止】' : '') +
      (r.drift ? '  【脚本和清单哈希不一致，这次是显式放行】' : '')
    lines.push(head)
    const out = String(r.stdout ?? '').replace(/\s+$/, '')
    const err = String(r.stderr ?? '').replace(/\s+$/, '')
    if (out !== '') lines.push(out)
    if (err !== '') lines.push('--- stderr ---', err)
    if (r.truncated) lines.push('（输出被截断，完整内容：' + (r.spill || '溢写失败') + '）')
  }
  if (skipped > 0) lines.push('还有 ' + skipped + ' 条没跑（前面失败，stopOnError 生效了）。')
  return lines.join('\n')
}

/* ────────────────────────── 给注入与设置页复用 ────────────────────────── */

export { catalogText, toolSequenceRoot, TOOL_SCRIPT_FILE, estimateTokens }
