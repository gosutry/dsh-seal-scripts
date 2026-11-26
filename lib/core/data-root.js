/**
 * 插件数据根：0.6.3 起由 session-memory 改名为 seal-scripts-data。
 *
 * 迁移规矩（只做一次，幂等）：
 *   1. 新目录不存在、旧目录存在 → 同父目录下原子 rename（不复制、不留副本）；
 *   2. 新旧都存在 → 只读新目录，旧目录原样不动（可能是旧版本/另一实例留下的）；
 *   3. rename 失败（权限、挂载点、目标被占）→ 继续读旧目录，绝不新建一个空的新目录；
 *   4. 迁完在新目录写 _migrated.json（从哪来、何时、哪个版本）；写不进去不撤销迁移。
 *
 * 解析路径统一走 dataRoot()。迁移只在宿主插件启动、任何读写之前调用一次。
 */
import fs from 'node:fs'
import path from 'node:path'

export const DATA_DIR = 'seal-scripts-data'
export const LEGACY_DIR = 'session-memory'
export const MIGRATED_MARKER = '_migrated.json'

function isDir(p) {
  try { return fs.statSync(p).isDirectory() } catch (err) { return false }
}

/** 新名字的绝对路径。 */
export function newRoot(dshHome) {
  return path.join(String(dshHome), DATA_DIR)
}

/** 旧名字的绝对路径（只用于迁移来源与兜底读取）。 */
export function legacyRoot(dshHome) {
  return path.join(String(dshHome), LEGACY_DIR)
}

/**
 * 当前该用的根目录：
 * 新目录优先；否则旧目录（尚未迁移或迁移失败）；都没有时返回新路径（由调用方负责 mkdir）。
 * @param {string} dshHome
 * @returns {string}
 */
export function dataRoot(dshHome) {
  const next = newRoot(dshHome)
  if (isDir(next)) return next
  const old = legacyRoot(dshHome)
  if (isDir(old)) return old
  return next
}

/** 插件版本，写进迁移标记；读不到就空串。 */
function pluginVersion() {
  try {
    const raw = fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    return String(JSON.parse(raw).version || '')
  } catch (err) {
    return ''
  }
}

/**
 * 启动迁移：旧目录 → 新目录。同步、幂等、不改写旧数据内容。
 * @param {string} dshHome
 * @returns {{migrated:boolean, reason:string, root:string}}
 */
export function migrateDataRoot(dshHome) {
  const next = newRoot(dshHome)
  const old = legacyRoot(dshHome)
  const hasNew = isDir(next)
  const hasOld = isDir(old)
  if (!hasOld) return { migrated: false, reason: hasNew ? 'new-exists' : 'none', root: hasNew ? next : next }
  if (hasNew) return { migrated: false, reason: 'both-exist', root: next }
  try {
    fs.renameSync(old, next)
  } catch (err) {
    const code = err && err.code ? err.code : String(err && err.message ? err.message : err)
    return { migrated: false, reason: 'rename-failed: ' + code, root: old }
  }
  try {
    fs.writeFileSync(path.join(next, MIGRATED_MARKER), JSON.stringify({
      version: 1,
      from: LEGACY_DIR,
      to: DATA_DIR,
      at: new Date().toISOString(),
      pluginVersion: pluginVersion()
    }, null, 2) + '\n')
  } catch (err) { /* 标记只是记录；写不进去不影响数据 */ }
  return { migrated: true, reason: 'renamed', root: next }
}
