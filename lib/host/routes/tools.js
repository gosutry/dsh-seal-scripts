/**
 * 「自创工具」页的数据：工具组清单的那一段原文，以及导入 / 导出（0.4.3）。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { readOptionsSync } from '../../core/settings.js'
import { readLocaleSync } from '../../core/locale.js'
import { catalogText, toolSequenceRoot, runsDir } from '../../core/schema.js'
import { exportToolSequence, importToolSequence } from '../../core/tool-transfer.js'
import { clearToolCaches } from '../../core/tool-cache.js'
import { readBody, readBodyToFile, respond } from '../http-util.js'

const PREFIX = '/api/session-seal-scripts.'

/**
 * 正在进行的导入条数（0.5.1）。导入会把包临时落在 _runs/ 里，
 * 「清除缓存」看到有人在做就先跳过这些临时包——两边都在同一个宿主进程里，数得准。
 */
let importsInFlight = 0

/** @param {(path:string, handler:Function) => void} route @param {{dshHome:string, onOptionsChanged?:Function}} deps */
export function routesTools(route, { dshHome, onOptionsChanged }) {
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

  /**
   * 导出（0.4.3）：把工具组目录下的内容打成 toolSequence.zip，**压缩率 0**（store），
   * 直接写进请求里指定的那个工作区文件夹，不走浏览器下载。
   *
   * cwd 只接受已经存在的绝对目录（并且不是磁盘根），写完把真实落点回给界面，
   * 界面把那句话显示出来——用户要的是「文件在哪」，不是一个消失在下载管理里的 zip。
   */
  route(PREFIX + 'toolSequence/export', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const raw = await readBody(req)
    let body
    try { body = JSON.parse(raw || '{}') } catch { respond(res, 400, { error: { code: 'bad-json', message: 'request body is not JSON' } }); return }
    let packed
    try {
      packed = await exportToolSequence({ dshHome, dir: body && body.cwd })
    } catch (error) {
      respond(res, 400, { error: { code: 'export-failed', message: error && error.message ? error.message : String(error) } })
      return
    }
    respond(res, 200, {
      ok: true,
      name: packed.name,
      file: packed.file,
      dir: packed.dir,
      method: 'store',
      compressionLevel: 0,
      size: packed.size,
      files: packed.files,
      dirs: packed.dirs,
      overwritten: packed.overwritten,
      path: toolSequenceRoot(dshHome)
    })
  })

  /**
   * 导入（0.4.3；0.4.11 改成两条入口）。
   *
   *   application/zip（或任何非 JSON）：请求体就是 zip 原始字节。先流式落到
   *     _runs/ 里的临时文件，再按中央目录逐条解出来直接写 staging——包多大都不吃内存。
   *     dryRun / name 走查询参数：?dryRun=1&name=xxx.zip
   *   application/json：老客户端（base64 包在 JSON 里）照旧能导入，但不再有 48 MB 上限。
   *
   * dryRun 为真时只报「会装哪些、会盖哪些」，不写盘——设置页要用户点一次确认。
   */
  route(PREFIX + 'toolSequence/import', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    let query
    try { query = new URL(req.url ?? '/', 'http://placeholder').searchParams } catch { query = new URLSearchParams() }
    const ctype = String(req.headers['content-type'] ?? '').toLowerCase()
    let dryRun = query.get('dryRun') === '1'
    let name = query.get('name') || 'toolSequence.zip'
    let buffer
    let tmpFile = ''
    let bytes = 0
    importsInFlight += 1
    try {
      if (ctype.includes('application/json')) {
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw || '{}') } catch {
          respond(res, 400, { error: { code: 'bad-json', message: 'request body is not JSON' } })
          return
        }
        const data = typeof body.data === 'string' ? body.data : ''
        if (data === '') { respond(res, 400, { error: { code: 'missing-file', message: 'no package content received' } }); return }
        try { buffer = Buffer.from(data, 'base64') } catch { respond(res, 400, { error: { code: 'bad-base64', message: 'package content is not valid base64' } }); return }
        if (buffer.length === 0) { respond(res, 400, { error: { code: 'empty-file', message: 'the package is empty' } }); return }
        bytes = buffer.length
        if (body.dryRun === true) dryRun = true
        if (typeof body.name === 'string' && body.name !== '') name = body.name
      } else {
        // 原始字节：先落临时文件（在 _runs/ 里，导出时会跳过），再流式解包。
        const dir = runsDir(dshHome)
        await fsp.mkdir(dir, { recursive: true })
        tmpFile = path.join(dir, 'import.tmp-' + Date.now() + '-' + process.pid + '.zip')
        const written = await readBodyToFile(req, tmpFile)
        bytes = written.bytes
        if (bytes === 0) {
          respond(res, 400, { error: { code: 'empty-file', message: 'the package is empty' } })
          return
        }
      }

      let result
      try {
        result = await importToolSequence({ dshHome, buffer, file: tmpFile || undefined, dryRun })
      } catch (error) {
        respond(res, 400, { error: { code: 'import-failed', message: error?.message ?? String(error) } })
        return
      }
      // 真装上了就把工具表立刻对一次；和选项那条路由同一个道理：赶在下一轮 assemble() 之前。
      if (!dryRun) {
        try { onOptionsChanged?.() } catch { /* 同步失败不影响已经落地的文件，下一轮 pre-step 还会再对一次 */ }
      }
      respond(res, 200, {
        ok: true,
        dryRun,
        name,
        size: bytes,
        path: toolSequenceRoot(dshHome),
        imported: result.imported,
        overwritten: result.overwritten,
        skipped: result.skipped
      })
    } finally {
      importsInFlight -= 1
      if (tmpFile !== '') await fsp.rm(tmpFile, { force: true }).catch(() => {})
    }
  })

  /**
   * 清除缓存（0.5.1）：「自创工具」页最右边那颗按钮。
   *
   * 只删两类东西：<id>.bak-<时间戳> 回滚版本、_runs/ 里的运行日志。
   * 工具目录与 _index.json 不动——清完工具照常跑，索引不用重建。
   * 单个条目删不掉不算整轮失败：照样回 200，把 failed 交给界面点名。
   */
  route(PREFIX + 'toolSequence/clear-cache', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    let result
    try {
      result = await clearToolCaches({ dshHome, keepImportTmp: importsInFlight > 0 })
    } catch (error) {
      respond(res, 500, { error: { code: 'clear-failed', message: error?.message ?? String(error) } })
      return
    }
    respond(res, 200, {
      ok: result.failed.length === 0,
      path: toolSequenceRoot(dshHome),
      backups: result.backups,
      runs: result.runs,
      total: result.total,
      failed: result.failed
    })
  })
}
