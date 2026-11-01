/**
 * 落盘：目录布局、原子写、载入文件（_assembly.json）。
 *
 * 目录：$DSH_HOME/session-memory/<工作区 key>/
 *   _assembly.json            载入文件（唯一运行期真相：count / pinned / 时间）
 *   20261028-055942-96358e1b.md  一份压缩一份回顾
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { projectKey } from './project-key.js'
import { buildMemoryFile, fileStemOf, parseMemory } from './memory-file.js'
import { renderTranscript, countTools } from './render.js'

const ASSEMBLY = '_assembly.json'
const LOCK = '_assembly.lock'
const ASSEMBLY_VERSION = 1

/** 回顾根目录。 */
export function memoryRoot(dshHome) {
  return path.join(dshHome, 'session-memory')
}

/** 某个工作区的回顾目录。 */
export function memoryDir(dshHome, cwd) {
  return path.join(memoryRoot(dshHome), projectKey(cwd))
}

/** 把内容块数组里的纯文本取出来。 */
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

/**
 * 原子写：同目录临时文件 + rename，避免读到半个文件。
 *
 * POSIX 上 rename 覆盖是原子的；Windows 上目标被别的句柄（杀毒、索引、并发写）占用时
 * 会抛 EPERM/EBUSY/EACCES，所以先退避重试，实在不行才走"先删目标再改名"。
 */
export async function writeFileAtomic(file, content) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, path.basename(file) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10))
  await fs.writeFile(tmp, content, 'utf8')
  const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      if (!RETRYABLE.has(err.code)) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      lastError = err
      await new Promise((r) => setTimeout(r, 12 * (attempt + 1)))
    }
  }
  // 还不行：删掉目标再改名（这一刻短暂失去原子性，只发生在失败路径）
  try {
    await fs.rm(file, { force: true })
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw lastError ?? err
  }
}

/** 拿一把目录锁；拿不到就等，等到超时抛错。 */
async function withLock(dir, fn, options = {}) {
  const lockPath = path.join(dir, LOCK)
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  let held = false
  while (!held) {
    try {
      await fs.mkdir(lockPath)
      held = true
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() > deadline) throw new Error('回顾目录被占用，等待超时：' + lockPath)
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  try {
    return await fn()
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 读载入文件；不存在或坏掉就给一份空的。
 * @returns {Promise<{version:number, workspace:string, entries:object[]}>}
 */
export async function readAssembly(dir, workspace) {
  const file = path.join(dir, ASSEMBLY)
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { version: ASSEMBLY_VERSION, workspace, entries: [] }
    throw err
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.entries)) throw new Error('entries 不是数组')
    return { version: parsed.version ?? ASSEMBLY_VERSION, workspace: parsed.workspace ?? workspace, entries: parsed.entries }
  } catch {
    // 文件坏了不该让整场会话起不来：留个坏档备份，然后当空的重建。
    await fs.rename(file, file + '.broken-' + Date.now()).catch(() => {})
    return { version: ASSEMBLY_VERSION, workspace, entries: [] }
  }
}

/** 写载入文件（原子）。 */
export async function writeAssembly(dir, data) {
  await fs.mkdir(dir, { recursive: true })
  const body = JSON.stringify({ version: ASSEMBLY_VERSION, workspace: data.workspace, entries: data.entries }, null, 2) + '\n'
  await writeFileAtomic(path.join(dir, ASSEMBLY), body)
}

/**
 * 记一条新回顾进载入文件（加锁）。已存在同 compactionId 的条目则跳过，保证幂等。
 * @returns {Promise<{entry: object, added: boolean}>}
 */
export async function upsertEntry(dir, workspace, entry) {
  await fs.mkdir(dir, { recursive: true })
  return withLock(dir, async () => {
    const data = await readAssembly(dir, workspace)
    const existing = data.entries.find((e) => e.file === entry.file)
    if (existing) return { entry: existing, added: false }
    data.entries.push(entry)
    data.workspace = workspace
    await writeAssembly(dir, data)
    return { entry, added: true }
  })
}

/**
 * 一次压缩 -> 一份回顾文件 + 一条载入条目。
 *
 * 纯代码，零模型调用：摘要来自 compaction/summary 事件，原文由被压掉的会话事件渲染。
 * @param {object} args
 * @param {string} args.dshHome
 * @param {string} args.cwd 会话的工作目录
 * @param {object} args.session 会话对象（要能按 seq 取事件）
 * @param {object} args.event compaction/summary 事件
 * @returns {Promise<{file:string, dir:string, entry:object, added:boolean, bytes:number}>}
 */
/** 补齐边界之后那段时收哪些事件；只挑对话类，不把 step/turn 边界算进条数。 */
const TAIL_TYPES = new Set(['user/message', 'assistant/message', 'tool/call', 'tool/result'])

