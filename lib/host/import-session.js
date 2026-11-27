/**
 * 会话导入（0.6.1）：把 DSH 导出的 dsh-session-<id>.zip 装进本机，
 * 不重启，会话立刻可开，图片与文件都能显示。
 *
 * 格式来源（实测）：导出包是**未压缩的 JSONL**（session.v4.jsonl，第一行是户口本），
 * 落盘要转成 zstd：**首帧只装户口本一行**（DSH 有硬断言），正文一帧，两帧都在行边界结束。
 * 图片在包里叫 media/sha256:<哈希>.<后缀>，只落附件库一处：
 *   attachments/v1/objects/<前2>/<哈希>   （全局附件库，纯哈希；DSH 只读这一处）
 * 文件在包里叫 files/<前2>/<哈希>/<原名>：本体进 file-objects/<前2>/<哈希>，
 * 再用链接给它一个 files/<前2>/<哈希>/<原名> 的别名（一份字节，两个名字）。
 *
 * 0.6.4：只写 DSH 真正会读的。会话目录里的 media/ 副本不写（DSH 从不读）；
 * 会话卡片（projcache）不写（那是缓存，DSH 第一次打开会照日志重建）；
 * 工作区里那份「会话导入备份-<时间>/」也不再写（DSH 不用，导入也不覆盖别人的会话）。
 *
 * 撞号两条（交接文件实测）：同一 id 出现在两个格子、或户口本 cwd 与格子不符，
 * 都会让会话列表整份 500。所以同 id 在别的 cwd 时一律换新 id，绝不覆盖别人的会话。
 *
 * 只依赖 node 内置模块与仓库里的 zip / projectKey。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { createHash, randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { projectKey } from '../core/project-key.js'
import { forEachZipEntry, readZipCentralFromFile } from '../core/zip.js'

export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'

/** 宿主能不能写 zstd（Node 22.15+）。导入必须能写，否则拒绝并说清楚。 */
export function canWriteZstd() {
  return typeof zlib.zstdCompressSync === 'function' && typeof zlib.createZstdCompress === 'function'
}

const ROOT_LOG = /^session(?:\.v[1-9][0-9]*)?\.jsonl$/
const SUB_LOG = /^subagents\/([^/]+)\/session(?:\.v[1-9][0-9]*)?\.jsonl$/
const MEDIA_NAME = /^media\/sha256:([a-f0-9]{64})\.([A-Za-z0-9]+)$/
const FILE_NAME = /^files\/([0-9a-f]{2})\/([a-f0-9]{64})\/(.+)$/

const message = (e) => (e instanceof Error ? e.message : String(e))

/** 一条 zip 条目的内容向量：只流一次，边写边算 sha256。 */
async function streamEntryToFile(entry, file) {
  const handle = await fsp.open(file, 'w')
  const digest = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of entry.read()) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      digest.update(buf)
      await handle.write(buf)
      bytes += buf.length
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return { bytes, sha256: digest.digest('hex') }
}

