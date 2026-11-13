/**
 * 清除缓存（0.5.1）：把工具组目录里不属于「工具本身」的两类东西删掉。
 *
 *   1. <id>.bak-<时间戳>/     覆盖安装 / 导入时留下的回滚版本
 *   2. _runs/ 里的所有东西     每次执行写下的 stdout / stderr / run.json
 *
 * 「工具本身」= _index.json 与每个 <id>/ 目录，一个都不碰：清完工具照常跑，
 * 索引也不重建（回滚目录与运行日志本来就不在索引里）。
 *
 * 三条保守规矩：
 *   - 回滚目录名必须形如 <合法 id>.bak-<纯数字>，别的一律不认（宁可少删）；
 *   - 删之前先量体积，删完能报「清掉了多少」；
 *   - 正在进行的导入会把包临时落在 _runs/import.tmp-*.zip，keepImportTmp 为真时跳过它，
 *     免得把别人手上的包删掉一半。
 * 单个条目删失败不中断整轮，记进 failed 一起回给界面。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { BUNDLE_ID_RE, runsDir, toolSequenceRoot } from './schema.js'

/** 回滚目录：<id>.bak-<毫秒时间戳>（installToolScript / 导入都这么起名）。 */
const BACKUP_RE = /^(.+)\.bak-(\d+)$/

/** 导入时落在 _runs/ 的临时包名（routes/tools.js 里生成）。 */
const IMPORT_TMP_RE = /^import\.tmp-\d+-\d+\.zip$/

/** 一句话错误正文，不带堆栈。 */
function messageOf(error) {
  return error && error.message ? String(error.message) : String(error)
}

/**
 * 递归量一个目录下的文件数与字节数（符号链接按 0 计，不跟进去）。
 * @param {string} dir
 * @returns {Promise<{files:number, bytes:number}>}
 */
async function sumTree(dir) {
  let files = 0
  let bytes = 0
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error && error.code === 'ENOENT') return { files, bytes }
    throw error
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = await sumTree(full)
      files += sub.files
      bytes += sub.bytes
    } else if (entry.isFile()) {
      try {
        const stat = await fsp.stat(full)
        files += 1
        bytes += stat.size
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
    }
  }
  return { files, bytes }
}

/**
 * 删掉回滚版本与运行日志。
 * @param {{dshHome:string, keepImportTmp?:boolean}} input
 * @returns {Promise<{backups:{count:number,files:number,bytes:number,names:string[]}, runs:{dir:string,files:number,bytes:number,skipped:string[]}, total:{count:number,bytes:number}, failed:{name:string,message:string}[]}>}
 */
export async function clearToolCaches({ dshHome, keepImportTmp = false } = {}) {
  const root = toolSequenceRoot(dshHome)
  const failed = []

  // ── 回滚版本 ──────────────────────────────────────────────
  let rootEntries = []
  try {
    rootEntries = await fsp.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  const backupNames = []
  let backupFiles = 0
  let backupBytes = 0
  for (const entry of rootEntries) {
    if (!entry.isDirectory()) continue
    const matched = BACKUP_RE.exec(entry.name)
    if (!matched || !BUNDLE_ID_RE.test(matched[1])) continue
    const full = path.join(root, entry.name)
    try {
      const stats = await sumTree(full)
      await fsp.rm(full, { recursive: true, force: true })
      backupNames.push(entry.name)
      backupFiles += stats.files
      backupBytes += stats.bytes
    } catch (error) {
      failed.push({ name: entry.name, message: messageOf(error) })
    }
  }

  // ── 运行日志 ──────────────────────────────────────────────
  const runsPath = runsDir(dshHome)
  const runs = { dir: runsPath, files: 0, bytes: 0, skipped: [] }
  let runEntries = []
  try {
    runEntries = await fsp.readdir(runsPath, { withFileTypes: true })
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
  for (const entry of runEntries) {
    if (keepImportTmp && entry.isFile() && IMPORT_TMP_RE.test(entry.name)) {
      runs.skipped.push(entry.name)
      continue
    }
    const full = path.join(runsPath, entry.name)
    try {
      const stats = entry.isDirectory() ? await sumTree(full) : { files: 1, bytes: (await fsp.stat(full)).size }
      await fsp.rm(full, { recursive: true, force: true })
      runs.files += stats.files
      runs.bytes += stats.bytes
    } catch (error) {
      failed.push({ name: path.join('_runs', entry.name), message: messageOf(error) })
    }
  }

  return {
    backups: { count: backupNames.length, files: backupFiles, bytes: backupBytes, names: backupNames },
    runs,
    total: { count: backupNames.length + runs.files, bytes: backupBytes + runs.bytes },
    failed
  }
}
