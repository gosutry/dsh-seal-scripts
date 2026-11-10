/**
 * 会话与会话级动作：state / delete / compact-delete / memory-context。
 * 装配 /state 的那一套也在这里（它是这份列表唯一的读者）。
 */

import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { memoryDir, readAssembly } from '../../core/store.js'
import { healthOf, harnessHealthOf } from '../../core/health.js'
import { effectiveCount, loadLevel, isLevelForced, dayIndex, describeLoad, describeEntry } from '../../core/assembly.js'
import { diaryReminder } from '../../core/diary.js'
import { readOptionsSync, REMINDER_SYSTEM } from '../../core/settings.js'
import { deleteSessionPermanently, sessionDirOf } from '../delete.js'
import { readDigest } from '../summary.js'
import { compactThenDelete } from '../compact-delete.js'
import { respond, readBody } from '../http-util.js'

const PREFIX = '/api/session-seal-scripts.'
const digestCache = new Map()

/** 会话 id 的短尾巴：标题读不出来时当占位。 */
function shortId(id) {
  const text = typeof id === 'string' ? id : String(id ?? '')
  return text.length > 8 ? text.slice(0, 8) : text
}

async function cachedDigest(dir) {
  const log = join(dir, 'session.v4.jsonl.zstd')
  let info
  try { info = await stat(log) } catch { return null }
  const key = dir + '|' + info.size + '|' + Math.round(info.mtimeMs)
  const hit = digestCache.get(key)
  if (hit !== undefined) return hit
  const value = readDigest(dir)
  if (digestCache.size > 300) digestCache.clear()
  digestCache.set(key, value)
  return value
}

/**
 * 装配 /state。
 * @param {object} deps
 * @param {string} dshHome
 * @param {{ok:boolean, missing:{block:string,why:string}[], table:object}|null} [snapshot]
 *        启动期能力探测的快照（档 3 E1）；没探过就是 null。
 */
export async function buildState(deps, dshHome, snapshot = null) {
  const options = readOptionsSync(dshHome)
  const persistence = deps.persistence
  if (persistence === undefined) throw new Error('会话持久化不可用')
  const root = persistence.config?.root
  if (typeof root !== 'string' || root === '') throw new Error('会话持久化没有存储根目录')
  // 子代理会话不列：它们的 cwd 与主会话相同，混进来只会是一堆同名行。
  const headers = (await persistence.list())
    .map((row) => row.header ?? row)
    .filter((header) => !(typeof header?.delegationDepth === 'number' && header.delegationDepth > 0))
  const archived = new Set(deps.workspaceRegistry?.archivedSessionIds ?? [])

  const byCwd = new Map()
  for (const header of headers) {
    const cwd = typeof header.cwd === 'string' ? header.cwd : '(无工作区)'
    if (!byCwd.has(cwd)) byCwd.set(cwd, [])
    byCwd.get(cwd).push(header)
  }

  const workspaces = []
  for (const [cwd, list] of byCwd) {
    const sessions = []
    for (const header of list) {
      const dir = sessionDirOf(root, header.cwd, header.id)
      const digest = await cachedDigest(dir)
      const title = (digest?.title ?? '').trim()
      // E3：读不出来 ≠ 空会话。没有 zstd / 解不开时不要显示「空会话」（那是假话），
      // 用 id 尾巴占位，并在列表顶部由 digestCode 触发一句说明。
      const digestCode = digest === null ? 'no-log' : (digest.ok === false ? digest.code : '')
      sessions.push({
        id: header.id,
        title: title || (digestCode === 'no-zstd' || digestCode === 'unreadable' ? shortId(header.id) : '空会话'),
        hasTitle: title !== '',
        digestCode,
        userMessages: digest?.userMessages ?? 0,
        createdAt: header.createdAt,
        cwd: header.cwd ?? null,
        archived: archived.has(header.id)
      })
    }
    sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

    // 只从载入文件算：以前这里为每份回顾整份 readFile，只为算几个界面从不显示的字段。
    let memories = []
    if (typeof cwd === 'string' && cwd !== '(无工作区)') {
      const dir = memoryDir(dshHome, cwd)
      const data = await readAssembly(dir, cwd)
      const now = new Date()
      const forced = isLevelForced(options)
      memories = data.entries
        .filter((entry) => entry && typeof entry.file === 'string' && typeof entry.compactedAt === 'string')
        .map((entry) => {
          // 级别每次现算：记号深度会跟着日期与选项一起变，不能缓存。
          const probe = { compactedAt: entry.compactedAt, count: entry.count, pinned: entry.pinned }
          return {
            file: entry.file,
            compactedAt: entry.compactedAt,
            count: entry.count,
            pinned: entry.pinned === true,
            level: loadLevel(probe, now, options),
            markedLevel: effectiveCount(probe, now, options),
            loadForced: forced,
            age: dayIndex(entry.compactedAt, now)
          }
        })
        .sort((a, b) => String(b.compactedAt).localeCompare(String(a.compactedAt)))
    }
    // health：拆回顾最近一次成功/失败（F6）。没有记录就是 null，界面不显示那一行。
    const health = typeof cwd === 'string' && cwd !== '(无工作区)' ? healthOf(dshHome, cwd) : null
    workspaces.push({ cwd, sessions, memories, health })
  }
  workspaces.sort((a, b) => a.cwd.localeCompare(b.cwd))
  return {
    workspaces,
    options,
    // 失败与降级只有一个入口：缺什么能力、本机能力表、宿主层面最近一次失败。
    // 拆回顾失败按工作区记在 workspaces[].health 里，这里只放宿主自己的那条。
    status: {
      ok: snapshot?.ok ?? true,
      missing: snapshot?.missing ?? [],
      capabilities: snapshot?.table ?? {},
      harness: harnessHealthOf(dshHome)
    }
  }
}

