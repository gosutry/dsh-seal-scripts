/**
 * 删除并回顾：先压缩、等拆出回顾、校验，通过了才删。
 *
 * 任何一步失败都不删，所以最坏情况是「压缩成功、拆失败、会话还在」——
 * 代价是 compactNow 已经改写了历史，这一步不可逆。
 *
 * 0.5.3 本地修复（三处，都是 0.2.2 web profile 的部署形状逼出来的）：
 *  1. 压缩后端按预设隔离：profile 根上下文没有 compaction，「delete」以前必抛。
 *     现在先问 agent 自己的上下文（预设插件是挂进 agent 作用域的）。
 *  2. 会话不在内存里时要 resume；裸 resume 不会挂预设插件，也不带模型，
 *     压缩会失败。优先走宿主自己的组合入口 sessionController.agents.resume()，
 *     它会把预设（含压缩）挂进 agent 作用域并装上模型选择。
 *  3. 每一步失败都留一行到 seal-scripts-data/_compact-delete.log，
 *     否则设置页只有一句英文，谁也看不出卡在哪。
 */

import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listMemories } from '../core/tool.js'
import { captureCompaction, memoryRoot } from '../core/store.js'
import { readLocaleSync } from '../core/locale.js'
import { deleteSessionPermanently } from './delete.js'

const TIMEOUT_MS = 120_000
const LOG_NAME = '_compact-delete.log'

/**
 * 找出会话里最新的一条压缩事件（0.5.3 本地修复）。
 *
 * 事件监听挂在 profile 根上，压缩却在预设的隔离作用域里发生——那边发出来的
 * session/event 未必传到根插件，于是「等拆解」会一直等到超时、什么都拆不出来。
 * 与其猜监听收不收得到，不如压缩完自己回会话里把那条事件捞出来，直接拆。
 * @param {object|undefined} session
 * @returns {object|undefined}
 */
function latestCompactionEvent(session) {
  try {
    const end = typeof session?.seq === 'number' ? session.seq : undefined
    if (end === undefined || typeof session.eventAt !== 'function') return undefined
    for (let seq = end - 1; seq >= 0 && seq > end - 2000; seq--) {
      const event = session.eventAt(seq)
      if (event?.type === 'compaction/summary') return event
    }
  } catch { /* 读不到就不拆，交给后面「没有新回顾」的报错 */ }
  return undefined
}

function withTimeout(promise, ms, text) {
  return new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(text)), ms)
    Promise.resolve(promise).then((v) => { clearTimeout(timer); yes(v) }, (e) => { clearTimeout(timer); no(e) })
  })
}

const message = (e) => (e instanceof Error ? e.message : String(e))

/** 一行诊断，失败也不遮住真正的报错。 */
async function note(dshHome, sessionId, text) {
  try {
    const dir = memoryRoot(dshHome)
    await mkdir(dir, { recursive: true })
    const file = join(dir, LOG_NAME)
    // 日志不能无限长：超过 256 KB 就只留最后 64 KB（按整行切）。
    try {
      const info = await stat(file)
      if (info.size > 256 * 1024) {
        const kept = (await readFile(file, 'utf8')).slice(-64 * 1024)
        const cut = kept.indexOf('\n')
        await writeFile(file, cut >= 0 ? kept.slice(cut + 1) : kept)
      }
    } catch { /* 文件还没有就算了 */ }
    await appendFile(file, new Date().toISOString() + ' ' + sessionId + ' ' + text + '\n')
  } catch { /* 诊断写不出来就算了 */ }
}

/** 关掉我们自己拉起来的 agent；宿主没钩子就用拿到的句柄。 */
async function release(agent, handle) {
  // 1) 插件自己抓到的句柄
  try { if (handle !== undefined) return await handle.dispose() } catch { /* 落到自造 */ }
  // 2) 没有句柄（例如经 sessionController 恢复的 agent）：自己造一把，和删除路径同一套
  try {
    if (typeof agent?.cancel === 'function' && typeof agent.whenIdle === 'function'
        && typeof agent.scope?.dispose === 'function') {
      agent.cancel({ kind: 'disposed' }, { keepInbox: true })
      await agent.whenIdle()
      await agent.scope.dispose()
    }
  } catch { /* 关不掉也不遮住真正的报错 */ }
}

/**
 * 找一个能用的压缩后端。宿主把它挂在预设作用域里，根上下文看不见。
 * @param {object} deps
 * @param {object|undefined} agent
 * @returns {{source:string, service:object}|null}
 */
function findCompaction(deps, agent) {
  const seen = []
  const tryOne = (source, service) => {
    const usable = typeof service?.compactNow === 'function'
    seen.push(source + (usable ? '' : '(no compactNow)'))
    return usable ? { source, service } : null
  }
  const found = tryOne('deps.compaction', deps.compaction)
    ?? tryOne('agent.ctx', agent?.ctx?.get?.('compaction'))
    ?? tryOne('agent.loopCtx', agent?.loopCtx?.get?.('compaction'))
  return found === null ? { seen } : found
}

/**
 * @param {object} deps 含 persistence / sessions / agents / workspaceRegistry / compaction / sessionController
 * @param {string} dshHome
 * @param {string} sessionId
 * @param {(id:string, ms:number) => Promise<object>} waitForSplit 等这一轮拆解落盘
 * @returns {Promise<{ok:true, deleted:string, memory:string}>}
 */
