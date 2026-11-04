/**
 * 读 DSH 会话日志：session.v4.jsonl.zstd 是多帧 zstd，Node 的 zstdDecompressSync
 * 只认第一帧，所以要按帧头逐帧切开再解。
 *
 * 帧头 FCS 字段长度是 0/2/4/8（不是 0/1/2/4），写错会在某个偏移报 reserved block type。
 */

import fs from 'node:fs'
import zlib from 'node:zlib'
import { decodeFrames } from './zstd-js.js'

const MAGIC = 0xfd2fb528

/** 原生解压可用吗（Node 22.15+）。 */
export function nativeZstd() {
  return typeof zlib.zstdDecompressSync === 'function'
}

/**
 * 现在能不能解 zstd：原生优先，缺了走内置。
 * 内置实现覆盖 DSH 写日志用的那部分（见 zstd-js.js），所以恒为 true。
 */
export function canDecodeZstd() {
  return true
}

/**
 * 解一帧：有原生就走原生（快一个数量级），没有才用内置。
 * 内置路径必须真的能被走到——oracle 测试会把 zlib.zstdDecompressSync 拿掉再跑。
 */
function decompressOne(slice) {
  if (nativeZstd()) return zlib.zstdDecompressSync(slice)
  return decodeFrames(slice)
}

/** 量出一帧的长度（含帧头与校验）。 */
function frameLength(buf, off) {
  let q = off + 4
  const fhd = buf[q++]
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (!single) q += 1
  q += [0, 1, 2, 4][dictFlag]
  let fcs = [0, 2, 4, 8][fcsFlag]
  if (fcsFlag === 0 && single) fcs = 1
  q += fcs
  for (;;) {
    if (q + 3 > buf.length) throw new Error('日志截断 @' + q)
    const h = buf[q] | (buf[q + 1] << 8) | (buf[q + 2] << 16)
    q += 3
    const last = h & 1
    const type = (h >> 1) & 3
    const size = h >>> 3
    if (type === 0) q += size
    else if (type === 1) q += 1
    else if (type === 2) q += size
    else throw new Error('reserved block type @' + q)
    if (last) break
  }
  if (checksum) q += 4
  return q - off
}

/**
 * 解一整个缓冲区里的所有帧。
 * @param {Buffer} buf
 * @returns {{ events: object[], frames: number, failed: number }}
 */
export function decodeSessionBuffer(buf) {
  const chunks = []
  let off = 0
  let frames = 0
  let failed = 0
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== MAGIC) { off++; continue }
    try {
      const len = frameLength(buf, off)
      chunks.push(decompressOne(buf.subarray(off, off + len)).toString('utf8'))
      frames++
      off += len
    } catch {
      failed++
      off++
    }
  }
  const events = []
  for (const line of chunks.join('').split('\n')) {
    if (!line) continue
    try { events.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return { events, frames, failed }
}

/**
 * 读一个会话目录里的全部事件。
 * @param {string} file 日志文件绝对路径
 * @returns {{ events: object[], frames: number, failed: number }}
 */
export function readSessionEvents(file) {
  return decodeSessionBuffer(fs.readFileSync(file))
}
