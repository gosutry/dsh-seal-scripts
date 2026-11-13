/**
 * 设置页 HTTP 端点的注册入口。
 *
 * 只做三件事：建路表（登录态 + 同源 + 错误码映射）、把四组路由装上、结束。
 * 具体端点按域放在 routes/ 下，一个文件一组。
 */

import { respond, sameOrigin } from './http-util.js'
import { routesSessions } from './routes/sessions.js'
import { routesMemories } from './routes/memories.js'
import { routesOptions } from './routes/options.js'
import { routesTools } from './routes/tools.js'

/**
 * 共用外壳：登录态检查 + 同源检查 + 错误码映射（413 / path-outside / 500）。
 * @param {object} webCtx
 * @returns {(path:string, handler:Function) => void}
 */
export function makeRoute(webCtx) {
  return (path, handler) => webCtx.effect(() => webCtx.webServer.register({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      try {
        const rejection = webCtx.connection?.requestRejection?.(req)
        if (rejection !== undefined) {
          respond(res, rejection, { error: { code: 'access-denied', message: 'sign in first' } })
          return
        }
        if (!sameOrigin(req)) {
          respond(res, 403, { error: { code: 'cross-origin', message: 'cross-origin request rejected' } })
          return
        }
        await handler(req, res)
      } catch (error) {
        if (error?.code === 'body-too-large') {
          respond(res, 413, { error: { code: 'body-too-large', message: error.message } })
          return
        }
        // 路径越界是调用方给错了参数，不是服务端坏了：回 400 + 可识别的错误码。
        // 判据在 path-guard.js 里，靠它那句固定开头认人。
        if (/^only files inside /.test(error?.message ?? '')) {
          respond(res, 400, { error: { code: 'path-outside', message: error.message } })
          return
        }
        respond(res, 500, { error: { code: 'internal', message: error?.message ?? String(error) } })
      }
    }
  }), 'dsh-seal-scripts: ' + path)
}

/**
 * 装 10 个端点。
 * @param {object} webCtx
 * @param {{dshHome:string, getDeps:Function, waitForSplit?:Function, onOptionsChanged?:Function, canLifecycle?:boolean, probe?:Function}} deps
 */
export function registerApi(webCtx, deps) {
  const route = makeRoute(webCtx)
  routesSessions(route, deps)
  routesMemories(route, deps)
  routesOptions(route, deps)
  routesTools(route, deps)
}