export async function compactThenDelete(deps, dshHome, sessionId, waitForSplit) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId must be a non-empty string')

  const header = (await deps.persistence.list()).map((r) => r.header ?? r).find((h) => h.id === sessionId)
  if (header === undefined) throw new Error('no such session: ' + sessionId)
  const cwd = header.cwd
  if (typeof cwd !== 'string' || cwd === '') throw new Error('this session has no workspace, so no review can be captured')

  const before = new Set((await listMemories(dshHome, cwd)).entries.map((e) => e.file))

  let handle
  let agent = deps.agents?.get(sessionId)
  if (agent === undefined) {
    // 宿主自己的组合入口：预设插件（含压缩）与模型选择都挂进 agent 作用域。
    const controller = deps.sessionController?.agents
    if (typeof controller?.resume === 'function') {
      try {
        agent = await controller.resume(sessionId)
        await note(dshHome, sessionId, 'resumed via sessionController')
      } catch (error) {
        await note(dshHome, sessionId, 'sessionController.resume failed: ' + message(error))
      }
    }
    if (agent === undefined || agent === null) {
      handle = await deps.agents.resume({ resumeSessionId: sessionId })
      agent = handle?.agent
      await note(dshHome, sessionId, 'resumed via agents.resume (bare, no preset mounted)')
      if (agent === undefined) throw new Error('failed to resume the session; cannot delete')
    }
  } else {
    await note(dshHome, sessionId, 'agent was already live')
  }

  // 压缩后端在预设的隔离作用域里，外面任何 ctx.get 都看不到。
  // 但预设里那份 command-compact 是挂在全局命令表上的：让它替我们调，
  // 它闭包里的 ctx 就在隔离作用域内，能看到 compaction。
  void waitForSplit // 不再依赖事件监听：压缩完自己拆（见 latestCompactionEvent）
  const controller = new AbortController()
  const commands = deps.commands

  let compacted = null
  let result = null
  if (typeof commands?.execute === 'function') {
    try {
      compacted = await withTimeout(
        Promise.resolve(commands.execute(agent, '/compact', [], controller.signal)),
        TIMEOUT_MS,
        'compaction timed out'
      )
    } catch (error) {
      controller.abort()
      await note(dshHome, sessionId, '/compact threw: ' + message(error))
      throw new Error('compaction failed, session not deleted: ' + message(error))
    }
    if (compacted === undefined) {
      await note(dshHome, sessionId, '/compact is not registered for this session')
      throw new Error('compaction is unavailable for this session (/compact is not registered), session not deleted')
    }
    const outcome = compacted.result ?? {}
    await note(dshHome, sessionId, '/compact -> ' + outcome.kind + ': ' + (outcome.text ?? ''))
    if (outcome.kind !== 'success') {
      throw new Error('compaction failed, session not deleted: ' + (outcome.text ?? 'unknown error'))
    }
    if (/no compactable history/i.test(outcome.text ?? '')) {
      throw new Error('no compactable history left, so there is nothing to review; use plain delete instead (session not deleted)')
    }
  } else {
    const found = findCompaction(deps, agent)
    if (found.service === undefined) {
      await note(dshHome, sessionId, 'no compaction backend; looked at: ' + (found.seen ?? []).join(', '))
      await release(agent, handle)
      throw new Error('the compaction service is unavailable; cannot delete (no compaction backend is reachable from this session)')
    }
    await note(dshHome, sessionId, 'compaction from ' + found.source)
    try {
      result = await withTimeout(
        Promise.resolve(found.service.compactNow(agent, controller.signal, 'session-seal-scripts-delete')),
        TIMEOUT_MS,
        'compaction timed out'
      )
    } catch (error) {
      controller.abort()
      await note(dshHome, sessionId, 'compactNow threw: ' + message(error))
      throw new Error('compaction failed, session not deleted: ' + message(error))
    }
    if (result === null) {
      await note(dshHome, sessionId, 'compactNow returned null (nothing to compact)')
      throw new Error('no compactable history left, so there is nothing to review; use plain delete instead (session not deleted)')
    }
  }
  await note(dshHome, sessionId, 'compaction finished')

  // 自己拆：会话里那条 compaction/summary 就是回顾的原料。
  const session = agent?.session
  const event = latestCompactionEvent(session)
  if (event === undefined) {
    await note(dshHome, sessionId, 'no compaction/summary event on the session after compaction')
  } else {
    try {
      const captured = await captureCompaction({ dshHome, cwd, session, event, lang: readLocaleSync(dshHome) })
      await note(dshHome, sessionId, captured?.file
        ? 'captured review ourselves: ' + captured.file
        : 'capture skipped: ' + (captured?.reason ?? 'no file'))
    } catch (error) {
      await note(dshHome, sessionId, 'self capture failed: ' + message(error))
    }
  }

  const after = await listMemories(dshHome, cwd)
  const fresh = after.entries.filter((e) => !before.has(e.file))
  if (fresh.length === 0) {
    await note(dshHome, sessionId, 'no new review file appeared')
    throw new Error('compaction finished but produced no new review, session not deleted (nothing was removed)')
  }

  const target = fresh[fresh.length - 1]
  const deleted = await deleteSessionPermanently(deps, sessionId)
  if (!deleted.ok) {
    await note(dshHome, sessionId, 'delete after review failed: ' + deleted.error.message)
    throw new Error('review was captured (' + target.file + ') but the delete failed: ' + deleted.error.message)
  }
  await note(dshHome, sessionId, 'deleted, review ' + target.file)
  return { ok: true, deleted: sessionId, memory: target.file }
}