/** 读一个文件的前一行（以 \n 结尾）；包里的户口本就这一行。 */
async function firstLineOf(file, limit = 4 * 1024 * 1024) {
  const handle = await fsp.open(file, 'r')
  try {
    const chunks = []
    let total = 0
    while (total < limit) {
      const buf = Buffer.allocUnsafe(64 * 1024)
      const { bytesRead } = await handle.read(buf, 0, buf.length, total)
      if (bytesRead <= 0) break
      const hit = buf.subarray(0, bytesRead).indexOf(0x0a)
      if (hit >= 0) { chunks.push(buf.subarray(0, hit + 1)); return Buffer.concat(chunks) }
      chunks.push(buf.subarray(0, bytesRead))
      total += bytesRead
    }
    throw new Error('the exported log has no complete header line')
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 把一份 JSONL 文本文件压成 DSH 认的 zstd 日志：首帧恰好一行，正文第二帧。
 * 走流式：日志多大都不把整份读进内存。
 */
async function packLog(srcFile, destFile) {
  const head = await firstLineOf(srcFile)
  if (head.length < 2 || head[head.length - 1] !== 0x0a) throw new Error('the exported log header line is malformed')
  const opts = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }
  const out = await fsp.open(destFile, 'w')
  try {
    await out.write(zlib.zstdCompressSync(head, opts))
    // 正文帧：从户口本之后的位置开始流式压。空正文也给一帧（合法空帧）。
    const rest = fs.createReadStream(srcFile, { start: head.length, highWaterMark: 1 << 20 })
    const zs = zlib.createZstdCompress(opts)
    rest.pipe(zs)
    for await (const chunk of zs) await out.write(chunk)
  } finally {
    await out.close().catch(() => {})
  }
}

/**
 * 前端左侧列表的条目形状（照 dsh-api-session-controller 的 summarizeCold）。
 * 导入只落盘、不建 Session 对象，拿不到 live summary，就按冷会话如实拼一份。
 */
function coldSummary(header) {
  return {
    sessionId: header.id,
    updatedAt: Math.max(Number(header.createdAt) || 0, 0),
    agentAvailable: false,
    formatStatus: 'current',
    running: false,
    blank: false,
    ...(header.parentSession === void 0 ? {} : { parentSessionId: header.parentSession }),
    ...(header.origin === void 0 ? {} : { origin: header.origin }),
    ...(header.cwd === void 0 ? {} : { cwd: header.cwd })
  }
}

/**
 * 种子会话的继承切点：事件流里最后一个 session/end-seed（data.inherited === true）的 seq。
 * DSH 校验要求 seeded 会话的这个值与标记位置严格相等，否则整条会话打不开。
 * @returns 切点 seq；不是种子会话时返回 -1。
 */
async function scanInheritedCut(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let last = -1
  let index = -1
  try {
    for await (const line of rl) {
      index += 1
      if (index === 0) continue // 第一行是户口本
      if (line.indexOf('"session/end-seed"') < 0) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type === 'session/end-seed' && event.data?.inherited === true) {
        last = typeof event.seq === 'number' ? event.seq : index - 1
      }
    }
  } finally {
    rl.close()
  }
  return last
}

function isFile(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

async function existsDir(dir) {
  try { return (await fsp.stat(dir)).isDirectory() } catch { return false }
}

/** 落一个图片：只进全局附件库 objects/<前2>/<哈希>，不往会话目录写副本。 */
async function saveMedia(entry, { hash, attachRoot }) {
  const objDir = path.join(attachRoot, 'objects', hash.slice(0, 2))
  const obj = path.join(objDir, hash)
  await fsp.mkdir(objDir, { recursive: true })
  const tmp = path.join(objDir, '.import-' + hash.slice(0, 12) + '-' + process.pid + '.tmp')
  const stored = await streamEntryToFile(entry, tmp)
  if (stored.sha256 !== hash) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new Error('media ' + hash + ' does not match its sha256 (the package is corrupt)')
  }
  // 对象已在（同哈希=同字节）：删掉临时件，不覆盖。
  if (isFile(obj)) { await fsp.rm(tmp, { force: true }).catch(() => {}); return stored.bytes }
  await fsp.rename(tmp, obj)
  return stored.bytes
}

/**
 * 落一个文件附件：本体进 file-objects，再链接出 files/ 别名。
 * 与 DSH 自己写附件库的方式一致（先发布不可变对象，再给它一个别名），
 * 一份字节只存一次，不像复制那样占双份。
 */
async function saveFile(entry, { hash, prefix, name, attachRoot }) {
  const safeName = path.basename(name)
  if (safeName === '' || safeName === '.' || safeName === '..') throw new Error('the package has an unsafe file name: ' + name)
  const objDir = path.join(attachRoot, 'file-objects', prefix)
  const obj = path.join(objDir, hash)
  await fsp.mkdir(objDir, { recursive: true })
  const tmp = path.join(objDir, '.import-' + process.pid + '.tmp')
  const stored = await streamEntryToFile(entry, tmp)
  if (stored.sha256 !== hash) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw new Error('file ' + name + ' does not match its sha256 (the package is corrupt)')
  }
  if (isFile(obj)) { await fsp.rm(tmp, { force: true }).catch(() => {}) } else { await fsp.rename(tmp, obj) }
  const dir = path.join(attachRoot, 'files', prefix, hash)
  await fsp.mkdir(dir, { recursive: true })
  const dst = path.join(dir, safeName)
  if (!isFile(dst)) await fsp.link(obj, dst)
  return stored.bytes
}

