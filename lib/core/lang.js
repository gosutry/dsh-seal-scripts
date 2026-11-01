/**
 * 语言层（0.2.3）。
 *
 * 回顾文件里的中文标记就是「通配键」：文件本身一个字节不改，
 * 注入与注入框预览按 DSH 当前语言换成对应文字——切换语言只改显示，不改数据。
 *
 * 文件里存在的通配键：
 *   正文行首   [用户] / [模型] / ▸ / ◂
 *   ◂ 行的尾巴 报错：… / 完成
 *   空位      （空）/（未总结）
 * 英文分别显示为 [user] / [model] / ▸ / ◂ / error: / done / (none)。
 *
 * 这里只放纯函数与词条，不碰文件系统。
 */

/** 插件认识的两种语言。 */
export const LANG_ZH = 'zh'
export const LANG_EN = 'en'

/** 提醒里「缺什么」的两项。 */
export const MISSING_KEYWORDS = 'keywords'
export const MISSING_DIARY = 'diary'

/**
 * 把 DSH 的 locale id 收成两种：en / en-* 算英语，其余一律中文。
 * @param {string|undefined|null} id
 * @returns {'zh'|'en'}
 */
export function normalizeLang(id) {
  const s = typeof id === 'string' ? id.trim().toLowerCase() : ''
  return s === 'en' || s.startsWith('en-') || s.startsWith('en_') ? LANG_EN : LANG_ZH
}

/** 中文词条：文件里的中文标记就是这些键的原文。 */
const ZH = Object.freeze({
  preamble: () => '以下是本工作区的历史回顾，按时间从旧到新排列（越靠后离现在越近）。',
  reviewHead: (date) => '【回顾 · ' + date + '】',
  none: '（未总结）',
  noDialogue: '（这段没有对话）',
  noSummary: '（这段没有摘要）',
  noBody: '（这段没有原文）',
  keywordsWord: '关键词',
  diaryWord: '日记',
  missingLabel: (list) => list.join('、'),
  errorTag: '报错：',
  doneTag: '完成',
  reminderHead: (n) => (n <= 1
    ? '【必须这一轮补齐回顾】这份回顾的关键词和日记还空着。在这一轮里补完，不要分几次做：'
    : '【必须这一轮补齐回顾】本工作区有 ' + n + ' 份回顾的关键词和日记还空着。在这一轮里全部补完，不要一份一份分开做：'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + '（' + date + ' 压缩，第 ' + day + ' 天；缺：' + missing + '）',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<关键词>"], diary: "<日记>" }').join(', ')
    return [
      '1. 先读原文（只含对话，不含工具调用）：' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join('、'),
      '2. 再用一次调用把' + (list.length <= 1 ? '它' : '全部') + '写完：session_mem_write({ writes: [' + sample + '] })',
      '3. 全部写完再继续，不要写一份就停下来。'
    ]
  },
  reminderTail: () => '以上是硬性要求：写完不要为了核对再读一遍文件，也不要在回复里复述日记内容。'
})

/** 英文词条。 */
const EN = Object.freeze({
  preamble: () => 'Earlier reviews from this workspace, oldest first (the later ones are closer to now).',
  reviewHead: (date) => '【Review · ' + date + '】',
  none: '(none)',
  noDialogue: '(no dialogue in this segment)',
  noSummary: '(no summary for this segment)',
  noBody: '(no original text in this segment)',
  keywordsWord: 'keywords',
  diaryWord: 'diary',
  missingLabel: (list) => list.join(' + '),
  errorTag: 'error: ',
  doneTag: 'done',
  reminderHead: (n) => (n <= 1
    ? '【ACTION REQUIRED — DO IT NOW】This review\'s keywords and diary are still empty. Finish it in THIS turn, not in several rounds:'
    : '【ACTION REQUIRED — DO IT NOW】' + n + ' reviews in this workspace still lack keywords and/or diary. ' +
      'Finish them all in THIS turn, not one at a time:'),
  reminderItem: (tag, file, date, day, missing) =>
    tag + file + ' (compacted ' + date + ', day ' + day + '; missing: ' + missing + ')',
  reminderSteps: (files) => {
    const list = Array.isArray(files) ? files : [files]
    const sample = list.map((f) => '{ file: "' + f + '", keywords: ["<keywords>"], diary: "<diary>" }').join(', ')
    return [
      '1. Read each original first (dialogue only, tool calls excluded): ' + list.map((f) => 'session_mem_write({ file: "' + f + '" })').join(', '),
      '2. Then write ' + (list.length <= 1 ? 'it' : 'all of them') + ' in one call: session_mem_write({ writes: [' + sample + '] })',
      '3. Finish all of them before continuing; do not stop after one file.'
    ]
  },
  reminderTail: () => 'This is a hard requirement: do not re-read files to verify afterwards, and do not repeat the diary content in your reply.'
})

/**
 * 取这一种语言的词条。
 * @param {'zh'|'en'|string} lang
 * @returns {object}
 */
export function phrasesFor(lang) {
  return normalizeLang(lang) === LANG_EN ? EN : ZH
}

/** 正文行首与 ◂ 尾巴的英文映射：中文标记是通配键，英文在这里换字。 */
const EN_LINE_MAP = [
  [/^\[用户\] /gm, '[user] '],
  [/^\[模型\] /gm, '[model] '],
  [/^◂ 报错：/gm, '◂ error: '],
  [/^◂ 完成$/gm, '◂ done']
]

