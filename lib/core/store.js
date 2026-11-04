/**
 * 落盘：目录布局、原子写、载入索引（每份回顾一个 .json 边车）。
 *
 * 目录：$DSH_HOME/session-memory/<工作区 key>/
 *   <stem>.json                载入索引的缓存（.md 才是唯一真相）
 *   20261028-055942-96358e1b.md  一份压缩一份回顾
 *   _assembly.json.migrated-*  旧版单文件索引的迁移遗留（永不自动删）
 */

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { projectKey } from './project-key.js'
import { buildMemoryFile, fileStemOf, parseMemory } from './memory-file.js'
import { renderTranscript, countTools } from './render.js'
import { sidecarName, listSidecars, listMemoryFiles, migrateIndex } from './migrate.js'

const ASSEMBLY_VERSION = 2

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

const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'])

/**
 * 把临时文件改名到目标。POSIX 上 rename 覆盖是原子的；Windows 上目标被别的句柄
 * （杀毒、索引、并发写）占用时会抛 EPERM/EBUSY/EACCES，所以先退避重试，
 * 实在不行才走"先删目标再改名"。
 *
 * 单独导出：批量写要自己造临时文件名（好在 finally 里清理残留），重试逻辑只有这一份。
 * @param {string} tmp 已经写好的临时文件
 * @param {string} file 目标路径
 */
export async function renameWithRetry(tmp, file) {
  let lastError = null
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(tmp, file)
      return
    } catch (err) {
      if (!RETRYABLE_RENAME.has(err.code)) {
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

/** 原子写：同目录临时文件 + renameWithRetry，避免读到半个文件。 */
export async function writeFileAtomic(file, content) {
  const dir = path.dirname(file)
  const tmp = path.join(dir, path.basename(file) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 10))
  await fs.writeFile(tmp, content, 'utf8')
  await renameWithRetry(tmp, file)
}

/**
 * 读载入清单。
 *
 * 不变量：**磁盘上的 .md 就是清单**。边车只是它的缓存：
 *   · 有 .md、没边车 → 用文件 mtime 当 compactedAt，count 3、未锁定，**当场补写边车**；
 *   · 有边车、没 .md → 这份已经不存在了，**顺手清掉边车**（进程被杀留下的半截状态）。
 * 于是「条目在、文件没了」「文件没了、条目又回来」这两类事故在结构上不可能发生。
 *
 * ⚠ 这个「读」带副作用：会补边车、清孤儿边车、顺手做旧索引迁移。
 *   副作用全部 catch 掉——补写失败不影响读出来的内容。
 *
 * @returns {Promise<{version:number, workspace:string, entries:object[]}>}
 */
export async function readAssembly(dir, workspace) {
  // 旧版单文件索引只迁一次；失败也不要紧：下面扫 .md 仍然读得出来。
  try { await migrateIndex(dir, workspace) } catch { /* 迁移失败就有多少读多少 */ }
  const entries = []
  const sidecars = listSidecars(dir)
  for (const file of listMemoryFiles(dir)) {
    const want = sidecarName(file)
    let one = null
    if (sidecars.has(want)) {
      try { one = JSON.parse(await fs.readFile(path.join(dir, want), 'utf8')) } catch { one = null }
    }
    if (one === null || one.file !== file) {
      // 没边车 / 边车坏了：按文件自己的 mtime 补一份，不猜内容
      let stat
      try { stat = await fs.stat(path.join(dir, file)) } catch { continue }
      one = {
        version: 2, workspace, file,
        compactedAt: new Date(stat.mtimeMs).toISOString(),
        count: 3, pinned: false, seqStart: null, seqEnd: null, recoveredFrom: 'mtime'
      }
      await writeEntry(dir, workspace, one).catch(() => {})
    }
    entries.push({
      file: one.file,
      compactedAt: String(one.compactedAt),
      count: typeof one.count === 'number' ? one.count : 3,
      pinned: one.pinned === true,
      seqStart: one.seqStart ?? null,
      seqEnd: one.seqEnd ?? null
    })
  }
  // 孤儿边车：.md 已经不在了，清掉
  const alive = new Set(listMemoryFiles(dir).map(sidecarName))
  for (const name of sidecars) {
    if (!alive.has(name)) await fs.rm(path.join(dir, name), { force: true }).catch(() => {})
  }
  return { version: ASSEMBLY_VERSION, workspace, entries }
}

/**
 * 同步读同一份清单（注入路径要同步求值，不能 await）。
 * 只读：不补边车、不清孤儿；缺边车时按 .md 自己的 mtime 顶一下。
 */
export function readAssemblySync(dir, workspace) {
  const entries = []
  const sidecars = listSidecars(dir)
  for (const file of listMemoryFiles(dir)) {
    const want = sidecarName(file)
    let one = null
    if (sidecars.has(want)) {
      try { one = JSON.parse(fsSync.readFileSync(path.join(dir, want), 'utf8')) } catch { one = null }
    }
    if (one === null || one.file !== file) {
      let stat
      try { stat = fsSync.statSync(path.join(dir, file)) } catch { continue }
      one = {
        version: 2, workspace, file,
        compactedAt: new Date(stat.mtimeMs).toISOString(),
        count: 3, pinned: false, seqStart: null, seqEnd: null, recoveredFrom: 'mtime'
      }
    }
    entries.push({
      file: one.file,
      compactedAt: String(one.compactedAt),
      count: typeof one.count === 'number' ? one.count : 3,
      pinned: one.pinned === true,
      seqStart: one.seqStart ?? null,
      seqEnd: one.seqEnd ?? null
    })
  }
  return { version: ASSEMBLY_VERSION, workspace, entries }
}

/** 写一份边车（原子）。只碰这一份，不需要锁。 */
export async function writeEntry(dir, workspace, entry) {
  await fs.mkdir(dir, { recursive: true })
  await writeFileAtomic(path.join(dir, sidecarName(entry.file)), JSON.stringify({
    version: 2, workspace,
    file: entry.file,
    compactedAt: entry.compactedAt,
    count: typeof entry.count === 'number' ? entry.count : 3,
    pinned: entry.pinned === true,
    seqStart: entry.seqStart ?? null,
    seqEnd: entry.seqEnd ?? null,
    updatedAt: new Date().toISOString()
  }, null, 2) + '\n')
}

/** 删一份边车（删 .md 之后调）。 */
export async function removeEntry(dir, file) {
  await fs.rm(path.join(dir, sidecarName(file)), { force: true })
}

/**
 * 记一条新回顾：边车已存在就不写（幂等）。
 * 以前这里要进目录锁读-改-写整份清单；现在只碰这一份。
 * @returns {Promise<{entry: object, added: boolean}>}
 */
export async function upsertEntry(dir, workspace, entry) {
  const file = path.join(dir, sidecarName(entry.file))
  if (fsSync.existsSync(file)) {
    try { return { entry: JSON.parse(await fs.readFile(file, 'utf8')), added: false } } catch { /* 坏边车：重写 */ }
  }
  await writeEntry(dir, workspace, entry)
  return { entry, added: true }
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

