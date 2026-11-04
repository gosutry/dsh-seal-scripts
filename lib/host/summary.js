/**
 * 会话摘要：标题、条数、最后活动时间。全部从会话日志解出来。
 *
 * E3：把「读不出来」与「没有日志」分开。
 * 以前没有 zstd 的 Node（18/20）上这里静默返回全空，设置页每个会话都叫
 * 「空会话」——那是假话。现在返回 {ok:false, code:'unreadable'|'no-log'}，
 * 由界面决定怎么显示；回顾功能本身不经过这里，照常可用。
 * 档 5 起缺原生 zstd 不再是一种错误：core/zstd.js 会走内置解码器。
 */

import fs from 'node:fs'
import { join } from 'node:path'
import { readSessionEvents, canDecodeZstd } from '../core/zstd.js'

const LOG_NAME = 'session.v4.jsonl.zstd'

/**
 * 本机能不能解 zstd。档 5 起恒为 true：缺原生 zlib.zstdDecompressSync 时
 * core/zstd.js 会走内置解码器（zstd-js.js），不再需要在这里提前放弃。
 */
export const CAN_ZSTD = canDecodeZstd()

/** 从事件里找标题（session/title 事件优先，其次第一条用户消息）。 */
function titleOf(events) {
  let title = ''
  for (const e of events) {
    if (e && e.type === 'session/title' && typeof e.data?.title === 'string' && e.data.title.trim() !== '') {
      title = e.data.title.trim()
    }
  }
  if (title !== '') return title
  for (const e of events) {
    if (!e || e.type !== 'user/message') continue
    if (e.data?.source?.kind !== 'user') continue
    const text = (e.data.content ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat !== '') return flat.length > 40 ? flat.slice(0, 40) + '…' : flat
  }
  return ''
}

const EMPTY = { title: '', messages: 0, userMessages: 0, toolCalls: 0, lastAt: null }

/**
 * 读一个会话的摘要。
 * @param {string} dir
 * @returns {{ok:true, title:string, messages:number, userMessages:number, toolCalls:number, lastAt:number|null}
 *          | {ok:false, code:'no-zstd'|'unreadable'|'no-log', title:string, messages:0, userMessages:0, toolCalls:0, lastAt:null}}
 */
export function readDigest(dir) {
  const log = join(dir, LOG_NAME)
  if (!fs.existsSync(log)) return { ok: false, code: 'no-log', ...EMPTY }
  // 档 5 起不再有「没有 zstd 就放弃」这一步：原生不在时 readSessionEvents 走内置解码器。
  try {
    const { events, frames, failed } = readSessionEvents(log)
    // 文件在、一帧都没解出来：这不是空会话，是读不了（坏文件/被截断/不是 zstd）。
    if (frames === 0) return { ok: false, code: 'unreadable', ...EMPTY }
    let userMessages = 0
    let toolCalls = 0
    let lastAt = null
    for (const e of events) {
      if (!e) continue
      if (typeof e.time === 'number') lastAt = e.time
      if (e.type === 'user/message' && e.data?.source?.kind === 'user') userMessages++
      else if (e.type === 'assistant/message') toolCalls += (e.data?.message?.content ?? []).filter((b) => b && b.type === 'tool-call').length
    }
    return { ok: true, title: titleOf(events), messages: events.length, userMessages, toolCalls, lastAt }
  } catch {
    return { ok: false, code: 'unreadable', ...EMPTY }
  }
}