/**
 * 把原文正文按语言换字。中文原样返回（文件里的中文就是通配键本身）。
 * @param {string} body
 * @param {'zh'|'en'|string} lang
 * @returns {string}
 */
export function localizeBody(body, lang) {
  const text = String(body ?? '')
  if (normalizeLang(lang) !== LANG_EN) return text
  let out = text
  for (const [re, to] of EN_LINE_MAP) out = out.replace(re, to)
  return out
}

/** 日记区算不算空：空串、文件里的占位（空），以及新约定的（未总结）/(none) 都算。 */
export function isBlankDiary(diary) {
  const t = String(diary === undefined || diary === null ? '' : diary).trim()
  return t === '' || t === '（空）' || t === '(空)' || t === '（未总结）' || t === '(none)'
}

/** 关键词算不算没写：空串、旧文件的哨兵「未总结」，以及显示占位都算。 */
export function isBlankKeywords(keywords) {
  const t = String(keywords === undefined || keywords === null ? '' : keywords).trim()
  return t === '' || t === '未总结' || t === '（未总结）' || t === '(none)'
}

/* ── 回顾文件本身的语言（0.2.5）─────────────────────────────────
 * 拆解那一刻按 DSH 当前语言写文件头与分区标题：中文文件用「关键词」，
 * 英文文件用 keywords。读的时候两种都认（老文件照旧能读能写）。
 */

/** 文件头字段名，两种语言各一套。 */
const HEADERS = Object.freeze({
  zh: Object.freeze({
    title: '回顾',
    covers: '覆盖 seq',
    branchFrom: '承接自',
    tokens: '被压 token',
    toolCalls: '工具调用',
    keywords: '关键词',
    depth: '深度',
    locked: '锁定'
  }),
  en: Object.freeze({
    title: 'Review',
    covers: 'covers seq',
    branchFrom: 'branched from',
    tokens: 'compacted tokens',
    toolCalls: 'tool calls',
    keywords: 'keywords',
    depth: 'depth',
    locked: 'locked'
  })
})

/** 三个分区的标题。 */
const SECTION_TITLES = Object.freeze({
  zh: Object.freeze({ sum: '摘要', body: '原文', diary: '日记' }),
  en: Object.freeze({ sum: 'Summary', body: 'Original', diary: 'Diary' })
})

/**
 * 写文件头时用的字段名。
 * @param {'zh'|'en'|string} lang
 * @returns {object}
 */
export function headerLabels(lang) {
  return normalizeLang(lang) === LANG_EN ? HEADERS.en : HEADERS.zh
}

/**
 * 一个逻辑字段的两种写法（先中文后英文）。
 * @param {'title'|'covers'|'branchFrom'|'tokens'|'toolCalls'|'keywords'|'depth'|'locked'} field
 * @returns {string[]}
 */
export function headerAliases(field) {
  const zh = HEADERS.zh[field]
  const en = HEADERS.en[field]
  return zh === en ? [zh] : [zh, en]
}

/**
 * 从 parseMemory 的 meta 里取一个逻辑字段，两种语言的写法都认；没有就给空串。
 * @param {Record<string,string>|undefined|null} meta
 * @param {string} field
 * @returns {string}
 */
export function readField(meta, field) {
  if (!meta || typeof meta !== 'object') return ''
  for (const key of headerAliases(field)) {
    if (Object.prototype.hasOwnProperty.call(meta, key)) return meta[key]
  }
  return ''
}

/**
 * 分区标题。
 * @param {'zh'|'en'|string} lang
 * @param {'sum'|'body'|'diary'} key
 * @returns {string}
 */
export function sectionTitle(lang, key) {
  const table = normalizeLang(lang) === LANG_EN ? SECTION_TITLES.en : SECTION_TITLES.zh
  return table[key]
}

/** 文件头各字段的值（随语言）。 */
export function coversValue(lang, start, end, count) {
  return normalizeLang(lang) === LANG_EN
    ? start + '\u2013' + end + ' (' + count + ' entries)'
    : start + '\u2013' + end + '（' + count + ' 条）'
}

export function branchValue(lang, file, line) {
  return normalizeLang(lang) === LANG_EN
    ? file + ' line ' + line
    : file + ' 第 ' + line + ' 行'
}

export function toolCallsValue(lang, calls, failures) {
  return normalizeLang(lang) === LANG_EN
    ? calls + ' calls (' + failures + ' failed)'
    : calls + ' 次（失败 ' + failures + '）'
}

export function lockedValue(lang, locked) {
  const on = locked === true
  if (normalizeLang(lang) === LANG_EN) return on ? 'yes' : 'no'
  return on ? '是' : '否'
}

/** 从「工具调用」这一行的值里取次数与失败数，中英两种写法都认。 */
export function parseToolCounts(text) {
  const s = String(text === undefined || text === null ? '' : text)
  let m = /(\d+)\s*次（失败\s*(\d+)）/.exec(s)
  if (m) return { calls: Number(m[1]), failures: Number(m[2]) }
  m = /(\d+)\s*calls?\s*\(\s*(\d+)\s*failed\s*\)/i.exec(s)
  if (m) return { calls: Number(m[1]), failures: Number(m[2]) }
  return { calls: 0, failures: 0 }
}
