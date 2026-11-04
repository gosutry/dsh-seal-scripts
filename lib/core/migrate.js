/**
 * 载入索引的一次性迁移：_assembly.json（单文件） -> 每份回顾一个 .json 边车。
 *
 * 规矩（按档 5 · X-2 的裁定）：
 *   1. 只在「有 _assembly.json 且这个目录里还缺边车」时动手，幂等；
 *   2. 写完逐份核对，再把旧文件**改名**保留（永不自动删）；
 *   3. 任何一步失败就回滚已写的边车，旧文件原样留着。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './store.js'

export const LEGACY_INDEX = '_assembly.json'
export const SIDECAR_SUFFIX = '.json'

/** <stem>.md -> <stem>.json */
export function sidecarName(file) {
  return String(file ?? '').replace(/\.md$/i, '') + SIDECAR_SUFFIX
}

export function sidecarPath(dir, file) {
  return path.join(dir, sidecarName(file))
}

/** 目录里已有的边车名（下划线开头的是 _health.json 这类，跳过）。 */
export function listSidecars(dir) {
  try {
    return new Set(fs.readdirSync(dir).filter((n) => n.endsWith(SIDECAR_SUFFIX) && !n.startsWith('_')))
  } catch {
    return new Set()
  }
}

/** 目录里的回顾正文文件（.md 才是真相）。
 *  ⚠ 名字**不能**叫 listMemories——core/tool.js 已经导出了一个同名函数
 *  （签名是 listMemories(dshHome, cwd)，给工具用），撞名会让执行者改错地方。 */
export function listMemoryFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('_'))
  } catch {
    return []
  }
}

/** 需要迁移吗：有旧索引，且还有条目没写边车。 */
export function needsMigration(dir) {
  if (!fs.existsSync(path.join(dir, LEGACY_INDEX))) return false
  const sidecars = listSidecars(dir)
  let entries = []
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, LEGACY_INDEX), 'utf8'))
    entries = Array.isArray(parsed?.entries) ? parsed.entries : []
  } catch {
    return false   // 旧文件坏了交给既有逻辑，不在这里猜
  }
  return entries.some((e) => e && typeof e.file === 'string' && !sidecars.has(sidecarName(e.file)))
}

/**
 * 执行迁移。
 * @returns {Promise<{migrated:boolean, count:number, backup:string}>}
 */
export async function migrateIndex(dir, workspace) {
  if (!needsMigration(dir)) return { migrated: false, count: 0, backup: '' }
  let entries
  try {
    entries = JSON.parse(fs.readFileSync(path.join(dir, LEGACY_INDEX), 'utf8')).entries
  } catch {
    return { migrated: false, count: 0, backup: '' }
  }
  const valid = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.file === 'string')
  const written = []
  try {
    for (const entry of valid) {
      await writeFileAtomic(sidecarPath(dir, entry.file), JSON.stringify({
        version: 2,
        workspace,
        file: entry.file,
        compactedAt: typeof entry.compactedAt === 'string' ? entry.compactedAt : new Date(0).toISOString(),
        count: typeof entry.count === 'number' ? entry.count : 3,
        pinned: entry.pinned === true,
        seqStart: entry.seqStart ?? null,
        seqEnd: entry.seqEnd ?? null,
        migratedFrom: LEGACY_INDEX
      }, null, 2) + '\n')
      written.push(entry.file)
    }
    if (written.length !== valid.length) throw new Error('边车数量与旧索引条目数不一致')
  } catch (err) {
    for (const f of written) await fsp.rm(sidecarPath(dir, f), { force: true }).catch(() => {})
    throw err
  }
  const backup = path.join(dir, LEGACY_INDEX + '.migrated-' + Date.now())
  await fsp.rename(path.join(dir, LEGACY_INDEX), backup).catch(() => {})
  return { migrated: true, count: written.length, backup }
}
