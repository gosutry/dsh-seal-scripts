/**
 * 搜索（设计文档第十二节）：按「工作区的回顾文件夹」搜，不是文件系统递归。
 *
 * 候选顺序（0.1.26 起）：
 *   1. 本工作区：自己第一，其余子级从最深一层往回收
 *   2. 本工作区的平级：先探到最深一层，从最深往回收，最后才轮到平级自己
 *   3. 再往上一层以后：上一级 -> 它的平级 -> 它们的第 1 层子 -> 第 2 层子 …（由外到内）
 *
 * 范围：本工作区及其子级是「本地范围」，不需要用户许可；平级与上级是「外圈」，
 * 只有 allowOuter 为真（用户点头之后）才纳入。
 *
 * 读取规则：一次只交给模型一条候选；只有「本工作区自己」那一条被读出去时才改深度
 * （0 -> 1、1 -> 2 并锁定）。子级、平级、上级都是只读、不计。
 */

import fs from 'node:fs'
import path from 'node:path'
import { memoryDir, memoryRoot, readAssembly, writeEntry } from './store.js'
import { listMemoryFiles, listSidecars } from './migrate.js'
import { decodeProjectKey } from './project-key.js'
import { parseMemory } from './memory-file.js'
import { readField } from './lang.js'
import { effectiveCount } from './assembly.js'

/** 所有还留着回顾的工作区。工作区路径优先取载入文件里记的，取不到才反解目录名。 */
export function knownWorkspaces(dshHome) {
  const rootDir = memoryRoot(dshHome)
  let names = []
  try {
    names = fs.readdirSync(rootDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    const dir = path.join(rootDir, name)
    // 工作区路径记在任一边车里（同一个目录的边车都写同一个 workspace）；
    // 没有边车（或边车坏了）就反解目录名。
    let workspace = null
    for (const side of listSidecars(dir)) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, side), 'utf8'))
        // path.isAbsolute 两端都对：POSIX 看 '/'，Windows 看 'E:\\' 这种盘符
        if (data && typeof data.workspace === 'string' && path.isAbsolute(data.workspace)) {
          workspace = data.workspace
          break
        }
      } catch { /* 坏边车：换下一份 */ }
    }
    const ws = workspace ?? decodeProjectKey(name)
    // 条目数就是 .md 的数量：.md 是唯一真相，不再信任何清单里的计数。
    const count = listMemoryFiles(dir).length
    out.push({ workspace: ws, dir, count })
  }
  return out.sort((a, b) => a.workspace.localeCompare(b.workspace))
}

function parentOf(p) {
  const d = path.dirname(p)
  return d === p ? null : d
}

