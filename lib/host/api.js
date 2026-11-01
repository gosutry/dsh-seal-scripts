/**
 * 给设置页用的 HTTP 端点。
 */

import { join, relative, isAbsolute, basename } from 'node:path'
import { stat, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { memoryDir, readAssembly, writeAssembly } from '../core/store.js'
import { parseMemory, setField, setSection } from '../core/memory-file.js'
import { readField, parseToolCounts } from '../core/lang.js'
import { effectiveCount, loadLevel, isLevelForced, dayIndex, describeLoad, describeEntry } from '../core/assembly.js'
import { diaryReminder } from '../core/diary.js'
import { readOptionsSync, writeOptions, REMINDER_SYSTEM } from '../core/settings.js'
import { readLocaleSync, writeLocale } from '../core/locale.js'
import { dialogueOnly } from '../core/render.js'
import { catalogText, toolSequenceRoot } from '../core/schema.js'
import { deleteSessionPermanently, sessionDirOf } from './delete.js'
import { readDigest } from './summary.js'
import { compactThenDelete } from './compact-delete.js'
import { respond, sameOrigin, readBody } from './http-util.js'

const PREFIX = '/api/session-recall.'
const digestCache = new Map()

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

async function buildState(deps, dshHome) {
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
      sessions.push({
        id: header.id,
        title: title || '空会话',
        hasTitle: title !== '',
        userMessages: digest?.userMessages ?? 0,
        createdAt: header.createdAt,
        cwd: header.cwd ?? null,
        archived: archived.has(header.id)
      })
    }
    sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))

    let memories = []
    if (typeof cwd === 'string' && cwd !== '(无工作区)') {
      const dir = memoryDir(dshHome, cwd)
      const data = await readAssembly(dir, cwd)
      const now = new Date()
      const forced = isLevelForced(options)
      const rows = []
      for (const entry of data.entries) {
        const meta = await readMemoryMeta(dir, entry)
        if (meta === null) continue
        // 级别每次现算：metaCache 按文件内容缓存，逐文件算好的级别会跟着选项一起过期。
        const probe = { compactedAt: meta.compactedAt, count: meta.count, pinned: meta.pinned }
        rows.push({
          ...meta,
          level: loadLevel(probe, now, options),
          markedLevel: effectiveCount(probe, now, options),
          loadForced: forced,
          age: dayIndex(meta.compactedAt, now)
        })
      }
      memories = rows.sort((a, b) => b.compactedAt.localeCompare(a.compactedAt))
    }
    workspaces.push({ cwd, sessions, memories })
  }
  workspaces.sort((a, b) => a.cwd.localeCompare(b.cwd))
  return { workspaces, options }
}

const metaCache = new Map()

/** 回顾的列表元数据：日期、关键词、对话条数、工具次数与失败数。 */
async function readMemoryMeta(dir, entry) {
  const abs = join(dir, entry.file)
  let info
  try { info = await stat(abs) } catch { return null }
  const key = entry.file + '|' + info.size + '|' + Math.round(info.mtimeMs)
  const hit = metaCache.get(key)
  if (hit !== undefined) return hit
  const text = await readFile(abs, 'utf8')
  const parsed = parseMemory(text)
  const body = parsed.sections.body ?? ''
  // 正文里的对话行按中文标记数（老文件），英文文件里是 [user]/[model]。
  let dialogue = 0
  for (const line of body.split('\n')) {
    if (line.startsWith('[用户] ') || line.startsWith('[模型] ') ||
      line.startsWith('[user] ') || line.startsWith('[model] ')) dialogue++
  }
  const tools = parseToolCounts(readField(parsed.meta, 'toolCalls'))
  const value = {
    file: entry.file,
    compactedAt: entry.compactedAt,
    date: entry.compactedAt.slice(0, 10),
    keywords: readField(parsed.meta, 'keywords'),
    dialogue,
    toolCalls: tools.calls,
    toolFailures: tools.failures,
    count: entry.count,
    pinned: entry.pinned === true
  }
  if (metaCache.size > 500) metaCache.clear()
  metaCache.set(key, value)
  return value
}