/**
 * @param {(path:string, handler:Function) => void} route
 * @param {{dshHome:string, getDeps:Function, waitForSplit?:Function, canLifecycle?:boolean, probe?:Function}} deps
 */
export function routesSessions(route, { dshHome, getDeps, waitForSplit, canLifecycle, probe }) {
  route(PREFIX + 'state', async (req, res) => {
    if (req.method !== 'GET') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET' } }); return }
    const snapshot = typeof probe === 'function' ? probe() : null
    const state = await buildState(getDeps(), dshHome, snapshot)
    // 顶层 capabilities 是档 3 的形状，设置页与档 3 的测试还在读它；新代码只读 status。
    if (snapshot !== null) state.capabilities = snapshot
    respond(res, 200, state)
  })

  route(PREFIX + 'delete', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    const result = await deleteSessionPermanently(getDeps(), body.sessionId)
    respond(res, result.status, result.ok ? { ok: true, deleted: result.deleted, warnings: result.warnings } : { error: result.error })
  })

  route(PREFIX + 'memory-context', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (typeof body.cwd !== 'string' || body.cwd === '') {
      respond(res, 400, { error: { code: 'invalid-body', message: '需要 cwd' } }); return
    }
    // 选项每一次现读：设置页改完立刻重新取，框里的内容与下一轮注入是同一套装配。
    const options = readOptionsSync(dshHome)
    const now = new Date()
    const disabled = options.injectEnabled === false
    // 带了 file 就只回这一条：设置页选中某条回顾时用它，不必拼整段。
    if (typeof body.file === 'string' && body.file !== '') {
      const one = describeEntry(dshHome, body.cwd, body.file, now, options)
      respond(res, 200, disabled
        ? { cwd: body.cwd, ...one, text: '', chars: 0, disabled: true }
        : { cwd: body.cwd, ...one })
      return
    }
    // 「在上下文提醒」档的提醒并进同一条消息，预览也得带上，否则框里比实况少一段。
    // 注入总开关关着时什么提醒都不算（0.2.8）。
    const reminder = disabled || options.reminderChannel === REMINDER_SYSTEM
      ? ''
      : diaryReminder(dshHome, body.cwd, now, options)
    respond(res, 200, describeLoad(dshHome, body.cwd, now, options, reminder))
  })

  route(PREFIX + 'compact-delete', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (canLifecycle === false) {
      respond(res, 503, { error: { code: 'host-capability', message: '本宿主缺 agents.create/resume，「删除并回顾」已关闭' } })
      return
    }
    try {
      const result = await compactThenDelete(getDeps(), dshHome, body.sessionId, waitForSplit)
      respond(res, 200, result)
    } catch (error) {
      respond(res, 400, { error: { code: 'compact-delete-failed', message: error?.message ?? String(error) } })
    }
  })
}
