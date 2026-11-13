/**
 * 工具组的导入 / 导出（0.4.3）。
 *
 * 导出：把工具组根目录（toolSequence）下的内容原样打成一个 zip，**压缩率 0**（store），
 *       文件名固定 toolSequence.zip。跳过两类东西：
 *         _runs/          运行溢写（是输出，不是工具本身，可能很大）
 *         *.bak-* / *.tmp-*   重装留下的旧目录、装到一半的临时目录
 *       其余的（_index.json 与每个 <id>/）都进包，解压出来就是一个能直接用的工具组目录。
 *
 * 导入：解包 → 每个顶层 <id>/ 先在临时目录里写全，再整体换上去（和安装同一套做法，
 *       不让人看到装到一半的工具脚本）。包里的 _index.json 不采信：索引是本机的注册表，
 *       直接盖会丢掉本机别的工具脚本，所以按落地后的文件重建这一份，别的一条不动。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  BUNDLE_ID_RE, INDEX_FILE, RUNS_DIR, TOOL_SCRIPT_FILE,
  assertToolScriptId, readIndex, runsDir, sha256OfFile, toolScriptDir, toolSequenceRoot, writeIndex
} from './schema.js'
import {
  readZip, safeEntryName, writeZipFile, zipUncompressedTotal, freeBytesOf, DISK_RESERVE_BYTES,
  readZipCentralFromFile, forEachZipEntry
} from './zip.js'
import { DSH_DEFAULTS } from './host-limits.js'

/** 导出包的名字（用户要的就是这个名字）。 */
export const EXPORT_NAME = 'toolSequence.zip'

/*
 * 0.4.11：删掉 24 MB 的导出上限。工具组就是用户的数据，多大数据就给多大——
 * 而且不再先拼进内存再判大小，改成边读边写进目标文件（writeZipFile）。
 */

/** 打包时跳过、导入时也不收的路径片段。 */
function isTransientName(name) {
  return name === RUNS_DIR || name.includes('.bak-') || name.includes('.tmp-')
}

/**
 * 递归收集一个目录下的文件，名用 / 分隔。
 * @param {string} root 绝对路径
 * @param {string} prefix 包内前缀（不带结尾 /）
 * @param {Array<{name:string,data?:Buffer,mtime?:Date}>} out
 */
async function collect(dir, prefix, out) {
  let list
  try { list = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const item of list) {
    const abs = path.join(dir, item.name)
    const name = prefix === '' ? item.name : prefix + '/' + item.name
    if (isTransientName(item.name)) continue
    if (item.isDirectory()) {
      const before = out.length
      await collect(abs, name, out)
      if (out.length === before) out.push({ name: name + '/' })
      continue
    }
    if (!item.isFile()) continue // 软链之类一律不收
    const stat = await fsp.stat(abs).catch(() => null)
    if (stat === null) continue
    // 0.4.11：只记路径，不把内容读进内存；真正写包时按块流式拷贝。
    out.push({ name, source: abs, mtime: stat.mtime })
  }
}


/**
 * 把工具组目录打成一个 zip（store，压缩率 0），**直接写进指定的工作区文件夹**。
 *
 * 为什么不回给浏览器下载：导出的东西本来就是给这台机器上的人（和下一次会话）用的，
 * 落在工作区里能被 ls 到、能被下一轮直接读，比在手机上下载管理器里翻一个 zip 有用得多。
 *
 * @param {{dshHome:string, dir:string}} p dir 是工作区目录（绝对路径，必须已经是存在的目录）
 * @returns {Promise<{name:string, file:string, dir:string, size:number, files:number, dirs:number, overwritten:boolean}>}
 */
