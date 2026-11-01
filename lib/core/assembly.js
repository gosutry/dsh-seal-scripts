/**
 * 装配：把本工作区的回顾按自然日衰减后，拼成一段进上下文的文本。
 *
 * 全是同步读：systemPrompt.context() 的 text 是同步求值的（resolveContext 直接调用，
 * 不 await），所以这里不能用 await。每轮求值一次、永远读最新磁盘状态，
 * 于是同一个工作区的所有会话在同一时刻看到同一份回顾 —— 和 AGENTS.md 一样的保证。
 */

import fs from 'node:fs'
import path from 'node:path'
import { memoryDir } from './store.js'
import { parseMemory } from './memory-file.js'
import { dialogueOnly } from './render.js'
import { DEFAULT_OPTIONS, readOptionsSync } from './settings.js'
import { composeInjection } from './inject.js'
import { phrasesFor, localizeBody, isBlankDiary, isBlankKeywords, readField, LANG_ZH } from './lang.js'
import { readLocaleSync } from './locale.js'

/** 一天的毫秒数。 */
const DAY = 86400000

/**
 * 自然日差（含当天算第一天）。按本地日期算，不看小时。
 * @param {string} compactedAt ISO 时间
 * @param {Date} now
 * @returns {number} 1 表示压缩当天
 */
export function dayIndex(compactedAt, now = new Date()) {
  const then = new Date(compactedAt)
  if (Number.isNaN(then.getTime())) return 1
  const a = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((b - a) / DAY) + 1
}

/**
 * 自然衰减到的深度：第 1 天 3、第 2 天 2、第 3–28 天 1、第 29 天起 0。
 * @param {string} compactedAt
 * @param {Date} now
 * @returns {0|1|2|3}
 */
export function naturalCount(compactedAt, now = new Date()) {
  const day = dayIndex(compactedAt, now)
  if (day <= 1) return 3
  if (day === 2) return 2
  if (day <= 28) return 1
  return 0
}

/**
 * 这一条此刻的有效深度。锁定过的回顾不再衰减；开了「停止降低」，全部停在记下的深度。
 * @param {{compactedAt:string, count:number, pinned:boolean}} entry
 * @param {Date} now
 * @param {object} options 选项（默认值 = 现版本行为：按自然日衰减）
 * @returns {0|1|2|3}
 */
export function effectiveCount(entry, now = new Date(), options = DEFAULT_OPTIONS) {
  const stored = typeof entry.count === 'number' ? entry.count : null
  if (options !== null && typeof options === 'object' && options.stopLowering === true && stored !== null) return stored
  if (entry.pinned && stored !== null) return stored
  return naturalCount(entry.compactedAt, now)
}

/**
 * 这一条载入时用哪一级：选了具体数字就用它，否则跟随深度。
 * 只影响载入，不动载入文件里记下的 count / pinned。
 * @param {object} entry
 * @param {Date} now
 * @param {object} options
 * @returns {0|1|2|3}
 */
export function loadLevel(entry, now = new Date(), options = DEFAULT_OPTIONS) {
  const forced = options !== null && typeof options === 'object' ? options.loadLevel : undefined
  if (Number.isInteger(forced) && forced >= 0 && forced <= 3) return forced
  return effectiveCount(entry, now, options)
}

/** 载入数值选了具体数字吗（设置页据此把深度徽章标成「载入覆盖」）。 */
export function isLevelForced(options = DEFAULT_OPTIONS) {
  return options !== null && typeof options === 'object' &&
    Number.isInteger(options.loadLevel) && options.loadLevel >= 0 && options.loadLevel <= 3
}

/** 同步读载入文件；坏了就当空。 */
export function readAssemblySync(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, '_assembly.json'), 'utf8'))
    if (!parsed || !Array.isArray(parsed.entries)) return null
    return parsed
  } catch {
    return null
  }
}

/** 同步读一份回顾并解析；读不到返回 null。 */
export function readMemorySync(dir, file) {
  try {
    return parseMemory(fs.readFileSync(path.join(dir, file), 'utf8'))
  } catch {
    return null
  }
}