/** 只读第一帧的户口本（dryRun 与真导入都用它）。 */
async function readHeader(file) {
  let text = ''
  let done = false
  await forEachZipEntry(file, async (entry) => {
    if (done || entry.isDir || !ROOT_LOG.test(entry.name)) return
    for await (const chunk of entry.read()) {
      text += chunk.toString('utf8')
      if (text.indexOf('\n') >= 0) { done = true; break }
      if (text.length > 4 * 1024 * 1024) throw new Error('the exported log header line is too long')
    }
  })
  if (!done) throw new Error('this zip has no session.v4.jsonl at its root; it is not a session package')
  const line = text.slice(0, text.indexOf('\n'))
  let header
  try { header = JSON.parse(line) } catch { throw new Error('the first line of session.v4.jsonl is not JSON') }
  if (header === null || typeof header !== 'object' || header.type !== 'session') {
    throw new Error('the first line of session.v4.jsonl is not a session header')
  }
  if (typeof header.id !== 'string' || header.id === '') throw new Error('the session header carries no id')
  return header
}

/** 目标工作区：按 id 找（客户端传 id，不传路径）。 */
function findWorkspace(deps, workspaceId) {
  const list = deps.workspaceRegistry?.list?.()
  if (!Array.isArray(list) || list.length === 0) throw new Error('this host has no workspace registry; open the app once so a workspace exists')
  const hit = list.find((w) => w.id === workspaceId) ?? (workspaceId === '' || workspaceId === undefined ? list[0] : undefined)
  if (hit === undefined) throw new Error('no workspace with id ' + workspaceId)
  if (typeof hit.path !== 'string' || hit.path === '') throw new Error('workspace ' + hit.id + ' has no path')
  return hit
}

async function findGrid(root, id) {
  let grids = []
  try { grids = await fsp.readdir(root, { withFileTypes: true }) } catch { return null }
  for (const g of grids) {
    if (!g.isDirectory()) continue
    if (await existsDir(path.join(root, g.name, id))) return g.name
  }
  return null
}

async function safeRealpath(p) {
  try { return await fsp.realpath(p) } catch { return '' }
}

/**
 * 撞号检查：同一个 id 在本机现在是什么状态。
 * 命中一律换新 id：同工作区再挂成原会话的分支，别的工作区只换号。
 */
async function inspectExisting(deps, id, root) {
  const grid = await findGrid(root, id)
  let header = null
  try {
    const rows = await deps.persistence.list()
    header = (rows.map((row) => row.header ?? row).find((h) => h.id === id)) ?? null
  } catch { header = null }
  return { grid, header }
}

/** 只改日志的第一行（户口本）；正文原样。 */
function replaceFirstLine(file, line) {
  const buf = fs.readFileSync(file)
  const nl = buf.indexOf(0x0a)
  if (nl < 0) return false
  fs.writeFileSync(file, Buffer.concat([Buffer.from(line, 'utf8'), buf.subarray(nl + 1)]))
  return true
}

/** 只改第一行的 cwd（子代理日志用：换 cwd 不换 id）。 */
async function rewriteHeaderCwd(file, cwd) {
  const head = (await firstLineOf(file)).toString('utf8').replace(/\n$/, '')
  const parsed = JSON.parse(head)
  parsed.cwd = cwd
  replaceFirstLine(file, JSON.stringify(parsed) + '\n')
}

/**
 * 导入一个会话包。
 * @param {object} opts
 * @param {object} opts.deps 宿主依赖（persistence / sessions / agents / workspaceRegistry）
 * @param {string} opts.dshHome
 * @param {string} opts.file 已落盘的 zip
 * @param {string} opts.workspaceId 目标工作区 id
 * @param {boolean} [opts.dryRun]
 */