/**
 * PTC 的内层调用：代码里 tools.xxx(...) 的那一次。
 *
 * 它们不在 shadowedSeqs 里（DSH 只列表面事件），只能按 shadowedRange 逐 seq 捞。
 * 两种都收：start 写「发起」（参数在这一头，执行中断没有 dispatch 时也不丢），
 * dispatch 只写「结果 + 成败」（发起已在 start 写过，不重复）。
 * 两者 arguments 实测 1,633 对零差异，所以参数只取 start 那份。
 */
const PTC_TYPES = new Set(['tool/ptc-dispatch-start', 'tool/ptc-dispatch'])

/** 正文第一条非空行在整份文件里的位置（0 基）：正文行号换算成整份文件的行号要用。 */
function bodyStartIndex(allLines) {
  const at = allLines.findIndex((l) => l.includes(':body-->'))
  if (at === -1) return 0
  for (let i = at + 1; i < allLines.length; i++) {
    const line = allLines[i].trim()
    if (line === '' || line.startsWith('## ')) continue
    return i
  }
  return at
}

/**
 * 读工作区里已有回顾的正文，判断「这次要写的开头有多少已经记过」要用它。
 * 同名文件要排除：那是本次即将写入的那一份，自己跟自己比永远全重合。
 * @returns {Promise<{file:string, lines:string[], start:number}[]>}
 */
async function existingBodies(dir, cwd, excludeFile) {
  const data = await readAssembly(dir, cwd)
  const out = []
  for (const entry of data.entries) {
    if (entry.file === excludeFile) continue
    let raw
    try {
      raw = await fs.readFile(path.join(dir, entry.file), 'utf8')
    } catch {
      continue
    }
    const all = raw.split('\n')
    const body = parseMemory(raw).sections.body
    out.push({ file: entry.file, lines: body === '' ? [] : body.split('\n'), start: bodyStartIndex(all) })
  }
  return out
}

/**
 * 候选正文的开头有多少行已经记在别的回顾里。
 *
 * 判据是内容，不是 seq：seq 是每条会话自己的编号。复刻出来的会话与本体共享一段历史，
 * 编号与内容都相同；fork 之后同一串编号指的东西已经不一样了。按内容对齐没有这个问题。
 * 一份回顾存一段连续内容，所以从候选第一行起在每份回顾里找能接上的一段，匹配多长跳过多长，
 * 跨几份回顾可以接着往下对。
 * @param {string[]} candLines 候选正文行（原文形态，与 parseMemory 还原后的一致）
 * @param {{file:string, lines:string[], start:number}[]} files 已有回顾
 * @returns {{covered:number, anchors:{file:string, line:number, end:number}[]}}
 */
function coveredPrefix(candLines, files) {
  const anchors = []
  let i = 0
  while (i < candLines.length) {
    let best = null
    for (const f of files) {
      for (let p = 0; p < f.lines.length; p++) {
        if (f.lines[p] !== candLines[i]) continue
        let n = 0
        while (i + n < candLines.length && p + n < f.lines.length && f.lines[p + n] === candLines[i + n]) n++
        if (best === null || n > best.n) best = { n, f, p }
      }
    }
    if (best === null) break
    anchors.push({ file: best.f.file, line: best.f.start + best.p + best.n, end: i + best.n })
    i += best.n
  }
  return { covered: i, anchors }
}

/**
 * 拆一份回顾文件。
 * @param {object} input
 * @param {string} input.lang 拆解那一刻 DSH 的语言（决定文件头与分区标题写哪套字）
 */