/** `10-27 23:04` 这样的短日期 + 时分（本地时间，和用户说的「29 号」一致）。 */
function shortDate(compactedAt) {
  const d = new Date(compactedAt)
  if (Number.isNaN(d.getTime())) return '??-?? ??:??'
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * 一条回顾按深度取内容。
 * @param {object} entry
 * @param {object} parsed parseMemory 的结果
 * @param {number} level 0–3
 * @param {object} options fullLoad 为真时，深度 3 也保留工具行与报错
 * @param {'zh'|'en'} lang 显示语言：中文标记是通配键，英文在这里换字（文件不动）
 * @returns {string}
 */
export function renderEntry(entry, parsed, level, options = DEFAULT_OPTIONS, lang = LANG_ZH) {
  const P = phrasesFor(lang)
  const head = P.reviewHead(shortDate(entry.compactedAt))
  const sections = parsed.sections ?? {}
  if (level >= 3) {
    const body = sections.body ?? ''
    const full = options !== null && typeof options === 'object' && options.fullLoad === true
    if (full) return head + '\n' + (localizeBody(body, lang) || P.noBody)
    const say = localizeBody(dialogueOnly(body), lang)
    return head + '\n' + (say || P.noDialogue)
  }
  if (level === 2) {
    return head + '\n' + (localizeBody(sections.sum, lang).trim() || P.noSummary)
  }
  if (level === 1) {
    // 日记空着（文件里写的是（空））时，按 0.2.3 的约定注入（未总结）/(none)。
    return head + '\n' + (isBlankDiary(sections.diary) ? P.none : sections.diary.trim())
  }
  // 深度 0：关键词 + 文件名一行。关键词没写就注入（未总结），文件名照旧留着。
  const keywords = readField(parsed.meta, 'keywords')
  const word = isBlankKeywords(keywords) ? P.none : keywords
  return head + ' ' + word + ' · ' + entry.file
}

/**
 * 拼出这一轮要注入的回顾文本。没有回顾就返回空串（空串会把条目整个移除）。
 * 选项在调用时读：每轮重算，设置页一改，下一轮立刻按新选项装配。
 * @param {string} dshHome
 * @param {string} cwd 工作区
 * @param {Date} now
 * @param {object} options 选项（默认从磁盘读）
 * @param {'zh'|'en'} lang 显示语言（默认读语言文件；文件不在就是中文）
 * @returns {string}
 */
export function buildMemoryContext(dshHome, cwd, now = new Date(), options = readOptionsSync(dshHome), lang = readLocaleSync(dshHome)) {
  const dir = memoryDir(dshHome, cwd)
  const data = readAssemblySync(dir)
  if (!data || data.entries.length === 0) return ''

  const ordered = [...data.entries]
    .filter((e) => e && typeof e.file === 'string')
    .sort((a, b) => String(a.compactedAt).localeCompare(String(b.compactedAt)))

  const blocks = []
  for (const entry of ordered) {
    const parsed = readMemorySync(dir, entry.file)
    if (!parsed) continue
    blocks.push(renderEntry(entry, parsed, loadLevel(entry, now, options), options, lang))
  }
  if (blocks.length === 0) return ''
  return phrasesFor(lang).preamble() + '\n\n' + blocks.join('\n\n')
}

/** 把一个工作区当前的载入状态读出来（设置页与测试用）。 */
export function snapshotAssembly(dshHome, cwd, now = new Date()) {
  const dir = memoryDir(dshHome, cwd)
  const data = readAssemblySync(dir)
  if (!data) return { dir, entries: [] }
  return {
    dir,
    entries: data.entries.map((e) => ({
      ...e,
      level: effectiveCount(e, now),
      age: dayIndex(e.compactedAt, now)
    }))
  }
}

/* ────────────────────────────────────────────────────────────────
 * 下面这些是后来补的：装配失败时指向「回顾过大」、以及给设置页看当前载入。
 * 全部同步，因为 systemPrompt.context() 的 text 是同步求值的。
 * ──────────────────────────────────────────────────────────────── */

/** 目录里每份 .md 的大小，从大到小。出错给空数组，不抛。 */
function memoryFileSizes(dir) {
  const out = []
  let names = []
  try { names = fs.readdirSync(dir) } catch { return out }
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    try { out.push({ name, bytes: fs.statSync(path.join(dir, name)).size }) } catch { /* 跳过读不到的单份 */ }
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

function kb(n) { return (n / 1024).toFixed(1) + ' KB' }

/**
 * 装配失败时给模型看的诊断。设计文档第十四节：报错要指向「回顾过大」。
 * 不静默返回空串——空串会让这一轮看起来像「本来就没有回顾」。
 */
export function oversizeDiagnostic(dshHome, cwd, error) {
  const dir = memoryDir(dshHome, cwd)
  const files = memoryFileSizes(dir)
  const total = files.reduce((n, f) => n + f.bytes, 0)
  const biggest = files[0]
  const lines = [
    '【回顾没有载入成功】工作区 ' + cwd + ' 的回顾装配失败，最可能是回顾过大。',
    '目录：' + dir,
    '现状：' + files.length + ' 份，合计 ' + kb(total) +
      (biggest ? '，最大 ' + biggest.name + '（' + kb(biggest.bytes) + '）' : ''),
    '处理：换到别的工作区的会话，或把上面最大的那份回顾删掉、精简后再回来。',
    '原始错误：' + (error && error.message ? error.message : String(error))
  ]
  return lines.join('\n')
}

/** buildMemoryContext 的安全版：失败时返回诊断文本，不返回空串。 */
export function buildMemoryContextOrDiagnostic(dshHome, cwd, now = new Date(), options = readOptionsSync(dshHome)) {
  try {
    return buildMemoryContext(dshHome, cwd, now, options)
  } catch (err) {
    return oversizeDiagnostic(dshHome, cwd, err)
  }
}

/**
 * 设置页用：这一刻真正会被载入的文字，外加每一条用了哪一级。
 * 与注入走同一个 buildMemoryContext（选项也同一份），所以框里看到的就是真的；
 * 概括提醒在「上下文提醒」档要并进同一条消息，所以由调用方把提醒文本递进来，
 * 这里用和注入同一个 composeInjection 拼——预览与实况字字相同。
 */
export function describeLoad(dshHome, cwd, now = new Date(), options = readOptionsSync(dshHome), reminder = '', disabled = options.injectEnabled === false) {
  const dir = memoryDir(dshHome, cwd)
  const data = readAssemblySync(dir)
  const forced = isLevelForced(options)
  const entries = []
  if (data) {
    for (const entry of data.entries) {
      if (!entry || typeof entry.file !== 'string') continue
      const parsed = readMemorySync(dir, entry.file)
      entries.push({
        file: entry.file,
        compactedAt: entry.compactedAt,
        level: loadLevel(entry, now, options),
        markedLevel: effectiveCount(entry, now, options),
        loadForced: forced,
        age: dayIndex(entry.compactedAt, now),
        pinned: entry.pinned === true,
        bytes: parsed ? Buffer.byteLength(JSON.stringify(parsed.sections), 'utf8') : 0,
        ok: parsed !== null
      })
    }
    entries.sort((a, b) => String(a.compactedAt).localeCompare(String(b.compactedAt)))
  }
  let text = ''
  let error = null
  // 注入总开关开着才拼文本；关着就只列条目（设置页仍然能看有哪些回顾）。
  if (!disabled) {
    try {
      text = composeInjection(buildMemoryContext(dshHome, cwd, now, options), reminder)
    } catch (err) {
      error = err
      text = oversizeDiagnostic(dshHome, cwd, err)
    }
  }
  return {
    cwd,
    dir,
    text,
    chars: text.length,
    entries,
    loadForced: forced,
    disabled,
    error: error ? (error.message ? error.message : String(error)) : null
  }
}

/**
 * 设置页用：只看某一条回顾时，它自己会被注入成什么样子。
 * 与 buildMemoryContext 里对这条走的是同一个 renderEntry（同一份选项），所以框里看到的还是真话。
 * @param {string} dshHome
 * @param {string} cwd
 * @param {string} file
 * @param {Date} now
 * @param {object} options
 */
export function describeEntry(dshHome, cwd, file, now = new Date(), options = readOptionsSync(dshHome)) {
  const dir = memoryDir(dshHome, cwd)
  const data = readAssemblySync(dir)
  const name = String(file ?? '')
  const entry = data && Array.isArray(data.entries)
    ? data.entries.find((e) => e && e.file === name)
    : null
  if (!entry) {
    return { file: name, text: '', chars: 0, level: null, age: null, error: '这条回顾不在载入清单里：' + name }
  }
  const parsed = readMemorySync(dir, entry.file)
  if (!parsed) {
    return { file: name, text: '', chars: 0, level: null, age: null, error: '读不出这份回顾：' + entry.file }
  }
  const level = loadLevel(entry, now, options)
  const text = renderEntry(entry, parsed, level, options, readLocaleSync(dshHome))
  return {
    file: entry.file,
    text,
    chars: text.length,
    level,
    markedLevel: effectiveCount(entry, now, options),
    loadForced: isLevelForced(options),
    age: dayIndex(entry.compactedAt, now),
    error: null
  }
}

/** 对外暴露的短日期 `10-27`（日记提醒要用）。 */
export function shortDateOf(compactedAt) {
  return shortDate(compactedAt)
}
