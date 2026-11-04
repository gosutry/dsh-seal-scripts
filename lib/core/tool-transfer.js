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
import {
  BUNDLE_ID_RE, INDEX_FILE, RUNS_DIR, TOOL_SCRIPT_FILE,
  assertToolScriptId, readIndex, runsDir, sha256OfFile, toolScriptDir, toolSequenceRoot, writeIndex
} from './schema.js'
import { buildZip, readZip, safeEntryName } from './zip.js'

/** 导出包的名字（用户要的就是这个名字）。 */
export const EXPORT_NAME = 'toolSequence.zip'

/** 导出包上限：再大就不该塞进一个 HTTP 响应里了（先判后写，绝不写出去再报错）。 */
export const MAX_EXPORT_BYTES = 24 * 1024 * 1024

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
    out.push({ name, data: await fsp.readFile(abs), mtime: stat.mtime })
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
  if (target === '') throw new Error('没有指定要导出到哪个工作区文件夹')
  if (!path.isAbsolute(target)) throw new Error('工作区目录要是绝对路径：' + target)
  let st
  try { st = await fsp.stat(target) } catch { throw new Error('工作区目录不存在：' + target) }
  if (!st.isDirectory()) throw new Error('这不是一个目录：' + target)
  if (path.parse(target).root === target) throw new Error('不往磁盘根目录写：' + target)

  const root = toolSequenceRoot(dshHome)
  const entries = []
  await collect(root, '', entries)
  const buffer = buildZip(entries)
  const files = entries.filter((e) => !String(e.name).endsWith('/'))
  // 先判大小再动磁盘：超限了连临时文件都不留。
  if (buffer.length > MAX_EXPORT_BYTES) {
    throw new Error('工具组目录太大（' + buffer.length + ' 字节），超过导出上限 ' + MAX_EXPORT_BYTES + ' 字节')
  }
  const file = path.join(target, EXPORT_NAME)
  const overwritten = fs.existsSync(file)
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  await fsp.writeFile(tmp, buffer)
  await fsp.rename(tmp, file)
  return { name: EXPORT_NAME, file, dir: target, size: buffer.length, files: files.length, dirs: entries.length - files.length, overwritten }
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
    timeoutMs: Number.isFinite(Number(manifest.timeoutMs)) ? Number(manifest.timeoutMs) : 120000,
    updatedAt: new Date().toISOString(),
    hashes
  }
}

/**
 * 手工把 toolSequence 文件夹压成包时，包里面会多一层 toolSequence/。
 * 只有「所有条目都在这一个顶层目录下、而且它就叫 toolSequence」时才剥——
 * 别的单层目录不猜，免得把某个 id 名字当壳剥掉。
 * @param {Array<{name:string}>} entries
 * @returns {Array<{name:string}>}
 */
function stripWrapperDir(entries) {
  const tops = new Set()
  for (const entry of entries) {
    const parts = String(entry.name).split('/').filter((x) => x !== '')
    if (parts.length === 0) continue
    tops.add(parts[0])
    if (tops.size > 1) return entries
  }
  if (tops.size !== 1) return entries
  const only = [...tops][0]
  if (only.toLowerCase() !== 'toolsequence') return entries
  const cut = only.length + 1
  const out = []
  for (const entry of entries) {
    const name = String(entry.name)
    if (name === only || name === only + '/') continue
    out.push(Object.assign({}, entry, { name: name.slice(cut) }))
  }
  return out
}

/**
 *
 * dryRun：只解析，不写盘——设置页先用它把「会装哪些、会盖哪些」念给用户听，点了确认才真装。
 *
 * @param {{dshHome:string, buffer:Buffer, dryRun?:boolean}} p
 * @returns {Promise<{dryRun:boolean, imported:Array<{id:string,files:string[]}>, overwritten:string[], skipped:Array<{name:string,reason:string}>}>}
 */
export async function importToolSequence({ dshHome, buffer, dryRun = false }) {
  const root = toolSequenceRoot(dshHome)
  const entries = readZip(buffer)
  const stripped = stripWrapperDir(entries)

  /** @type {Map<string, Array<{rel:string, data:Buffer}>>} */
  const byId = new Map()
  const skipped = []
  for (const entry of stripped) {
    if (entry.isDir) continue
    let safe
    try { safe = safeEntryName(entry.name) } catch (err) { skipped.push({ name: entry.name, reason: String(err.message || err) }); continue }
    const parts = safe.split('/')
    const top = parts[0]
    if (parts.length === 1 && top === INDEX_FILE) {
      skipped.push({ name: entry.name, reason: '本机索引按落地后的文件重建，包里的 _index.json 不采信' })
      continue
    }
    if (parts.length < 2) { skipped.push({ name: entry.name, reason: '不在任何工具脚本目录里' }); continue }
    if (top === RUNS_DIR) { skipped.push({ name: entry.name, reason: '运行溢写目录，不收' }); continue }
    if (!BUNDLE_ID_RE.test(top)) { skipped.push({ name: entry.name, reason: '目录名不是合法的工具脚本 id' }); continue }
    if (isTransientName(parts[1])) { skipped.push({ name: entry.name, reason: '备份/临时目录，不收' }); continue }
    const list = byId.get(top) || []
    list.push({ rel: parts.slice(1).join('/'), data: entry.data })
    byId.set(top, list)
  }

  if (byId.size === 0) {
    const why = skipped.length > 0 ? ('（' + skipped.slice(0, 3).map((s) => s.name + '：' + s.reason).join('；') + '）') : ''
    throw new Error('这个包里没有工具脚本目录' + why)
  }

  const index = await readIndex(dshHome)
  const imported = []
  const overwritten = []

  if (dryRun !== true) await fsp.mkdir(root, { recursive: true })

  for (const [rawId, files] of byId) {
    const id = assertToolScriptId(rawId)
    const dest = toolScriptDir(dshHome, id)
    const exists = fs.existsSync(dest)
    if (exists) overwritten.push(id)
    imported.push({ id, files: files.map((f) => f.rel) })
    if (dryRun === true) continue

    const stage = path.join(root, id + '.tmp-import-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
    await fsp.rm(stage, { recursive: true, force: true })
    await fsp.mkdir(stage, { recursive: true })
    try {
      for (const file of files) {
        const target = path.join(stage, file.rel)
        const rel = path.relative(stage, target)
        if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
          throw new Error('越界路径：' + file.rel)
        }
        await fsp.mkdir(path.dirname(target), { recursive: true })
        await fsp.writeFile(target, file.data)
      }
    } catch (err) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
      throw err
    }

    let backup = ''
    try {
      if (exists) {
        backup = dest + '.bak-' + Date.now()
        await fsp.rename(dest, backup)
      }
      await fsp.rename(stage, dest)
    } catch (err) {
      await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
      if (backup !== '') await fsp.rename(backup, dest).catch(() => {})
      throw err
    }

    const meta = indexEntryFromDisk(dest, files.map((f) => ({ name: f.rel, size: f.data.length })))
    if (meta !== null) index.toolScripts[id] = meta
  }

  if (dryRun !== true && imported.length > 0) {
    await writeIndex(dshHome, index)
    await fsp.mkdir(runsDir(dshHome), { recursive: true }).catch(() => {})
  }

  return { dryRun: dryRun === true, imported, overwritten, skipped }
}
