/**
 * 「自创工具」页的数据：工具组清单的那一段原文。
 */

import { readOptionsSync } from '../../core/settings.js'
import { readLocaleSync } from '../../core/locale.js'
import { catalogText, toolSequenceRoot } from '../../core/schema.js'
import { respond } from '../http-util.js'

const PREFIX = '/api/session-recall.'

/** @param {(path:string, handler:Function) => void} route @param {{dshHome:string}} deps */
export function routesTools(route, { dshHome }) {
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
}