export async function captureCompaction({ dshHome, cwd, session, event, lang = 'zh' }) {
  const data = event.data ?? {}
  const seqs = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs : []
  const at = new Date(typeof event.time === 'number' ? event.time : Date.now())
  const dir = memoryDir(dshHome, cwd)
  const compactedAt = at.toISOString()

  const pick = typeof session.eventAt === 'function'
    ? (seq) => session.eventAt(seq)
    : (seq) => session.snapshotEvents?.(seq, seq + 1)?.[0]
  // 按 seq 去重收事件。DSH 的 shadowedSeqs 只是「被压缩的那部分」，而压缩边界画在
  // 最后一轮回复之前 —— 那条回复还在活跃上下文里，不会被压。拆日志是插件自己的事，
  // 不能跟着那个边界把最后一段漏掉，所以从最大的 seq 往后补到压缩事件本身为止。
  const collected = new Map()
  for (const seq of seqs) {
    const e = pick(seq)
    if (e) collected.set(seq, e)
  }
  let lastSeq = -1
  for (const seq of seqs) if (seq > lastSeq) lastSeq = seq
  if (lastSeq >= 0) {
    for (let seq = lastSeq + 1; ; seq++) {
      const e = pick(seq)
      if (!e || e.type === 'compaction/summary') break
      if (TAIL_TYPES.has(e.type) || PTC_TYPES.has(e.type)) collected.set(seq, e)
    }
  }

  // PTC 内层调用：shadowedSeqs 里一条都没有，按区间自己捞一遍。
  const range = data.shadowedRange ?? {}
  if (Number.isInteger(range.start) && Number.isInteger(range.end)) {
    for (let seq = range.start; seq <= range.end; seq++) {
      if (collected.has(seq)) continue
      const e = pick(seq)
      if (e && PTC_TYPES.has(e.type)) collected.set(seq, e)
    }
  }

  // 逐条渲染，并记下每条事件占正文哪几行：裁切必须落在事件边界上。
  const spans = []
  const candLines = []
  for (const seq of [...collected.keys()].sort((a, b) => a - b)) {
    // 候选行保持原文形态：下面比对的是 parseMemory 还原后的正文，两边都在「原文」这一层，
    // 转义只在落盘那一刻发生。
    const rendered = renderTranscript([collected.get(seq)])
    const lines = rendered === '' ? [] : rendered.split('\n')
    spans.push({ seq, start: candLines.length, count: lines.length })
    for (const line of lines) candLines.push(line)
  }

  // 开头那段如果已经记在别的回顾里，就只写之后的：同一个工作区里复刻出来的会话与本体
  // 共享一段历史，两边各记一遍没有意义，注入时还会重复一遍。
  const file = fileStemOf(at, data.compactionId ?? String(data.compactionId)) + '.md'
  const files = await existingBodies(dir, cwd, file)
  const { covered, anchors } = coveredPrefix(candLines, files)
  let cut = covered
  // 不在一条事件的中间开刀：宁可多留一条（可能重复），也不能漏。
  const straddle = spans.find((sp) => sp.count > 0 && sp.start < cut && sp.start + sp.count > cut)
  if (straddle !== undefined) cut = straddle.start
  // 裁切点之后的事件全留；正好落在裁切点上的空事件也留（不占正文，但算进覆盖区间）
  const keptSpans = spans.filter((sp) => sp.start + sp.count > cut || (sp.count === 0 && sp.start >= cut))
  const keptSeqs = keptSpans.map((sp) => sp.seq)
  const used = anchors.filter((a) => a.end <= cut)
  const anchor = used.length > 0 ? used[used.length - 1] : null
  const branchFrom = anchor === null ? null : { file: anchor.file, line: anchor.line }

  // 一条新内容都不剩：不写空壳文件，也不往载入文件里加条目。
  if (cut > 0 && keptSpans.every((sp) => sp.count === 0)) {
    const why = branchFrom === null ? '内容已经记过' : ('内容到 ' + branchFrom.file + ' 第 ' + branchFrom.line + ' 行为止都已记过')
    return { file: null, dir, skipped: true, reason: why, branchFrom, covered: cut, bytes: 0 }
  }

  const seqStart = keptSeqs.length > 0 ? keptSeqs[0] : (data.shadowedRange?.start ?? 0)
  const seqEnd = keptSeqs.length > 0 ? keptSeqs[keptSeqs.length - 1] : (data.shadowedRange?.end ?? 0)
  const body = candLines.slice(cut).join('\n')
  const { calls, failures } = countTools(body)
  const summary = blocksText(data.summary) || blocksText(data.rawOutput)

  const text = buildMemoryFile({
    date: at,
    compactionId: data.compactionId,
    seqStart,
    seqEnd,
    seqCount: keptSeqs.length,
    branchFrom,
    tokenCount: data.shadowedTokenCount ?? 0,
    toolCalls: calls,
    toolFailures: failures,
    count: 3,
    summary,
    body
  }, lang)

  await fs.mkdir(dir, { recursive: true })
  const target = path.join(dir, file)
  const existed = await fs.access(target).then(() => true, () => false)
  if (!existed) await writeFileAtomic(target, text)

  const entry = { file, compactedAt, count: 3, pinned: false, seqStart, seqEnd }
  if (existed) {
    const data0 = await readAssembly(dir, cwd)
    const found = data0.entries.find((e) => e.file === file)
    if (found) return { file, dir, entry: found, added: false, bytes: Buffer.byteLength(text, 'utf8') }
  }
  const res = await upsertEntry(dir, cwd, entry)
  return { file, dir, entry: res.entry, added: res.added, bytes: Buffer.byteLength(text, 'utf8') }
}

/** 读一份回顾文件并解析。 */
export async function readMemory(dir, file) {
  const text = await fs.readFile(path.join(dir, file), 'utf8')
  return { text, parsed: parseMemory(text) }
}

/** 目录锁对外暴露，搜索命中改深度时要用。 */
export { withLock }
