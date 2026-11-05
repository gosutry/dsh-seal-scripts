/**
 * 清单词快照（0.4.5）：把「工具组」那一段系统提示词按会话冻住。
 *
 * 为什么要有这一层：catalogText() 每轮现算，装/删一个工具脚本，下一轮系统提示词就变，
 * 而系统提示词一变，整份会话就要当未缓存输入重发一次——老会话里加一个工具，代价是
 * 把几百轮的上下文重新计费送一遍。默认档「新会话开始之前」的取舍是：会话第一次装配时
 * 取一次现词，之后固定——但 0.4.6 起，用户每改一次「清单词刷新时刻」，就把所有已记住的
 * 会话刷新成那一刻的现词（切到实时、切回默认，两个方向都算）。
 *
 * 两件不冻的事（都是有意的）：
 *   1. 换语言：用户主动切语言时立刻重算，不然设置页刚切成英文、这里还挂着中文。
 *   2. 关掉「注入工具组清单」：直接返回空串，这一段整个不注入（开关优先于快照）。
 *
 * 认不出会话 id 时退回现算（realtime 的行为）：宁可多一次缓存未命中，也不要两次装配
 * 冻成不同内容——那会让同一会话的两轮系统提示词在边界上跳一下。
 *
 * 记忆只在本进程里，重启就没了：重启后第一次装配等于「新会话开始之前」再取一次现词，
 * 与这一档的语义一致（重启后整份缓存本来也要重建）。
 */

import { catalogText } from './schema.js'

/** 最多记住多少个会话的清单，超出按插入顺序丢最旧的（Map 保序）。 */
export const MAX_SNAPSHOTS = 64

/** @type {Map<string, {text: string, lang: string}>} */
const snapshots = new Map()

/**
 * 取这个会话该用的清单文本：第一次调用算并记住，之后原样返回。
 * @param {string} dshHome
 * @param {string} lang 显示语言；和记住的那次不同就重算并覆盖
 * @param {string} sessionId 会话标识；空串表示认不出会话，退回现算
 * @returns {string}
 */
export function catalogTextForSession(dshHome, lang, sessionId) {
  const key = typeof sessionId === 'string' ? sessionId : ''
  if (key === '') return catalogText(dshHome, lang)
  const hit = snapshots.get(key)
  if (hit !== undefined && hit.lang === lang) return hit.text
  const text = catalogText(dshHome, lang)
  // 覆盖已有键时要先删再插：Map 的插入顺序决定谁先被挤出去，重算过的会话应排到队尾。
  snapshots.delete(key)
  snapshots.set(key, { text, lang })
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next()
    if (oldest.done) break
    snapshots.delete(oldest.value)
  }
  return text
}

/**
 * 把已经记住的每个会话都改成「此刻的现词」（0.4.6）。
 *
 * 触发点只有一个：用户改「清单词刷新时刻」的那一下（两个方向都算）。
 * 这就是要的语义——A→B 时按磁盘现状注入，B→A 时把那一刻的现状冻住；
 * 之后停在 A，装/删工具脚本都不再动提示词，直到下一次切档。
 * 还没装配过的会话不建快照：它们第一次装配时自然取现词。
 * @param {string} dshHome
 * @param {string} lang
 * @returns {{refreshed: number, text: string}}
 */
export function refreshCatalogSnapshots(dshHome, lang) {
  const text = catalogText(dshHome, lang)
  for (const key of snapshots.keys()) snapshots.set(key, { text, lang })
  return { refreshed: snapshots.size, text }
}

/** 清空全部快照（测试与「立刻重算」用）。 */
export function resetCatalogSnapshots() {
  snapshots.clear()
}

/** 现在记住了哪些会话（测试用）。 */
export function catalogSnapshotKeys() {
  return [...snapshots.keys()]
}