export async function exportToolSequence({ dshHome, dir }) {
  const target = String(dir === undefined || dir === null ? '' : dir).trim()
  if (target === '') throw new Error('no target workspace folder given for the export')
  if (!path.isAbsolute(target)) throw new Error('the workspace directory must be an absolute path: ' + target)
  let st
  try { st = await fsp.stat(target) } catch { throw new Error('workspace directory does not exist: ' + target) }
  if (!st.isDirectory()) throw new Error('not a directory: ' + target)
  if (path.parse(target).root === target) throw new Error('refusing to write into a drive root: ' + target)

  const root = toolSequenceRoot(dshHome)
  const entries = []
  await collect(root, '', entries)
  const files = entries.filter((e) => !String(e.name).endsWith('/'))
  const file = path.join(target, EXPORT_NAME)
  const overwritten = fs.existsSync(file)
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  let written
  try {
    // 0.4.11：流式写盘——内存占用与工具组大小无关，也不再有任何上限。
    written = await writeZipFile(tmp, entries)
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
  return { name: EXPORT_NAME, file, dir: target, size: written.bytes, files: files.length, dirs: entries.length - files.length, overwritten }
}

/**
 * 从落地后的文件重建一条索引项；没有 toolScript.json 就返回 null（不成工具脚本）。
 * @param {string} dshHome
 * @param {string} id
 * @param {Array<{name:string,size:number}>} files 这个 id 下的文件（相对 id 目录）
 */
function indexEntryFromDisk(dir, files) {
  const manifestFile = path.join(dir, TOOL_SCRIPT_FILE)
  let manifest
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) } catch { return null }
  if (!manifest || typeof manifest !== 'object') return null
  const hashes = {}
  for (const f of files) {
    if (f.name.includes('/')) continue
    const abs = path.join(dir, f.name)
    try { hashes[f.name] = sha256OfFile(abs) } catch { /* 读不到就不进哈希表 */ }
  }
  return {
    title: String(manifest.title === undefined ? '' : manifest.title).trim() || String(manifest.id || ''),
    purpose: String(manifest.purpose === undefined ? '' : manifest.purpose),
    entry: String(manifest.entry === undefined ? '' : manifest.entry),
    params: Array.isArray(manifest.params) ? manifest.params.map(String) : [],
    steps: Array.isArray(manifest.steps) ? manifest.steps.map(String) : [],
    dir: String(manifest.id || ''),
    timeoutMs: Number.isFinite(Number(manifest.timeoutMs)) ? Number(manifest.timeoutMs) : DSH_DEFAULTS.timeoutMs,
    updatedAt: new Date().toISOString(),
    hashes
  }
}

/**
 * 手工把 toolSequence 文件夹压成包时，包里面会多一层 toolSequence/。
 * 只有「所有条目都在这一个顶层目录下、而且它就叫 toolSequence」时才剥——
 * 别的单层目录不猜，免得把某个 id 名字当壳剥掉。
 *
 * 0.4.11：改成只算出一个前缀。缓冲路径和流式路径共用它，
 * 流式那边只看中央目录里的名字就能定前缀。
 * @param {string[]} names
 * @returns {string} 要剥掉的前缀（含结尾 /），没有就是空串
 */
function wrapperPrefix(names) {
  const tops = new Set()
  for (const raw of names) {
    const parts = String(raw).split('/').filter((x) => x !== '')
    if (parts.length === 0) continue
    tops.add(parts[0])
    if (tops.size > 1) return ''
  }
  if (tops.size !== 1) return ''
  const only = [...tops][0]
  return only.toLowerCase() === 'toolsequence' ? only + '/' : ''
}

/**
 * 把一个条目名变成「落到哪个工具脚本、哪个相对路径」，或者该跳过。
 * @param {string} rawName 包内原始名（已剥壳之后）
 * @returns {{id:string, rel:string}|{skip:string}}
 */
function planEntry(rawName) {
  let safe
  try {
    safe = safeEntryName(rawName)
  } catch (err) {
    return { skip: String(err.message || err) }
  }
  const parts = safe.split('/')
  const top = parts[0]
  if (parts.length === 1 && top === INDEX_FILE) {
    return { skip: 'the local index is rebuilt from the files on disk; _index.json inside the package is not trusted' }
  }
  if (parts.length < 2) return { skip: 'not inside any toolScript directory' }
  if (top === RUNS_DIR) return { skip: 'run spill directory, not taken' }
  if (!BUNDLE_ID_RE.test(top)) return { skip: 'directory name is not a valid toolScript id' }
  if (isTransientName(parts[1])) return { skip: 'backup/temp directory, not taken' }
  return { id: top, rel: parts.slice(1).join('/') }
}

/**
 * 把一串 Buffer 块写进文件（流式导入用）。
 *
 * 用 pipeline 而不是手写 write/drain：手写版本每块都挂一次 error 监听，
 * 大包会把 EventEmitter 的监听器上限撑爆（实测 11 个就报警）。
 * @param {string} target
 * @param {AsyncIterable<Buffer>} chunks
 */
async function writeChunks(target, chunks) {
  await pipeline(Readable.from(chunks), fs.createWriteStream(target))
}

/**
 * 导入一个工具组包。
 *
 * 两种入口（0.4.11）：
 *   buffer —— 老路径：整个包已经在内存里（设置页的 base64 JSON 请求走它）；
 *   file   —— 新路径：包落在磁盘上的临时文件里，逐条流式解出来直接写进 staging 目录，
 *             内存里只留一块，包多大都不吃内存。
 *
 * 两条路径的落地语义完全一致：每个顶层 <id>/ 先写临时目录，全写完再整体换上去；
 * 包里的 _index.json 不采信，按落地后的文件重建本机索引项。
 *
 * dryRun：只解析，不写盘——设置页先用它把「会装哪些、会盖哪些」念给用户听，点了确认才真装。
 *
 * @param {{dshHome:string, buffer?:Buffer, file?:string, dryRun?:boolean}} p
 * @returns {Promise<{dryRun:boolean, imported:Array<{id:string,files:string[]}>, overwritten:string[], skipped:Array<{name:string,reason:string}>}>}
 */
