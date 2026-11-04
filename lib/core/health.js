/**
 * 回顾管道的心跳：最近一次成功/失败。
 *
 * 为什么单独一个文件：拆回顾失败以前只落进日志，用户在界面上看到的是
 * 「一份看起来完全正常、只是不再增长的列表」——锁死了也不会有人知道。
 * 这份文件按 #工作区 key# 记账，只留最近一次，不增长。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { memoryRoot, writeFileAtomic } from './store.js'
import { projectKey } from './project-key.js'

const HEALTH_FILE = '_health.json'

export function healthPath(dshHome) {
  return path.join(memoryRoot(dshHome), HEALTH_FILE)
}

/** 同步读（注入路径要同步）；坏文件当空。 */
export function readHealthSync(dshHome) {
  try {
    const parsed = JSON.parse(fs.readFileSync(healthPath(dshHome), 'utf8'))
    return parsed && typeof parsed === 'object' && parsed.workspaces && typeof parsed.workspaces === 'object'
      ? parsed
      : { workspaces: {} }
  } catch {
    return { workspaces: {} }
  }
}

/**
 * 记一次结果。只留最近一次，写失败不影响主流程。
 * @param {string} dshHome
 * @param {string} cwd
 * @param {{ok:boolean, at?:number, code?:string, message?:string, file?:string}} event
 */
export async function recordHealth(dshHome, cwd, event) {
  try {
    const data = readHealthSync(dshHome)
    const key = projectKey(cwd)
    data.workspaces[key] = {
      workspace: cwd,
      ok: event.ok === true,
      at: Number(event.at) || Date.now(),
      code: event.ok === true ? '' : String(event.code ?? 'unknown'),
      message: event.ok === true ? '' : String(event.message ?? '').slice(0, 500),
      file: event.ok === true ? String(event.file ?? '') : ''
    }
    await fsp.mkdir(memoryRoot(dshHome), { recursive: true })
    await writeFileAtomic(healthPath(dshHome), JSON.stringify(data, null, 2) + '\n')
  } catch { /* 心跳写不进去，不能连累回顾本身 */ }
}

/** 宿主自己那条心跳记在哪个键下（index.js 用 '(harness)' 当工作区记账）。 */
const HARNESS = '(harness)'

/**
 * 宿主层面的最近一次失败（缺能力、卸载异常等）。
 *
 * 注意不能用字面量 '(harness)' 当键：记账走的是 projectKey()，
 * 键实际长得像 --~0028harness~0029--。
 */
export function harnessHealthOf(dshHome) {
  try { return readHealthSync(dshHome).workspaces?.[projectKey(HARNESS)] ?? null } catch { return null }
}

/** 设置页用：某个工作区最近一次结果；没有就是 null。 */
export function healthOf(dshHome, cwd) {
  const all = readHealthSync(dshHome).workspaces ?? {}
  try { return all[projectKey(cwd)] ?? null } catch { return null }
}
