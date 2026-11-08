/**
 * HTTP 小工具：读 body、回 JSON、判同源。
 *
 * respond 有一条硬规矩：**不要自己写 Content-Length、不要自己 writeHead**。
 * DSH 挂着压缩中间件（compression + dsha-web-mobile 的 compress.js），
 * 它们会在 res.end 时重算响应体并补头；我们先写头就会撞上
 * ERR_HTTP_HEADERS_SENT，连接直接异常，浏览器只看到 Failed to fetch。
 *
 * 0.4.11：请求体不再有「1 MB / 48 MB」这种死上限。
 *   普通 JSON 端点走 readBody（边收边攒成 Buffer，不先攒字符串）；
 *   导入端点走 readBodyToFile（直接流到磁盘上的临时文件，包多大都不吃内存）。
 */

import fs from 'node:fs'

/**
 * 一条请求体上限（只在调用方显式给数时生效）。0.4.11 起默认不限。
 */
export const NO_LIMIT = 0

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
 * 读请求体，攒成 Buffer。四种情况都要能返回，不能挂住：
 *   请求体已经读完（readableEnded）→ 直接给空 Buffer
 *   正常有 body → 收完给 Buffer
 *   给了 limit 且超了 → reject（默认不限，0.4.11 起没有 1 MB / 48 MB 这类死数）
 *   客户端断开 / 出错 → reject
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit] 0 或负数 = 不限
 * @returns {Promise<Buffer>}
 */
export function readBodyBuffer(req, limit = NO_LIMIT) {
  const max = Number.isFinite(limit) && limit > 0 ? limit : Infinity
  return new Promise((yes, no) => {
    if (req.readableEnded === true) { yes(Buffer.alloc(0)); return }
    const chunks = []
    let bytes = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buf.length
      if (bytes > max) {
        failed = true
        chunks.length = 0
        // 已经太大：暂停上游，不再收；交给调用方回 413。
        try { req.pause() } catch { /* 有些 req 没有 pause */ }
        const err = new Error('请求体超过上限（' + max + ' 字节）')
        err.code = 'body-too-large'
        no(err)
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => { if (!failed) yes(Buffer.concat(chunks, bytes)) })
    req.on('error', (e) => { if (!failed) no(e) })
    req.on('aborted', () => { if (!failed) no(new Error('aborted')) })
  })
}

/**
 * 读请求体成字符串（普通 JSON 端点用）。默认不限。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export function readBody(req, limit = NO_LIMIT) {
  return readBodyBuffer(req, limit).then((buf) => buf.toString('utf8'))
}

/**
 * 把请求体直接流进一个文件（导入大包走这条路）：内存里只有一块，包多大都行。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} file 目标文件（覆盖写）
 * @returns {Promise<{bytes:number}>}
 */
export function readBodyToFile(req, file) {
  return new Promise((yes, no) => {
    const stream = fs.createWriteStream(file)
    let bytes = 0
    let failed = false
    const fail = (err) => {
      if (failed) return
      failed = true
      stream.destroy()
      no(err instanceof Error ? err : new Error(String(err)))
    }
    stream.on('error', fail)
    req.on('data', (chunk) => { bytes += Buffer.byteLength(chunk) })
    req.on('error', fail)
    req.on('aborted', () => fail(new Error('aborted')))
    req.on('end', () => { /* 等 stream 的 finish */ })
    req.pipe(stream)
    stream.on('finish', () => { if (!failed) yes({ bytes }) })
  })
}