export async function importToolSequence({ dshHome, buffer, file, dryRun = false }) {
  const root = toolSequenceRoot(dshHome)
  const fromFile = typeof file === 'string' && file !== ''

  // 0.4.11：解压炸弹按「磁盘装不装得下」判，不再拍 128 MB 的死数。
  // 先读中央目录算解压后总字节（不解压、不占内存），再和可用空间比。
  let need
  let names
  if (fromFile) {
    const central = await readZipCentralFromFile(file)
    need = central.reduce((sum, e) => sum + (e.isDir ? 0 : e.uncompSize), 0)
    names = central.map((e) => e.name)
  } else {
    need = zipUncompressedTotal(buffer).bytes
    names = readZip(buffer).map((e) => e.name)
  }
  const probeDir = fs.existsSync(root) ? root : dshHome
  const free = await freeBytesOf(probeDir)
  if (free !== null && need + DISK_RESERVE_BYTES > free) {
    throw new Error('not enough room: needs ' + need + ' bytes unpacked, disk has only ' + free + ' bytes free (reserve ' +
      DISK_RESERVE_BYTES + ' bytes); free some space and import again')
  }

  const cut = wrapperPrefix(names)
  const index = await readIndex(dshHome)
  /** @type {Map<string,string>} id → staging 目录 */
  const stages = new Map()
  /** @type {Map<string,string[]>} id → 已写入的相对路径 */
  const written = new Map()
  const imported = []
  const overwritten = []
  const skipped = []

  if (dryRun !== true) await fsp.mkdir(root, { recursive: true })

  const ensureStage = async (id) => {
    const hit = stages.get(id)
    if (hit !== undefined) return hit
    const stage = path.join(root, id + '.tmp-import-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
    await fsp.rm(stage, { recursive: true, force: true })
    await fsp.mkdir(stage, { recursive: true })
    stages.set(id, stage)
    written.set(id, [])
    imported.push({ id, files: written.get(id) })
    return stage
  }

  /**
   * 一个条目落地（或只记账）。
   * @param {string} rawName 已经剥过壳的名字
   * @param {(target:string) => Promise<void>} writeBody
   */
  const takeEntry = async (rawName, writeBody) => {
    const plan = planEntry(rawName)
    if (plan.skip !== undefined) {
      skipped.push({ name: rawName, reason: plan.skip })
      return
    }
    const id = assertToolScriptId(plan.id)
    if (!overwritten.includes(id) && fs.existsSync(toolScriptDir(dshHome, id))) overwritten.push(id)
    if (dryRun === true) {
      const hit = imported.find((x) => x.id === id)
      if (hit === undefined) imported.push({ id, files: [plan.rel] })
      else hit.files.push(plan.rel)
      return
    }
    const stage = await ensureStage(id)
    const target = path.join(stage, plan.rel)
    const rel = path.relative(stage, target)
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error('out-of-range path: ' + plan.rel)
    }
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await writeBody(target)
    written.get(id).push(plan.rel)
  }

  if (fromFile) {
    await forEachZipEntry(file, async (entry) => {
      const name = cut !== '' && entry.name.startsWith(cut) ? entry.name.slice(cut.length) : entry.name
      if (entry.isDir) return
      if (cut !== '' && (entry.name === cut || entry.name === cut.slice(0, -1))) return
      await takeEntry(name, (target) => new Promise((yes, no) => {
        writeChunks(target, entry.read()).then(yes, no)
      }))
    })
  } else {
    for (const entry of readZip(buffer)) {
      if (entry.isDir) continue
      const name = cut !== '' && entry.name.startsWith(cut) ? entry.name.slice(cut.length) : entry.name
      if (cut !== '' && (entry.name === cut || entry.name === cut.slice(0, -1))) continue
      await takeEntry(name, (target) => fsp.writeFile(target, entry.data))
    }
  }

  if (imported.length === 0) {
    const why = skipped.length > 0 ? ('（' + skipped.slice(0, 3).map((s) => s.name + '：' + s.reason).join('；') + '）') : ''
    for (const stage of stages.values()) await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    throw new Error('this package has no toolScript directories' + why)
  }

  if (dryRun === true) return { dryRun: true, imported, overwritten, skipped }

  for (const [id, stage] of stages) {
    const dest = toolScriptDir(dshHome, id)
    let backup = ''
    try {
      if (fs.existsSync(dest)) {
        backup = dest + '.bak-' + Date.now()
        await fsp.rename(dest, backup)
      }
      await fsp.rename(stage, dest)
    } catch (err) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
      if (backup !== '') await fsp.rename(backup, dest).catch(() => {})
      throw err
    }
    const meta = indexEntryFromDisk(dest, written.get(id).map((name) => ({ name })))
    if (meta !== null) index.toolScripts[id] = meta
  }

  await writeIndex(dshHome, index)
  await fsp.mkdir(runsDir(dshHome), { recursive: true }).catch(() => {})

  return { dryRun: false, imported, overwritten, skipped }
}
