/**
 * 「自创工具」页的数据：工具组清单的那一段原文，以及导入 / 导出（0.4.3）。
 */

import { readOptionsSync } from '../../core/settings.js'
import { readLocaleSync } from '../../core/locale.js'
import { catalogText, toolSequenceRoot } from '../../core/schema.js'
import { exportToolSequence, importToolSequence, MAX_EXPORT_BYTES } from '../../core/tool-transfer.js'
import { MAX_IMPORT_BODY_BYTES, readBody, respond } from '../http-util.js'

const PREFIX = '/api/session-recall.'

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
    try { body = JSON.parse(raw || '{}') } catch { respond(res, 400, { error: { code: 'bad-json', message: '请求体不是 JSON' } }); return }
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
   * 导入（0.4.3）：收一个 zip（base64），先解包校验，再按工具脚本目录逐个落地。
   * dryRun 为真时只报「会装哪些、会盖哪些」，不写盘——设置页要用户点一次确认。
   */
  route(PREFIX + 'toolSequence/import', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const raw = await readBody(req, MAX_IMPORT_BODY_BYTES)
    let body
    try { body = JSON.parse(raw || '{}') } catch { respond(res, 400, { error: { code: 'bad-json', message: '请求体不是 JSON' } }); return }
    const data = typeof body.data === 'string' ? body.data : ''
    if (data === '') { respond(res, 400, { error: { code: 'missing-file', message: '没有收到包内容' } }); return }
    let buffer
    try { buffer = Buffer.from(data, 'base64') } catch { respond(res, 400, { error: { code: 'bad-base64', message: '包内容不是合法的 base64' } }); return }
    if (buffer.length === 0) { respond(res, 400, { error: { code: 'empty-file', message: '包是空的' } }); return }

    const dryRun = body.dryRun === true
    let result
    try {
      result = await importToolSequence({ dshHome, buffer, dryRun })
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
      name: typeof body.name === 'string' ? body.name : 'toolSequence.zip',
      size: buffer.length,
      path: toolSequenceRoot(dshHome),
      imported: result.imported,
      overwritten: result.overwritten,
      skipped: result.skipped
    })
  })
}
