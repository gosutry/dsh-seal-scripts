/**
 * 会话摘要：标题、条数、最后活动时间。全部从会话日志整份解出来。
 */

import { join } from 'node:path'
import { readSessionEvents } from '../core/zstd.js'

const LOG_NAME = 'session.v4.jsonl.zstd'

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

/**
 * 完整读一个会话：条数、对话条数、工具次数、最后一次活动。
 * @param {string} dir
 * @returns {{ title:string, messages:number, userMessages:number, toolCalls:number, lastAt:number|null }}
 */
export function readDigest(dir) {
  try {
    const { events } = readSessionEvents(join(dir, LOG_NAME))
    let userMessages = 0
    let toolCalls = 0
    let lastAt = null
    for (const e of events) {
      if (!e) continue
      if (typeof e.time === 'number') lastAt = e.time
      if (e.type === 'user/message' && e.data?.source?.kind === 'user') userMessages++
      else if (e.type === 'assistant/message') toolCalls += (e.data?.message?.content ?? []).filter((b) => b && b.type === 'tool-call').length
    }
    return { title: titleOf(events), messages: events.length, userMessages, toolCalls, lastAt }
  } catch {
    return { title: '', messages: 0, userMessages: 0, toolCalls: 0, lastAt: null }
  }
}