export async function importSession({ deps, dshHome, file, workspaceId, dryRun = false }) {
  if (!canWriteZstd()) throw new Error('this host runs a Node without zstdCompress; session import needs Node 22.15+')
  const root = deps.persistence?.config?.root
  if (typeof root !== 'string' || root === '') throw new Error('session persistence has no storage root')
  const workspace = findWorkspace(deps, workspaceId)
  let workspacePath
  try { workspacePath = await fsp.realpath(workspace.path) } catch (error) { throw new Error('the target workspace path does not resolve: ' + message(error)) }
  if (!(await existsDir(workspacePath))) throw new Error('the target workspace path is not a directory: ' + workspacePath)

  const header = await readHeader(file)
  const originalId = header.id
  const existing = await inspectExisting(deps, originalId, root)
  const targetGrid = projectKey(workspacePath)
  const sameCwd = existing.header !== null && typeof existing.header.cwd === 'string' &&
    (existing.header.cwd === workspacePath || (await safeRealpath(existing.header.cwd)) === workspacePath)
  // 户口本读不出来时以格子为准（格子名就是 cwd 算出来的）：同格子才算同一个工作区。
  // 判错的代价是两条同 id 会话落在两个格子 → 会话列表整份 500，所以宁可换号。
  const sameGrid = existing.grid !== null && (existing.header !== null ? sameCwd : existing.grid === targetGrid)
  // 撞号一律换新 id，绝不原地覆盖：覆盖不会在列表里多出条目，用户看到的是「没刷新」。
  // 同工作区的撞号同时挂成原会话的分支（parentSession）；别的工作区只换号，不跨区挂父子。
  // seeded 会话的继承前缀另有语义，只换号不挂分支。
  const willRename = existing.grid !== null
  const willBranch = sameGrid

  const entries = await readZipCentralFromFile(file)
  const mediaCount = entries.filter((e) => !e.isDir && MEDIA_NAME.test(e.name)).length
  const fileCount = entries.filter((e) => !e.isDir && FILE_NAME.test(e.name)).length
  const subCount = entries.filter((e) => !e.isDir && SUB_LOG.test(e.name)).length

  const plan = {
    session: {
      id: willRename ? null : originalId,
      originalId,
      willRename,
      willBranch,
      cwd: workspacePath
    },
    workspace: { id: workspace.id, path: workspacePath, title: workspace.title ?? '' },
    counts: { media: mediaCount, files: fileCount, subagents: subCount },
    warnings: []
  }
  if (dryRun) return { ok: true, dryRun: true, ...plan }

  const attachRoot = path.join(dshHome, 'attachments', 'v1')
  const id = willRename ? 'session-' + randomUUID() : originalId
  const gridKey = targetGrid
  const sessionDir = path.join(root, gridKey, id)

  const tmpLog = path.join(sessionDir, '.import-' + process.pid + '.jsonl')
  const written = []
  let mediaSaved = 0
  let subSaved = 0
  try {
    await fsp.mkdir(sessionDir, { recursive: true })

    let rootWritten = false
    const subDirs = []
    await forEachZipEntry(file, async (entry) => {
      if (entry.isDir) return
      const media = MEDIA_NAME.exec(entry.name)
      if (media !== null) {
        await saveMedia(entry, { hash: media[1].toLowerCase(), attachRoot })
        mediaSaved += 1
        return
      }
      const fileHit = FILE_NAME.exec(entry.name)
      if (fileHit !== null) {
        await saveFile(entry, { hash: fileHit[2].toLowerCase(), prefix: fileHit[2].toLowerCase().slice(0, 2), name: fileHit[3], attachRoot })
        return
      }
      const sub = SUB_LOG.exec(entry.name)
      if (sub !== null) {
        const subId = sub[1]
        const subDir = path.join(root, gridKey, subId)
        if (await existsDir(subDir)) {
          plan.warnings.push('subagent session ' + subId + ' already exists; skipped')
          return
        }
        await fsp.mkdir(subDir, { recursive: true })
        written.push(subDir)
        const tmp = path.join(subDir, '.import-' + process.pid + '.jsonl')
        await streamEntryToFile(entry, tmp)
        // 子代理的 cwd 也指向目标工作区，但 id / parentSession / delegationDepth 原样。
        await rewriteHeaderCwd(tmp, workspacePath)
        await packLog(tmp, path.join(subDir, SESSION_LOG_NAME))
        await fsp.rm(tmp, { force: true }).catch(() => {})
        subDirs.push(subId)
        subSaved += 1
        return
      }
      if (ROOT_LOG.test(entry.name) && !rootWritten) {
        rootWritten = true
        await streamEntryToFile(entry, tmpLog)
      }
    })
    if (!rootWritten) throw new Error('this zip has no session.v4.jsonl at its root; it is not a session package')

    // 户口本：改 cwd（换号时连 id 一起改）。其余字段一个都不动。
    const headText = (await firstLineOf(tmpLog)).toString('utf8').replace(/\n$/, '')
    const head = JSON.parse(headText)
    // 种子会话的继承切点必须原样写进目录册；写错 DSH 就打不开（"seeded header disagrees"）。
    // 顺带把自相矛盾的包挡在写盘之前：说是种子却没有标记，或不是种子却带标记。
    const inheritedCut = await scanInheritedCut(tmpLog)
    if (head.isSeeded === true && inheritedCut < 0) {
      throw new Error('this package is marked isSeeded but its log has no inherited end-seed marker')
    }
    if (head.isSeeded !== true && inheritedCut >= 0) {
      throw new Error('this package is not seeded but its log carries an inherited end-seed marker')
    }
    const inheritedEventCount = head.isSeeded === true ? inheritedCut : 0
    head.cwd = workspacePath
    if (willRename) head.id = id
    // 挂分支：新会话登记为原同 id 会话的子会话（parentSession），历史仍独立。
    // 包里本来就带父会话的（自己就是别人的分支）保留原值，不覆盖。
    if (willBranch && head.parentSession === void 0) head.parentSession = originalId
    if (!replaceFirstLine(tmpLog, JSON.stringify(head) + '\n')) throw new Error('cannot rewrite the session header')
    await packLog(tmpLog, path.join(sessionDir, SESSION_LOG_NAME))
    await fsp.rm(tmpLog, { force: true }).catch(() => {})
    written.push(sessionDir)

    // 会话卡片（projcache）不写：它是缓存，DSH 第一次打开会照日志重建。

    // 刷新：照删除那边的写法——在动作这一刻重新 list() 取实时工作区对象再调用，
    // 不拿函数开头那份早已过期的快照（过期对象的 mutate 只写表、不发列表变更事件）。
    // attachSession 会校验 cwd == workspace.path，并持久化、发变更事件。
    let liveWorkspace = workspace
    try {
      const freshList = deps.workspaceRegistry?.list?.()
      const fresh = Array.isArray(freshList) ? freshList.find((row) => row?.id === workspace.id) : undefined
      if (fresh !== undefined) liveWorkspace = fresh
    } catch (error) {
      plan.warnings.push('cannot refresh the workspace handle: ' + message(error))
    }
    // 这一步失败就把刚写的东西撤掉，别留一条没有工作区认领的孤儿。
    try {
      await liveWorkspace.attachSession(id)
      for (const subId of subDirs) {
        try { await liveWorkspace.attachSession(subId) } catch (error) {
          plan.warnings.push('subagent session ' + subId + ' was written but not attached: ' + message(error))
        }
      }
    } catch (error) {
      for (const dir of written) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new Error('the session files were written but the workspace refused to attach the session: ' + message(error))
    }
    // 通知前端左侧列表：导入的会话没有 session/created，宿主的 api-session/added 不会自己发。
    try {
      deps.notifySessionAdded?.(coldSummary(head))
    } catch (error) {
      plan.warnings.push('the session was imported but the list notification failed: ' + message(error))
    }

    return {
      ok: true,
      dryRun: false,
      session: { id, originalId, willRename, willBranch, renamed: id !== originalId, cwd: workspacePath, isSeeded: head.isSeeded === true, inheritedEventCount },
      workspace: plan.workspace,
      counts: { media: mediaSaved, files: fileCount, subagents: subSaved },
      warnings: plan.warnings
    }
  } catch (error) {
    await fsp.rm(tmpLog, { force: true }).catch(() => {})
    throw error
  }
}