/** 删掉一条回顾：先删文件，再从载入文件里摘掉条目。路径必须在回顾目录内。 */
async function deleteMemory(dshHome, cwd, file) {
  const dir = memoryDir(dshHome, cwd)
  const raw = String(file ?? '')
  if (raw.trim() === '') throw new Error('file 不能为空')
  if (!raw.endsWith('.md')) throw new Error('不是回顾文件：' + raw)
  const abs = isAbsolute(raw) ? join(raw) : join(dir, raw)
  const rel = relative(dir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error('只能删本工作区的回顾：' + raw)
  const exists = await stat(abs).then(() => true, () => false)
  if (!exists) throw new Error('这份回顾不存在：' + raw)
  await rm(abs, { force: true })
  const data = await readAssembly(dir, cwd)
  const before = data.entries.length
  data.entries = data.entries.filter((e) => e.file !== basename(abs))
  if (data.entries.length !== before) {
    data.workspace = cwd
    await writeAssembly(dir, data)
  }
  return { ok: true, file: basename(abs), removed: before - data.entries.length }
}

async function readMemory(dshHome, cwd, file) {
  const dir = memoryDir(dshHome, cwd)
  const text = await readFile(join(dir, file), 'utf8')
  const parsed = parseMemory(text)
  return { file, meta: parsed.meta, sections: parsed.sections, dialogue: dialogueOnly(parsed.sections.body ?? '') }
}

export function registerApi(webCtx, { dshHome, getDeps, waitForSplit }) {
  const route = (path, handler) => webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        const rejection = webCtx.connection?.requestRejection?.(req)
        if (rejection !== undefined) {
          respond(res, rejection, { error: { code: 'access-denied', message: '需要先登录' } })
          return
        }
        if (!sameOrigin(req)) {
          respond(res, 403, { error: { code: 'cross-origin', message: '拒绝跨域请求' } })
          return
        }
        await handler(req, res)
      } catch (error) {
        respond(res, 500, { error: { code: 'internal', message: error?.message ?? String(error) } })
      }
    }
  }), 'dsh-session-recall: ' + path)

  route(PREFIX + 'state', async (req, res) => {
    if (req.method !== 'GET') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET' } }); return }
    respond(res, 200, await buildState(getDeps(), dshHome))
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

  route(PREFIX + 'options', async (req, res) => {
    if (req.method === 'GET') {
      respond(res, 200, { options: readOptionsSync(dshHome) })
      return
    }
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET / POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    // 收紧在 writeOptions 里做：「停止降低」开启时载入数值一律回退到跟随深度。
    respond(res, 200, { options: await writeOptions(dshHome, body) })
  })

  // 「自创工具」页（0.3.1）：工具组清单要注入的那一段原文。
  // 和装配时用的是同一个 catalogText，所以框里看到的就是真的会进系统提示词的那几行。
  // 0.3.10 起再带上工具组目录：设置页在清单标题下面显示「工具路径」，
  // 就是 session_tool_call 去取脚本的那个目录（模型/人都能照着去翻）。
  route(PREFIX + 'toolSequence', async (req, res) => {
    if (req.method !== 'GET') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET' } }); return }
    const options = readOptionsSync(dshHome)
    const text = catalogText(dshHome, readLocaleSync(dshHome))
    respond(res, 200, {
      enabled: options.toolListEnabled !== false,
      path: toolSequenceRoot(dshHome),
      text,
      bytes: Buffer.byteLength(text, 'utf8')
    })
  })

  // 语言：设置页那一半读 DSH 的 locale 服务，每次切换就记到这里；注入这一半只读这个文件。
  route(PREFIX + 'locale', async (req, res) => {
    if (req.method === 'GET') {
      respond(res, 200, { locale: readLocaleSync(dshHome) })
      return
    }
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET / POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    respond(res, 200, { locale: await writeLocale(dshHome, body.locale) })
  })

  route(PREFIX + 'memory-delete', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (typeof body.cwd !== 'string' || typeof body.file !== 'string') {
      respond(res, 400, { error: { code: 'invalid-body', message: '需要 cwd 与 file' } }); return
    }
    respond(res, 200, await deleteMemory(dshHome, body.cwd, body.file))
  })

  route(PREFIX + 'memory', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (typeof body.cwd !== 'string' || typeof body.file !== 'string') {
      respond(res, 400, { error: { code: 'invalid-body', message: '需要 cwd 与 file' } }); return
    }
    respond(res, 200, await readMemory(dshHome, body.cwd, body.file))
  })

  route(PREFIX + 'annotate', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    const dir = memoryDir(dshHome, body.cwd)
    const abs = join(dir, body.file)
    let next = await readFile(abs, 'utf8')
    if (Array.isArray(body.keywords)) next = setField(next, 'keywords', body.keywords.join(' · ')) ?? next
    if (typeof body.diary === 'string') next = setSection(next, 'diary', body.diary) ?? next
    const check = parseMemory(next)
    if (!check.id) { respond(res, 500, { error: { code: 'bad-memory', message: '改完解析失败' } }); return }
    const tmp = abs + '.tmp-' + process.pid
    await writeFile(tmp, next, 'utf8')
    await rename(tmp, abs)
    respond(res, 200, { ok: true })
  })

  route(PREFIX + 'compact-delete', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    try {
      const result = await compactThenDelete(getDeps(), dshHome, body.sessionId, waitForSplit)
      respond(res, 200, result)
    } catch (error) {
      respond(res, 400, { error: { code: 'compact-delete-failed', message: error?.message ?? String(error) } })
    }
  })
}