/** child 是否在 parent 下面（按路径分段判断，POSIX 与 Windows 都成立）。 */
function isUnder(child, parent) {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** ancestor 到 w 隔了几层；w 就是 ancestor 时是 0，不在其下是 -1。 */
function depthOf(ancestor, w) {
  const rel = path.relative(ancestor, w)
  if (rel === '') return 0
  if (rel.startsWith('..') || path.isAbsolute(rel)) return -1
  return rel.split(path.sep).length
}

/**
 * 由近到远排出候选工作区。
 * @returns {{workspace:string, scope:'self'|'child'|'sibling'|'outer'}[]}
 */
export function expansionOrder(cwd, all) {
  const ws = all.filter((w) => w.count > 0).map((w) => w.workspace)
  const seen = new Set()
  const out = []
  const push = (w, scope) => {
    if (typeof w !== 'string' || w === '' || seen.has(w)) return
    seen.add(w)
    out.push({ workspace: w, scope })
  }

  // ① 本工作区这一支：自己第一，其余从最深一层往回收（和平级同一套）
  const self = ws.filter((w) => isUnder(w, cwd))
  push(cwd, 'self')
  self.sort((a, b) => depthOf(cwd, b) - depthOf(cwd, a) || a.localeCompare(b))
  for (const w of self) push(w, 'child')

  // ② 平级：先探到最深一层，从最深往回收，最后才是平级自己
  const parent = parentOf(cwd)
  const sibs = parent ? ws.filter((w) => parentOf(w) === parent && w !== cwd) : []
  if (sibs.length > 0) {
    const byDepth = new Map()
    for (const s of sibs) {
      for (const w of ws) {
        const d = depthOf(s, w)
        if (d < 1) continue
        if (!byDepth.has(d)) byDepth.set(d, [])
        byDepth.get(d).push(w)
      }
    }
    const deepest = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0
    for (let d = deepest; d >= 1; d--) {
      for (const w of (byDepth.get(d) ?? []).slice().sort()) push(w, 'sibling')
    }
    for (const s of sibs.slice().sort()) push(s, 'sibling')
  }

  // ③ 再往上：上一级 -> 它的平级 -> 它们的第 1 层子 -> 第 2 层子 …（一层推平再下一层）
  let cur = cwd
  for (;;) {
    const up = parentOf(cur)
    // 到盘根就停：盘根本身不是工作区，往上也没有东西可找
    if (up === null || up === '' || up === path.parse(up).root) break
    push(up, 'outer')
    const grand = parentOf(up)
    const group = grand ? ws.filter((w) => parentOf(w) === grand && w !== up) : []
    for (const g of group.slice().sort()) push(g, 'outer')
    const byDepth = new Map()
    for (const g of group) {
      for (const w of ws) {
        const d = depthOf(g, w)
        if (d < 1) continue
        if (!byDepth.has(d)) byDepth.set(d, [])
        byDepth.get(d).push(w)
      }
    }
    const deepest = byDepth.size > 0 ? Math.max(...byDepth.keys()) : 0
    for (let d = 1; d <= deepest; d++) {
      for (const w of (byDepth.get(d) ?? []).slice().sort()) push(w, 'outer')
    }
    cur = up
  }

  // 兜底：路径关系排不进来的（比如别的盘符上的工作区），按字母序补在后面
  for (const w of ws.slice().sort()) push(w, 'outer')
  return out
}

const PASSES = [
  { level: 'keywords', take: (p) => readField(p.meta, 'keywords') },
  { level: 'sum', take: (p) => String((p.sections && p.sections.sum) || '') },
  { level: 'body', take: (p) => String((p.sections && p.sections.body) || '') }
]
const LEVEL_RANK = { keywords: 0, sum: 1, body: 2 }

/**
 * 把 need 拆成搜索词：整句一次，另按标点/空白拆开，只留 2 字以上的碎片。
 * 中文没有分词，靠子串命中，所以碎片比整句更有用。
 */
export function termsOf(need) {
  const raw = String(need === undefined || need === null ? '' : need).trim()
  if (raw === '') throw new Error('need 不能为空')
  const out = new Set([raw.toLowerCase()])
  for (const part of raw.split(/[\s,，。、；;：:！!？?（）()【】\[\]"'“”‘’·…\-—_/\\|]+/)) {
    const t = part.trim().toLowerCase()
    if (t.length >= 2) out.add(t)
  }
  return [...out]
}

/** 这一份回顾在哪一轮命中：关键词 -> 摘要 -> 原文，先命中的为准。 */
function bestPass(parsed, terms) {
  for (const pass of PASSES) {
    const text = pass.take(parsed)
    if (text === '') continue
    const hay = text.toLowerCase()
    let matched = 0
    for (const t of terms) if (hay.indexOf(t) >= 0) matched++
    if (matched > 0) return { level: pass.level, matched, text }
  }
  return null
}

/**
 * 按新顺序收集候选，一次调用只交给模型一条。
 * @returns {Promise<{candidates:object[], blocked:number}>} blocked = 外圈还有几份（没许可时只数不读）
 */
export async function listCandidates({ dshHome, cwd, need, allowOuter = false }) {
  const terms = termsOf(need)
  const all = knownWorkspaces(dshHome)
  const order = expansionOrder(cwd, all)
  const candidates = []
  let blocked = 0

  for (const item of order) {
    const local = item.scope === 'self' || item.scope === 'child'
    const dir = memoryDir(dshHome, item.workspace)
    const data = await readAssembly(dir, item.workspace)
    if (!data.entries || data.entries.length === 0) continue
    // 没许可：外圈只数有几份，不读文件、不给内容
    if (!local && !allowOuter) {
      blocked += data.entries.length
      continue
    }
    const parsedList = []
    for (const entry of data.entries) {
      if (!entry || typeof entry.file !== 'string') continue
      let text = ''
      try { text = await fs.promises.readFile(path.join(dir, entry.file), 'utf8') } catch { continue }
      parsedList.push({ entry, parsed: parseMemory(text) })
    }
    const hits = []
    for (const it of parsedList) {
      const m = bestPass(it.parsed, terms)
      if (m === null) continue
      hits.push({
        file: it.entry.file,
        workspace: item.workspace,
        scope: item.scope,
        local: item.scope === 'self',
        compactedAt: it.entry.compactedAt,
        level: m.level,
        matched: m.matched,
        content: m.text
      })
    }
    hits.sort((a, b) =>
      (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) ||
      (b.matched - a.matched) ||
      String(b.compactedAt).localeCompare(String(a.compactedAt)))
    candidates.push(...hits)
  }
  return { candidates, blocked }
}

/** 本工作区命中才改深度：0 -> 1 并锁定；1 -> 2 并锁定；2 或 3 不动。 */
export async function bumpHits(dir, workspace, files, now) {
  const want = new Set(files)
  let changed = false
  for (const file of want) {
    // 只读这一份、只写这一份：没有共享清单，也就没有需要抢的锁。
    const data = await readAssembly(dir, workspace)
    const entry = data.entries.find((e) => e.file === file)
    if (!entry) continue
    const before = effectiveCount(entry, now)
    if (before === 0) { entry.count = 1; entry.pinned = true }
    else if (before === 1) { entry.count = 2; entry.pinned = true }
    else continue
    await writeEntry(dir, workspace, entry)
    changed = true
  }
  return changed
}
