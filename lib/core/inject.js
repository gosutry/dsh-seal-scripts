/**
 * 回顾的注入通道：走自己的 kind，不走 runtime-context 快照。
 *
 * 为什么另起一条：runtime-context 快照归 agent-loop 所有，它只在文本变化时
 * **追加**一条新快照，旧的要等下一次压缩的 replace 才被吞掉。实测一个会话里
 * 同时挂着两份、合计 7.7 万字。自己起 kind 就能在文本变化时替换掉自己上一条，
 * surface 上永远只有一份，而且是当场最新的那份。
 */

import { randomUUID } from 'node:crypto'

/** 消息来源标识。GUI 把非 user 的 kind 都当「上下文」块渲染，不会变成用户气泡。 */
export const MEMORY_SOURCE_KIND = 'session-seal-scripts'

/** 分区名，写进 source.sections，方便以后按分区定位。 */
export const MEMORY_SECTION = 'session-seal-scripts:memory'

/**
 * 拼一条模型侧的 user 消息。形状与 dsh-llm 的 createUserMessage 一致
 * （role + id + content + source），全部是普通 JSON，能被 session.append 快照。
 * @param {string} text
 */
export function memoryMessage(text) {
  const value = String(text ?? '')
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: value }],
    source: { kind: MEMORY_SOURCE_KIND, form: 'snapshot', sections: [{ name: MEMORY_SECTION, text: value }] }
  }
}

/**
 * 把回顾正文与日记提醒拼成同一条消息。
 * 「概括提醒 = 在上下文提醒」时用它：提醒并进回顾正文（0.1.46 的做法），
 * 日记写完 -> 正文不再带提醒 -> 整条被 replace -> 催促自动消失。
 * 设置页预览也调它，保证框里和实况字字相同。
 * @param {string} memoryText
 * @param {string} diaryText
 * @returns {string}
 */
export function composeInjection(memoryText, diaryText) {
  const memory = String(memoryText ?? '').trim()
  const diary = String(diaryText ?? '').trim()
  if (diary === '') return memory
  if (memory === '') return diary
  return memory + '\n\n' + diary
}

/** 这条消息是不是我们注入的。 */
export function isMemorySource(source) {
  return source !== null && typeof source === 'object' && source.kind === MEMORY_SOURCE_KIND
}

/** 取一条消息的纯文本；不是「恰好一个 text 块」就给空串。 */
function textOf(message) {
  const content = message?.content
  if (!Array.isArray(content) || content.length !== 1) return ''
  return typeof content[0]?.text === 'string' ? content[0].text : ''
}

/**
 * surface 上我们注入的那一条（最新的一条）；没有就是 null。
 * 只看 surface，不看整本日志 —— 被压缩吞掉的旧条目不算数。
 * @returns {null | {seq:number, text:string}}
 */
export function memoryNodeOnSurface(session) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return null
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const seq = nodes[i]
    const event = session.eventAt(seq)
    if (event === undefined || event === null) continue
    if (event.type !== 'user/message') continue
    if (!isMemorySource(event.data?.source)) continue
    return { seq, text: textOf(event.data) }
  }
  return null
}

/** 回顾已经以自己的 kind 注入了吗（runtime-context 兜底那条据此决定要不要供货）。 */
export function memoryAlreadyInjected(session) {
  return memoryNodeOnSurface(session) !== null
}

/**
 * surface 上还没有系统提示吗？
 *
 * 系统提示是 agent-loop 在 step() 里提交的，而 pre-step 跑在它之前。所以全新会话
 * 的第一轮如果这时直接 session.append，消息会排在系统提示**前面**，请求就变成
 * [user, system, …]。这种时候必须把消息交给 decision.messages，让 loop 在系统
 * 提示之后统一追加。
 */
export function needsDecisionPath(session) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return false
  for (const seq of nodes) {
    if (session.eventAt(seq)?.type === 'system/message') return false
  }
  return true
}

/**
 * 这一步该怎么注入：没文字就跳过；系统提示还没落盘就走 decision.messages；其余直接写。
 * @param {object} session
 * @param {string} text
 * @returns {{mode:'skip'} | {mode:'decision', message:object} | {mode:'direct', result:object}}
 */
export function planInjection(session, text) {
  const value = String(text ?? '')
  if (value === '') return { mode: 'skip' }
  if (session === null || typeof session !== 'object') return { mode: 'skip' }
  if (needsDecisionPath(session)) return { mode: 'decision', message: memoryMessage(value) }
  return { mode: 'direct', result: injectMemory(session, value) }
}

/**
 * 注入一条回顾：
 *   文本没变 -> 不动；变了 -> 替换掉自己上一条；换不了 -> 追加。
 * 更换失败（上一条已被压缩吞掉、或宿主拒绝替换）不能变成「这一轮没有回顾」。
 * @param {object} session
 * @param {string} text
 * @returns {{action:'skip'|'append'|'replace', seq?:number, fallbackFrom?:string}}
 */
export function injectMemory(session, text) {
  const value = String(text ?? '')
  if (session === null || typeof session !== 'object' || typeof session.append !== 'function') {
    throw new Error('没有可写入的会话')
  }
  const previous = memoryNodeOnSurface(session)
  if (previous !== null && previous.text === value) return { action: 'skip', seq: previous.seq }
  if (previous !== null) {
    try {
      const event = session.append('user/message', memoryMessage(value), {
        surfaceOp: { op: 'replace', startSeq: previous.seq, endSeq: previous.seq },
        sourceEventSeqs: [previous.seq]
      })
      return { action: 'replace', seq: event.seq }
    } catch (error) {
      const event = session.append('user/message', memoryMessage(value), { surfaceOp: 'append' })
      return { action: 'append', seq: event.seq, fallbackFrom: error?.message ?? String(error) }
    }
  }
  const event = session.append('user/message', memoryMessage(value), { surfaceOp: 'append' })
  return { action: 'append', seq: event.seq }
}
