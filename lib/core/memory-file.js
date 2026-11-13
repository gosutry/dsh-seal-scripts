/**
 * 回顾文件的文本格式：生成、解析、改字段。纯函数，不碰文件系统。
 *
 * 结构见设计文档第二节：头部字段 + 三个分区，分区之间用随机 id 的注释标记隔开。
 * 随机 id 每次生成文件时现打，模型无法预知，所以伪造不了分区边界。
 */

import { randomBytes } from 'node:crypto'
import {
  headerLabels, headerAliases, sectionTitle, sectionLangOf,
  coversValue, branchValue, toolCallsValue, lockedValue
} from './lang.js'

/** 分区标记的正则片段：<!--ovr:7f3a2c:body--> */
const MARKER_RE = /<!--ovr:([0-9a-f]{6}):(sum|body|diary)-->/g

/** 正文里出现注释开头时的转义形式，打断 <!-- 的匹配。 */
const ESCAPED = '<!\\--ovr'

/** 生成六个十六进制字符的随机 id。 */
export function randomId() {
  return randomBytes(3).toString('hex')
}

/**
 * 把正文里的注释开头打断，避免正文伪造分区标记。
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkers(text) {
  return String(text ?? '')
    // 本来就长成转义形态的文本（<!--ovr）先把反斜杠加倍，
    // 否则还原时会把它的反斜杠当成我们加的，一个字符对不上。
    .replace(/<!(\\+)--ovr/g, (_, bs) => '<!' + bs + bs + '--ovr')
    .replace(/<!--ovr/g, ESCAPED)
}

/**
 * escapeMarkers 的反向还原。解析时用，保证「写进去什么，读回来就是什么」：
 * 转义只活在文件里，出了分区就是原文。
 * 可逆性：escape 产出的反斜杠段只有「单个」（打断）和「偶数个」（原文自带、已加倍）
 * 两种，所以偶数减半、单个去掉，都能对回原样。
 * @param {string} text
 * @returns {string}
 */
export function unescapeMarkers(text) {
  const s = String(text ?? '')
  if (!s.includes('<!')) return s
  return s.replace(/<!(\\+)--ovr/g, (_, bs) => '<!' + bs.slice(0, bs.length >> 1) + '--ovr')
}

/** 千分位，用于 token 数。 */
function thousands(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 本地时区的时间戳：2026-10-28 05:59 */
export function stampOf(date) {
  const p = (n) => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate()) +
    ' ' + p(date.getHours()) + ':' + p(date.getMinutes())
}

/** 文件名用：20261028-055942-96358e1b */
export function fileStemOf(date, compactionId) {
  const p = (n) => String(n).padStart(2, '0')
  const day = '' + date.getFullYear() + p(date.getMonth() + 1) + p(date.getDate())
  const clock = p(date.getHours()) + p(date.getMinutes()) + p(date.getSeconds())
  return day + '-' + clock + '-' + String(compactionId).replace(/-/g, '').slice(0, 8)
}

/**
 * 拼一份完整的回顾文件。
 * 文件头字段名与分区标题按 lang（拆解那一刻 DSH 的语言）写；
 * 关键词与日记一开始就留空——不写「未总结」「（空）」这类占位。
 * @param {object} spec
 * @param {'zh'|'en'|string} [lang]
 * @returns {string}
 */
export function buildMemoryFile(spec, lang = 'zh') {
  const L = headerLabels(lang)
  const id = randomId()
  const lines = [
    '# ' + L.title + ' · ' + stampOf(spec.date),
    '',
    '- compactionId: ' + spec.compactionId,
    '- ' + L.covers + ': ' + coversValue(lang, spec.seqStart, spec.seqEnd, spec.seqCount),
    ...(spec.branchFrom ? ['- ' + L.branchFrom + ': ' + branchValue(lang, spec.branchFrom.file, spec.branchFrom.line)] : []),
    '- ' + L.tokens + ': ' + thousands(spec.tokenCount),
    '- ' + L.toolCalls + ': ' + toolCallsValue(lang, spec.toolCalls, spec.toolFailures),
    '- ' + L.keywords + ':',
    '- ' + L.depth + ': ' + spec.count,
    '- ' + L.locked + ': ' + lockedValue(lang, false),
    '',
    '<!--ovr:' + id + ':sum-->',
    '',
    '## ' + sectionTitle(lang, 'sum'),
    '',
    escapeMarkers(spec.summary).trim(),
    '',
    '<!--ovr:' + id + ':body-->',
    '',
    '## ' + sectionTitle(lang, 'body'),
    '',
    escapeMarkers(spec.body).trim(),
    '',
    '<!--ovr:' + id + ':diary-->',
    '',
    '## ' + sectionTitle(lang, 'diary'),
    ''
  ]
  return lines.join('\n')
}

