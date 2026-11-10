/**
 * 删除并回顾：先压缩、等拆出回顾、校验，通过了才删。
 *
 * 任何一步失败都不删，所以最坏情况是「压缩成功、拆失败、会话还在」——
 * 代价是 compactNow 已经改写了历史，这一步不可逆。
 */

import { listMemories } from '../core/tool.js'
import { deleteSessionPermanently } from './delete.js'

const TIMEOUT_MS = 120_000

function withTimeout(promise, ms, text) {
  return new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(text)), ms)
    Promise.resolve(promise).then((v) => { clearTimeout(timer); yes(v) }, (e) => { clearTimeout(timer); no(e) })
  })
}

/**
 * @param {object} deps 含 persistence / sessions / agents / workspaceRegistry / compaction
 * @param {string} dshHome
 * @param {string} sessionId
 * @param {(id:string, ms:number) => Promise<object>} waitForSplit 等这一轮拆解落盘
 * @returns {Promise<{ok:true, deleted:string, memory:string}>}
 */
export async function compactThenDelete(deps, dshHome, sessionId, waitForSplit) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId 必须是非空字符串')
  if (deps.compaction === undefined) throw new Error('压缩服务不可用，删不了')

  const header = (await deps.persistence.list()).map((r) => r.header ?? r).find((h) => h.id === sessionId)
  if (header === undefined) throw new Error('没有这个会话：' + sessionId)
  const cwd = header.cwd
  if (typeof cwd !== 'string' || cwd === '') throw new Error('这个会话没有工作区，拆不出回顾')

  const before = new Set((await listMemories(dshHome, cwd)).entries.map((e) => e.file))

  let handle
  let agent = deps.agents?.get(sessionId)
  if (agent === undefined) {
    handle = await deps.agents.resume({ resumeSessionId: sessionId })
    agent = handle?.agent
    if (agent === undefined) throw new Error('恢复会话失败，删不了')
  }

  const controller = new AbortController()
  const waiting = waitForSplit(sessionId, TIMEOUT_MS)

  let result
  try {
    result = await withTimeout(
      Promise.resolve(deps.compaction.compactNow(agent, controller.signal, 'session-seal-scripts-delete')),
      TIMEOUT_MS,
      '压缩超时'
    )
  } catch (error) {
    controller.abort()
    throw new Error('压缩失败，会话未删除：' + (error?.message ?? error))
  }
  if (result === null) throw new Error('没有可压缩的历史，会话未删除')

  try {
    await waiting
  } catch (error) {
    throw new Error('等拆回顾失败，会话未删除：' + (error?.message ?? error))
  }

  const after = await listMemories(dshHome, cwd)
  const fresh = after.entries.filter((e) => !before.has(e.file))
  if (fresh.length === 0) throw new Error('压缩完成但没有产生新回顾，会话未删除')

  const target = fresh[fresh.length - 1]
  const deleted = await deleteSessionPermanently(deps, sessionId)
  if (!deleted.ok) throw new Error('回顾已拆出（' + target.file + '），但删除失败：' + deleted.error.message)
  return { ok: true, deleted: sessionId, memory: target.file }
}
