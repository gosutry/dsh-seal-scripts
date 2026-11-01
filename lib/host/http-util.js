/**
 * HTTP 小工具：读 body、回 JSON、判同源。
 *
 * respond 有一条硬规矩：**不要自己写 Content-Length、不要自己 writeHead**。
 * DSH 挂着压缩中间件（compression + dsha-web-mobile 的 compress.js），
 * 它们会在 res.end 时重算响应体并补头；我们先写头就会撞上
 * ERR_HTTP_HEADERS_SENT，连接直接异常，浏览器只看到 Failed to fetch。
 */

export const MAX_BODY_BYTES = 1_048_576

/**
 * 回一个 JSON。永不抛错：响应已经发出去或客户端断开都只当没写。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
export function respond(res, status, body) {
  if (res.writableEnded === true) return
  let payload
  try { payload = JSON.stringify(body) } catch { payload = '{"error":{"code":"unserializable"}}' }
  try {
    // 只设状态码与类型，长度交给压缩中间件算。
    if (res.headersSent !== true) {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
    }
  } catch { /* 头已经发了，忽略 */ }
  try {
    res.end(payload)
  } catch { /* 客户端已经走了，忽略 */ }
}

export function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return true
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

/**
 * 读请求体。三种情况都要能返回，不能挂住：
 *   请求体已经读完（readableEnded）→ 直接给空串
 *   正常有 body → 收完给字符串
 *   超限 → reject
 */
export function readBody(req) {
  return new Promise((yes, no) => {
    if (req.readableEnded === true) { yes(''); return }
    let data = ''
    let bytes = 0
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (tooLarge) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > MAX_BODY_BYTES) { tooLarge = true; data = ''; no(new Error('too-large')); return }
      data += chunk
    })
    req.on('end', () => { if (!tooLarge) yes(data) })
    req.on('error', (e) => { if (!tooLarge) no(e) })
    req.on('aborted', () => { if (!tooLarge) no(new Error('aborted')) })
  })
}
