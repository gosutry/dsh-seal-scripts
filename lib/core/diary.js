/**
 * 该补写的回顾的提醒（0.2.3）。
 *
 * 判定：**载入级别 ≤ 1 的回顾，只要关键词或日记还有一项空着，就催。**
 *   0 级：显示的是关键词 + 文件名，关键词空着就催；
 *   1 级：显示的是日记，日记空着就催。
 * 催一次就把两项一起写完（读原文 → 关键词 → 日记），所以任一为空都算「还没写全」。
 * 一条提醒把本工作区所有这样的回顾一次列全，按压缩时刻从旧到新。
 *
 * 语言跟 DSH 设置走（lang.js 里的词条），这里只拼装。
 * 这里只读文件，不写盘。
 */

import { memoryDir } from './store.js'
import { readAssemblySync, readMemorySync, loadLevel, dayIndex, shortDateOf } from './assembly.js'
import { readOptionsSync } from './settings.js'
import {
  phrasesFor, isBlankDiary, isBlankKeywords, readField,
  MISSING_KEYWORDS, MISSING_DIARY, LANG_ZH
} from './lang.js'
import { readLocaleSync } from './locale.js'

// 老名字继续可用（测试与别处都在用）。
export { isBlankDiary }

/**
 * 这一轮该催的回顾：载入级别 0 或 1，且关键词/日记至少一项空着。
 * @param {string} dshHome
 * @param {string} cwd
 * @param {Date} now
 * @param {object} options
 * @returns {Array<{dir:string, entry:object, parsed:object, level:number, missing:string[]}>}
 */
export function pendingDiaries(dshHome, cwd, now = new Date(), options = readOptionsSync(dshHome)) {
  const dir = memoryDir(dshHome, cwd)
  const data = readAssemblySync(dir)
  if (!data || !Array.isArray(data.entries) || data.entries.length === 0) return []
  const ordered = data.entries
    .filter((e) => e && typeof e.file === 'string')
    .slice()
    .sort((a, b) => String(a.compactedAt).localeCompare(String(b.compactedAt)))
  const out = []
  for (const entry of ordered) {
    // 只有「显示的就是关键词/日记」那两级才催；摘要、原文两级不催。
    const level = loadLevel(entry, now, options)
    if (level > 1) continue
    const parsed = readMemorySync(dir, entry.file)
    if (!parsed) continue
    const missing = []
    if (isBlankKeywords(readField(parsed.meta, 'keywords'))) missing.push(MISSING_KEYWORDS)
    if (isBlankDiary(parsed.sections ? parsed.sections.diary : '')) missing.push(MISSING_DIARY)
    if (missing.length === 0) continue
    out.push({ dir, entry, parsed, level, missing })
  }
  return out
}

/**
 * 拼提醒文本。纯函数：只读词条，不记账。
 * @param {Array<{entry:object, missing?:string[]}>|{entry:object}} found pendingDiaries 的返回值（也收单条）
 * @param {Date} now
 * @param {'zh'|'en'} lang
 * @returns {string}
 */
export function reminderTextOf(found, now = new Date(), lang = LANG_ZH) {
  const list = Array.isArray(found) ? found : [found]
  const ready = list.filter((item) => item && item.entry && typeof item.entry.file === 'string')
  if (ready.length === 0) return ''
  const P = phrasesFor(lang)
  const head = P.reminderHead(ready.length)
  // 每份只列一行「哪一份、缺什么」；读与写怎么做由下面一组共用步骤说一次（0.2.7：
  // 一次 writes 把全部写完，不在每块里重复三段调用）。
  const blocks = ready.map((item, i) => {
    const { entry } = item
    const keys = Array.isArray(item.missing) && item.missing.length > 0
      ? item.missing
      : [MISSING_KEYWORDS, MISSING_DIARY]
    const missing = keys.map((k) => (k === MISSING_KEYWORDS ? P.keywordsWord : P.diaryWord))
    const tag = ready.length === 1 ? '' : '【' + (i + 1) + '/' + ready.length + '】'
    return P.reminderItem(tag, entry.file, shortDateOf(entry.compactedAt), dayIndex(entry.compactedAt, now), P.missingLabel(missing))
  })
  // 收尾一句写死态度：全部写完再继续、不核对回读、不复述（0.2.7 起）。
  return [head, ...blocks, ...P.reminderSteps(ready.map((item) => item.entry.file)), P.reminderTail()].join('\n')
}

/**
 * 这一轮要注入的提醒；没有就给空串。
 * 只要还有该补写的回顾就有内容，全写齐自然变成空串，提醒随之消失。
 * @param {string} dshHome
 * @param {string} cwd
 * @param {Date} now
 * @param {object} options
 * @param {'zh'|'en'} lang 默认读语言文件（跟 DSH 设置走）
 * @returns {string}
 */
export function diaryReminder(dshHome, cwd, now = new Date(), options = readOptionsSync(dshHome), lang = readLocaleSync(dshHome)) {
  const list = pendingDiaries(dshHome, cwd, now, options)
  if (list.length === 0) return ''
  return reminderTextOf(list, now, lang)
}