/**
 * 把文件拆回头部字段与三个分区。
 * @param {string} text
 * @returns {{ meta: Record<string,string>, ids: string, sections: { sum: string, body: string, diary: string }, id: string }}
 */
export function parseMemory(text) {
  const src = String(text ?? '')
  const meta = {}
  const headEnd = src.search(MARKER_RE)
  const head = headEnd === -1 ? src : src.slice(0, headEnd)
  for (const line of head.split('\n')) {
    const m = /^-\s+([^:：]+)[:：]\s*(.*)$/.exec(line)
    if (m) meta[m[1].trim()] = m[2].trim()
  }

  const marks = []
  MARKER_RE.lastIndex = 0
  let hit
  while ((hit = MARKER_RE.exec(src)) !== null) {
    marks.push({ id: hit[1], key: hit[2], start: hit.index, after: hit.index + hit[0].length })
  }
  const ids = marks.length > 0 ? marks.map((m) => m.id).join(',') : ''
  const sections = { sum: '', body: '', diary: '' }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i]
    // 同 id 才算这一段；别的 id 的标记是正文里的残留，不作为边界。
    const end = (() => {
      for (let j = i + 1; j < marks.length; j++) if (marks[j].id === mark.id) return marks[j].start
      return src.length
    })()
    const raw = src.slice(mark.after, end)
    const stripped = raw.replace(/^\s*##\s*[^\n]*\n?/, '').trim()
    sections[mark.key] = unescapeMarkers(stripped)
  }
  return { meta, ids, id: marks.length > 0 ? marks[0].id : '', sections }
}

/**
 * 改头部的一个字段，其余字节不动。
 * @param {string} text
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
export function setHeaderField(text, key, value) {
  const src = String(text ?? '')
  const headEnd = src.search(MARKER_RE)
  const head = headEnd === -1 ? src : src.slice(0, headEnd)
  const rest = headEnd === -1 ? '' : src.slice(headEnd)
  // 冒号后只用行内空白：字段值为空时用 \s* 会把换行吃掉，下一行被一起替换。
  // 重写整行（而不是只换值）：空值行也能稳定得到「- key: value」的形态。
  const re = new RegExp('^-\\s+' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[:：][ \\t]*.*$', 'm')
  if (!re.test(head)) return null
  const line = '- ' + key + ': ' + String(value)
  return head.replace(re, line) + rest
}

/**
 * 按逻辑字段名改头部：两种语言的写法都试一遍，其余字节不动。
 * @param {string} text
 * @param {string} field 见 lang.js 的 headerAliases
 * @param {string} value
 * @returns {string|null} null 表示这份文件里没有这个字段
 */
export function setField(text, field, value) {
  for (const key of headerAliases(field)) {
    const out = setHeaderField(text, key, value)
    if (out !== null) return out
  }
  return null
}

/* sectionLangOf 搬进了 lang.js（0.5.2：8 种语言都要认）。 */

/**
 * 换掉一个分区的内容，其余字节不动。标题跟着这份文件自己的语言走。
 * @param {string} text
 * @param {'sum'|'body'|'diary'} key
 * @param {string} content
 * @returns {string|null} null 表示找不到该分区
 */
export function setSection(text, key, content) {
  const src = String(text ?? '')
  const parsed = parseMemory(src)
  if (!parsed.id) return null
  const open = '<!--ovr:' + parsed.id + ':' + key + '-->'
  const at = src.indexOf(open)
  if (at === -1) return null
  const after = at + open.length
  let end = src.length
  MARKER_RE.lastIndex = after
  const next = MARKER_RE.exec(src)
  if (next) end = next.index
  const title = '## ' + sectionTitle(sectionLangOf(src), key)
  const block = '\n\n' + title + '\n\n' + escapeMarkers(content).trim() + '\n'
  return src.slice(0, after) + block + src.slice(end)
}
