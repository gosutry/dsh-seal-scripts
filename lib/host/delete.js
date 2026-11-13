/**
 * 真删一个会话：热删除 + 直接 rm -rf，不留 .sessions-trash。
 *
 * 顺序不能反：
 *   1. 活的先 cancel → whenIdle → flush → dispose handle
 *   2. 校验目录在 sessions 根之内，rm -rf
 *   3. workspace.detachSession，让它从列表里消失
 *
 * 先删文件再 detach：删失败时会话还在列表里，能重试；反过来会留幽灵。
 */

import { readdir, rm, lstat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { projectKey } from '../core/project-key.js'
import { ownedHandlesOf } from './lifecycle.js'

const IDLE_TIMEOUT_MS = 20_000
const PAYLOAD_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/

const deleting = new Set()

function encodeSegment(raw) {
  if (!raw) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

function inside(root, target) {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

const message = (e) => (e instanceof Error ? e.message : String(e))
const failure = (status, code, text) => ({ status, ok: false, error: { code, message: text } })

function withTimeout(promise, text) {
  return new Promise((yes, no) => {
    const timer = setTimeout(() => no(new Error(text)), IDLE_TIMEOUT_MS)
    Promise.resolve(promise).then((v) => { clearTimeout(timer); yes(v) }, (e) => { clearTimeout(timer); no(e) })
  })
}

/** 会话目录：sessions 根 / 工作区 key / 会话 id。 */
export function sessionDirOf(root, cwd, sessionId) {
  return join(resolve(root), cwd === undefined ? '_no-cwd' : projectKey(cwd), encodeSegment(sessionId))
}

/** 目录必须是真的目录、不是软链。 */
async function plainDirectory(dir) {
  const entry = await lstat(dir)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('not an owned session directory: ' + dir)
}

/**
 * 关掉活会话。拿不到公共句柄就拒绝，不猜。
 * @returns {Promise<{ok:true} | {ok:false, code:string, message:string}>}
 */
async function closeLive(deps, sessionId) {
  const live = deps.sessions?.get(sessionId)
  const agent = deps.agents?.get(sessionId)
  if (live === undefined && agent === undefined) return { ok: true }
  const handle = agent === undefined ? undefined : ownedHandlesOf(agent)
  if (handle === undefined || agent.session !== live || typeof agent.cancel !== 'function'
      || typeof agent.whenIdle !== 'function' || typeof deps.sessions?.flush !== 'function') {
    return { ok: false, code: 'session-busy', message: 'the live session has no public handle available; let its owner stop it first, then delete' }
  }
  try {
    agent.cancel({ kind: 'disposed' })
    await withTimeout(agent.whenIdle(), 'the agent did not become idle')
    if (await deps.sessions.flush(live) !== true) throw new Error('no persistence listener confirmed the flush')
    await withTimeout(handle.dispose(), 'the agent release did not finish')
    if (deps.agents.get(sessionId) !== undefined || deps.sessions.get(sessionId) !== undefined) {
      throw new Error('live references remain after release')
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, code: 'session-busy', message: 'cannot shut this session down: ' + message(error) + '; the original logs are kept' }
  }
}

/**
 * 真删一个会话。
 * @param {{persistence:object, sessions:object, agents:object, workspaceRegistry:object}} deps
 * @param {string} sessionId
 * @returns {Promise<{status:number, ok:boolean, deleted?:string, warnings?:string[], error?:object}>}
 */
export async function deleteSessionPermanently(deps, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return failure(400, 'invalid-session-id', 'sessionId must be a non-empty string')
  const root = deps.persistence?.config?.root
  if (typeof root !== 'string' || root === '') return failure(503, 'persistence-unavailable', 'session persistence has no storage root configured')
  if (deleting.has(sessionId)) return failure(409, 'session-busy', 'this session is already being deleted')
  deleting.add(sessionId)
  try {
    let header, workspaces
    try {
      const all = await deps.persistence.list()
      header = all.map((row) => row.header ?? row).find((h) => h.id === sessionId)
      workspaces = deps.workspaceRegistry === undefined ? [] : deps.workspaceRegistry.list()
      if (!Array.isArray(workspaces) || workspaces.some((row) => typeof row.detachSession !== 'function')) {
        throw new Error('workspace\'s public detachSession is unavailable')
      }
    } catch (error) {
      return failure(500, 'delete-lookup-failed', 'cannot find the session to delete: ' + message(error))
    }
    if (header === undefined) return failure(404, 'session-not-found', 'no such session: ' + sessionId)

    const closed = await closeLive(deps, sessionId)
    if (!closed.ok) return failure(409, closed.code, closed.message)

    const dir = sessionDirOf(root, header.cwd, sessionId)
    if (!inside(resolve(root), dir)) return failure(500, 'delete-failed', 'the session directory escaped the storage root')
    try {
      await plainDirectory(dir)
      const names = await readdir(dir)
      if (!names.some((n) => PAYLOAD_NAME.test(n))) throw new Error('no session log in the directory')
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      return failure(500, 'delete-failed', 'cannot delete the session log: ' + message(error))
    }

    const warnings = []
    for (const workspace of workspaces) {
      try { await workspace.detachSession(sessionId) }
      catch (error) { warnings.push('workspace ' + workspace.id + ' still holds this session: ' + message(error)) }
    }
    return { status: 200, ok: true, deleted: sessionId, ...(warnings.length ? { warnings } : {}) }
  } finally {
    deleting.delete(sessionId)
  }
}
