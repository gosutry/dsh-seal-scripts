/**
 * 设置项的读写：options（选项）/ locale（语言）。
 * 两边都是「读一半写一半」：注入路径直接读核心里的同步函数，这里只管 HTTP。
 */

import { readOptionsSync, writeOptions } from '../../core/settings.js'
import { readLocaleSync, writeLocale } from '../../core/locale.js'
import { respond, readBody } from '../http-util.js'

const PREFIX = '/api/session-recall.'

/** @param {(path:string, handler:Function) => void} route @param {{dshHome:string, onOptionsChanged?:Function}} deps */
export function routesOptions(route, { dshHome, onOptionsChanged }) {
  route(PREFIX + 'options', async (req, res) => {
    if (req.method === 'GET') {
      respond(res, 200, { options: readOptionsSync(dshHome) })
      return
    }
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'GET / POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    // 收紧在 writeOptions 里做：「停止降低」开启时载入数值一律回退到跟随深度。
    const options = await writeOptions(dshHome, body)
    // 0.4.1：写完立刻按新选项装卸工具。这一步必须发生在返回之前——
    // 下一轮开头 systemPrompt.assemble() 会拍工具表快照，晚一步就要多等一轮。
    try { onOptionsChanged?.() } catch { /* 装卸失败不影响选项落盘，下一轮 pre-step 还会再对一次 */ }
    respond(res, 200, { options })
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
}
