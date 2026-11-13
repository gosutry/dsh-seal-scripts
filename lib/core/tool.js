/**
 * 两个工具：session_mem_read（一个线索进去，搜完一条条读出来）与 session_mem_write（读那一份的原文 / 写关键词 / 写日记）。
 *
 * session_mem_read   need 必填。顺序：本工作区自己 -> 子级 -> （许可后）平级与上级；
 *                    一次只返回一条命中的回顾，读不对就再调一次、把它加进 skip。
 *                    只有「本工作区自己」那条被读出去时才算一次命中（0->1、1->2 并锁定）。
 * session_mem_write  用 file，或者用 date(+nth) 定位（「30 号第一份」= date 那天、nth 1，按压缩时刻排）；
 *                    只定位不写 = 读这一份的「原文」区，只给对话、工具调用（▸/◂ 及其输出）整块剔除；
 *                    写的时候 keywords 与 diary 可以一次给齐；多份用 writes 一次写完（全部合格才落盘）。
 *
 * 只动目标区，其余字节不动；改完重新解析校验，坏了就回滚。
 * 文件路径必须落在本工作区的回顾目录里，不许越界。
 *
 * 不依赖 @deepseek-ai/dsh-tools：ctx.tools.register() 只要一个 { name, description,
 * parameters, output:{schema, render}, execute } 的对象，参数和输出都用标准 JSON Schema。
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { memoryDir, readAssembly, writeFileAtomic, renameWithRetry } from './store.js'
import { assertInside, assertMarkdown } from './path-guard.js'
import { parseMemory, setField, setSection } from './memory-file.js'
import { readField, isBlankDiary, isBlankKeywords } from './lang.js'
import { listCandidates } from './search.js'
import { dialogueOnly } from './render.js'

/** 工具名：得是合法 JS 标识符（PTC 模式会把工具折成 SDK 声明）。 */
/** 搜索入口：读的面更大。名字得是合法 JS 标识符（PTC 模式会把工具折成 SDK 声明）。 */
export const READ_TOOL_NAME = 'session_mem_read'

/** 写入口：只读要写的那一份的原文，以及写关键词 / 日记。 */
export const WRITE_TOOL_NAME = 'session_mem_write'

/**
 * 把模型给的路径归一到本工作区回顾目录内的文件。越界直接抛错，不静默兜底。
 * @param {string} dshHome
 * @param {string} cwd
 * @param {string} file
 * @returns {string} 绝对路径
 */
export function resolveMemoryFile(dshHome, cwd, file) {
  const dir = memoryDir(dshHome, cwd)
  const abs = assertInside(dir, file, { label: 'this workspace\'s review directory' })
  return assertMarkdown(abs, file)
}

/**
 * 窄读：返回这一份的「原文」区，只留对话。
 *
 * 0.2.7 起工具调用整块剔除（▸ 发起、◂ 结果、以及结果的多行正文）：
 * 写日记要的是有人说了什么，不是工具跑了什么；原文里的工具部分只给人看。
 *
 * 只给 file 的这条路径（写日记前先看原文）不动深度 —— 深度只跟 read 工具的搜中走，
 * 并且由插件侧记账（见 lib/core/index.js 的 countHit）。
 * @returns {Promise<{file:string, path:string, text:string}>}
 */
export async function readMemorySection({ dshHome, cwd, file }) {
  const abs = resolveMemoryFile(dshHome, cwd, file)
  const text = await fsp.readFile(abs, 'utf8')
  const parsed = parseMemory(text)
  if (!parsed.id) throw new Error('this file has no review section markers, so it is not a review file: ' + file)
  return { file: path.basename(abs), path: abs, text: dialogueOnly(parsed.sections.body) }
}

/**
 * 估 token：UTF-8 字节数 / 4，向上取整。
 * 只用来比长短（日记不能比摘要长），不做精度承诺。
 */
export function estimateTokens(text) {
  const s = String(text === undefined || text === null ? '' : text)
  return Math.ceil(Buffer.byteLength(s, 'utf8') / 4)
}

/**
 * 日记比摘要长时的报错，写法对齐「回顾过大」那套诊断：标题 + 现状 + 处理。
 */
function diaryTooLongMessage(file, diaryTokens, sumTokens) {
  return [
    '【Diary not written】the diary is longer than the summary, so it was rejected.',
    'File: ' + file,
    'Now: the diary is about ' + diaryTokens + ' tokens, the summary about ' + sumTokens + '; the diary must not exceed the summary.',
    'Fix: trim the diary below the summary length and write again — keep only what the next pass needs; the details stay in the original text.'
  ].join('\n')
}

/**
 * 关键词不比日记短时的报错，格式对齐日记那条诊断：标题 + 现状 + 处理。
 */
function keywordsTooLongMessage(file, keyTokens, diaryTokens) {
  return [
    '【Keywords not written】the keywords cost at least as many tokens as the diary, so they were rejected.',
    'File: ' + file,
    'Now: the keywords are about ' + keyTokens + ' tokens, the diary about ' + diaryTokens + '; the keywords must cost fewer tokens than the diary.',
    'Fix: summarize the original again in fewer tokens for the same content — this is a retrieval index, not a second diary.'
  ].join('\n')
}

/**
 * 在内存里把一份回顾改好：只算新文本，不落盘。
 *
 * 两道闸门都在这里卡（日记不得超过摘要、关键词必须比日记短），任何一道不过就抛错——
 * 于是批量写时只要一份不合格，整批都不写。keywords 与 diary 可以只给一个，也可以一起给。
 * @param {string} before 读到手的旧文本
 * @param {{file:string, keywords?:string[], diary?:string}} item
 * @returns {{next:string, changed:string[], diary:string, keywords:string}}
 */
export function applyWrite(before, { file, keywords, diary }) {
  const hasKeywords = Array.isArray(keywords)
  const hasDiary = typeof diary === 'string'
  if (!hasKeywords && !hasDiary) throw new Error('pass at least one of keywords or diary')

  const parsed = parseMemory(before)
  const oldDiary = String(parsed.sections.diary ?? '').trim()
  const oldKeys = String(readField(parsed.meta, 'keywords')).trim()

  let keyLine = null
  if (hasKeywords) {
    const words = keywords.map((w) => String(w).trim()).filter(Boolean)
    if (words.length === 0) throw new Error('keywords must not be an empty array')
    keyLine = words.join(' · ')
  }
  const nextDiary = hasDiary ? String(diary).trim() : oldDiary
  const nextKeys = keyLine === null ? oldKeys : keyLine.trim()

  if (!isBlankDiary(nextDiary)) {
    // 闸门一：写完的日记不能比摘要长：摘要才是压缩之后该有的体量。
    // 摘要为空（没总结出来）时不做限制，否则这份回顾会连日记也写不进去。
    const sumTokens = estimateTokens(parsed.sections.sum)
    const diaryTokens = estimateTokens(nextDiary)
    if (sumTokens > 0 && diaryTokens > sumTokens) {
      throw new Error(diaryTooLongMessage(file, diaryTokens, sumTokens))
    }
    // 闸门二：关键词必须比日记短（关键词还空着时放行——它还没写，不算「太长」）。
    if (!isBlankKeywords(nextKeys)) {
      const keyTokens = estimateTokens(nextKeys)
      if (keyTokens >= diaryTokens) {
        throw new Error(keywordsTooLongMessage(file, keyTokens, diaryTokens))
      }
    }
  }

  let next = before
  const changed = []
  if (hasKeywords) {
    const updated = setField(next, 'keywords', keyLine)
    if (updated === null) throw new Error('this file has no keywords field')
    next = updated
    changed.push('keywords')
  }
  if (hasDiary) {
    const updated = setSection(next, 'diary', diary)
    if (updated === null) throw new Error('this file has no diary section')
    next = updated
    changed.push('diary')
  }

  const check = parseMemory(next)
  const ok = check.id && ['sum', 'body', 'diary'].every((k) => typeof check.sections[k] === 'string')
  if (!ok) throw new Error('post-write verification failed: ' + file)
  return { next, changed, diary: check.sections.diary, keywords: readField(check.meta, 'keywords') }
}

/**
 * 批量写落盘用的 IO 面。默认全是真实现（store.js 的原子写 + Windows 重试）。
 *
 * 为什么留这个替换点：批量写中途失败是必须能测的路径，可 Windows 上造不出
 * 「读得出、写不进」的文件状态（只读属性连 rm -f 都拦不住），只能在这一层注入。
 * 生产路径永远走默认值，测试只在失败路径上换。
 */
const fileIO = {
  writeTmp: (file, content) => fsp.writeFile(file, content, 'utf8'),
  rename: (tmp, target) => renameWithRetry(tmp, target),
  writeAtomic: (file, content) => writeFileAtomic(file, content)
}

/**
 * 一次写多份（0.2.7）：先在内存里把每一份都算好（含两道闸门），全部合格才落盘；
 * 落盘中途出错就把已经写过的**逆序**还原并读回来核对，不留下半新半旧，
 * 还原不了的会点名是哪几份。临时文件一律在 finally 里清掉。
 * @param {{dshHome:string, cwd:string, items:Array<{file:string, keywords?:string[], diary?:string}>, io?:object}} p
 *        io 只给测试注入失败用，正常调用不用传。
 * @returns {Promise<{items:Array<{file:string, path:string, changed:string, diary:string, keywords:string}>}>}
 */
export async function writeMemories({ dshHome, cwd, items, io = fileIO }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('write at least one item at a time')
  const staged = []
  const seen = new Set()
  for (const item of items) {
    const abs = resolveMemoryFile(dshHome, cwd, item.file)
    if (seen.has(abs)) throw new Error('the same file was written twice: ' + path.basename(abs))
    seen.add(abs)
    const before = await fsp.readFile(abs, 'utf8')
    const parsed = parseMemory(before)
    if (!parsed.id) throw new Error('this file has no review section markers, so it is not a review file: ' + item.file)
    const applied = applyWrite(before, { file: path.basename(abs), keywords: item.keywords, diary: item.diary })
    staged.push({ abs, before, ...applied })
  }

  const written = []
  const temps = []
  try {
    for (const s of staged) {
      const tmp = path.join(path.dirname(s.abs),
        path.basename(s.abs) + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
      temps.push(tmp)
      await io.writeTmp(tmp, s.next)
      await io.rename(tmp, s.abs)
      written.push(s)
    }
  } catch (err) {
    // 逆序还原（后写的先还原），还原完读回来比对：
    // 以前是「尽力而为」，从不检查自己成没成，文件停在半新半旧也没人知道。
    const rollback = []
    for (const s of written.slice().reverse()) {
      try {
        await io.writeAtomic(s.abs, s.before)
        const back = await fsp.readFile(s.abs, 'utf8')
        if (back !== s.before) rollback.push(path.basename(s.abs) + ' (content differs after rollback)')
      } catch (e) {
        rollback.push(path.basename(s.abs) + ' (rollback failed: ' + (e?.message ?? e) + ')')
      }
    }
    // 失败必须说清「哪些没回滚回去」——用户得知道哪一份停在半新半旧。
    const detail = rollback.length > 0
      ? '\nThese could not be rolled back; check them by hand:\n  · ' + rollback.join('\n  · ')
      : '\nEvery written file has been restored.'
    throw new Error((err?.message ?? String(err)) + detail)
  } finally {
    for (const tmp of temps) await fsp.rm(tmp, { force: true }).catch(() => {})
  }

  return {
    items: staged.map((s) => ({
      file: path.basename(s.abs), path: s.abs,
      changed: s.changed.join(' + '), diary: s.diary, keywords: s.keywords
    }))
  }
}

/**
 * 写一份（批量写的最小形态）。只改目标区，改完校验。
 * @returns {Promise<{file:string, path:string, changed:string, diary:string, keywords:string}>}
 */
export async function writeMemory({ dshHome, cwd, file, keywords, diary }) {
  const { items } = await writeMemories({ dshHome, cwd, items: [{ file, keywords, diary }] })
  return items[0]
}

/** 本地日期：2026-10-30。和注入行里的日期、用户嘴里的「30 号」是同一个。 */
export function localDayOf(compactedAt) {
  const d = new Date(compactedAt)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

/**
 * 按「哪一天的第几份」直接定位到文件，不用搜、不用抄文件名。
 * 同一天按压缩时刻从早到晚数，nth 从 1 起。
 * @returns {Promise<string>} 文件名
 */
export async function resolveMemoryByDay({ dshHome, cwd, date, nth }) {
  const day = String(date ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('date must be YYYY-MM-DD (local date): ' + day)
  const { entries } = await listMemories(dshHome, cwd)
  const same = entries
    .filter((e) => e && typeof e.compactedAt === 'string' && localDayOf(e.compactedAt) === day)
    .sort((a, b) => String(a.compactedAt).localeCompare(String(b.compactedAt)))
  if (same.length === 0) {
    const days = [...new Set(entries.map((e) => localDayOf(e.compactedAt)).filter(Boolean))].sort()
    throw new Error('no review on that day: ' + day + (days.length > 0 ? ' (days with reviews: ' + days.join(', ') + ')' : ' (this workspace has no reviews at all)'))
  }
  if (nth > same.length) {
    throw new Error('that day only has ' + same.length + ' review(s): ' + day + ' has no #' + nth)
  }
  return same[nth - 1].file
}

/** 列出本工作区的回顾（给工具和设置页用）。 */
export async function listMemories(dshHome, cwd) {
  const dir = memoryDir(dshHome, cwd)
  const data = await readAssembly(dir, cwd)
  return { dir, entries: data.entries }
}

/** 读工具的入参校验：一个线索（need），可选跳过清单与跨区许可。 */
function validateReadArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  if (typeof args.need !== 'string' || args.need.trim() === '') {
    throw new Error('need must not be empty: say in one sentence what you are looking for')
  }
  if (args.skip !== undefined && (!Array.isArray(args.skip) || args.skip.some((s) => typeof s !== 'string'))) {
    throw new Error('skip must be an array of strings (review files already read)')
  }
  if (args.allowOuter !== undefined && typeof args.allowOuter !== 'boolean') {
    throw new Error('allowOuter must be a boolean (the user must allow searching other workspaces)')
  }
  if (args.query !== undefined || args.file !== undefined) {
    throw new Error('this tool only takes need (optionally skip / allowOuter); to read one review original use ' + WRITE_TOOL_NAME)
  }
}

/** 定位校验：file 或者（date + 可选 nth）二选一。单份与批量里的一项共用。 */
function validatePosition(args, where = '') {
  const hasFile = typeof args.file === 'string' && args.file.trim() !== ''
  const hasDate = args.date !== undefined
  if (hasFile && hasDate) throw new Error(where + 'file and date are mutually exclusive: with file you do not need date / nth')
  if (!hasFile && !hasDate) throw new Error(where + 'pass file, or date (the first review of that day) to locate a review')
  if (hasDate && !/^\d{4}-\d{2}-\d{2}$/.test(String(args.date).trim())) {
    throw new Error(where + 'date must be YYYY-MM-DD (local date): ' + String(args.date))
  }
  if (args.date === undefined && args.nth !== undefined) {
    throw new Error(where + 'nth goes together with date: date picks the day, nth picks which review of that day (from 1)')
  }
  if (args.nth !== undefined && (!Number.isInteger(args.nth) || args.nth < 1)) {
    throw new Error(where + 'nth must be an integer starting at 1 (which review of that day, oldest first)')
  }
}

/** 批量里的一项：定位 + 至少要写 keywords 或 diary。 */
function validateWriteItem(item, idx) {
  const where = 'writes[' + idx + ']：'
  if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(where + 'must be an object')
  validatePosition(item, where)
  if (item.keywords !== undefined && !Array.isArray(item.keywords)) throw new Error(where + 'keywords must be an array of strings')
  if (item.diary !== undefined && typeof item.diary !== 'string') throw new Error(where + 'diary must be a string')
  if (item.keywords === undefined && item.diary === undefined) throw new Error(where + 'pass at least one of keywords or diary')
  if (item.query !== undefined) throw new Error('use ' + READ_TOOL_NAME + ' to search')
}

/**
 * 写工具的入参校验：
 *   - 单份：file 或 date+nth 定位；不给 keywords/diary 就是读原文；两项可以一起给。
 *   - 批量：writes 数组，每一项自带定位与要写的内容；不能再混顶层定位。
 */
function validateWriteArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  if (args.writes !== undefined) {
    if (!Array.isArray(args.writes)) throw new Error('writes must be an array (one item per review)')
    if (args.writes.length === 0) throw new Error('writes must not be an empty array')
    for (const key of ['file', 'date', 'nth', 'keywords', 'diary']) {
      if (args[key] !== undefined) throw new Error('with writes, do not also pass top-level ' + key + ': put every item inside writes')
    }
    args.writes.forEach((item, i) => validateWriteItem(item, i))
    return
  }
  validatePosition(args)
  if (args.query !== undefined) throw new Error('use ' + READ_TOOL_NAME + ' to search')
  if (args.keywords !== undefined && !Array.isArray(args.keywords)) throw new Error('keywords must be an array of strings')
  if (args.diary !== undefined && typeof args.diary !== 'string') throw new Error('diary must be a string')
}

/** 命中在哪一轮、在哪一层工作区，说人话。 */
const LEVEL_LABEL = { keywords: 'keywords', sum: 'summary', body: 'transcript' }
const WHERE_LABEL = { self: 'this workspace', child: 'child workspace', sibling: 'sibling workspace', outer: 'parent/outer' }

/**
 * 读工具定义（直接给 ctx.tools.register 用）。一次只交给模型一条命中的回顾。
 * @param {{dshHome:string, onHit?:Function}} options
 * @returns {object}
 */
export function buildReadToolDefinition({ dshHome, onHit }) {
  return {
    name: READ_TOOL_NAME,
    description: [
      'Use when the load shows only a file name, or the user says you misremembered: give one clue, not the whole question.',
      'Returns one memory per call; child workspaces are searched too. Pass skip for the next, stop once one fits.',
      'Only this workspace\'s memories count toward depth; siblings and parents need allowOuter.',
      'If nothing fits, say you did not recall it.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['need'],
      properties: {
        need: { type: 'string', description: 'Clue in your own words (what the user said).' },
        skip: { type: 'array', items: { type: 'string' }, description: 'Files already read.' },
        allowOuter: { type: 'boolean', description: 'Also search sibling/parent workspaces (needs user permission).' }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          mode: { type: 'string', enum: ['read', 'exhausted'] },
          file: { type: 'string' },
          workspace: { type: 'string' },
          level: { type: 'string' },
          remaining: { type: 'number' },
          text: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text ?? '' }]
    },
    async execute(args, exec) {
      validateReadArgs(args)
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') throw new Error(READ_TOOL_NAME + ' needs to know the current workspace')
      const allowOuter = args.allowOuter === true
      const skip = new Set((args.skip ?? []).map((s) => String(s)))
      const picked = await listCandidates({ dshHome, cwd, need: args.need, allowOuter })
      const rest = picked.candidates.filter((c) => !skip.has(c.file) &&
        !skip.has(c.workspace + '|' + c.file) && !skip.has(c.workspace + '\\' + c.file))
      if (rest.length === 0) {
        return exhausted({ need: args.need.trim(), allowOuter, blocked: picked.blocked, read: picked.candidates.length })
      }
      const one = rest[0]
      // 深度只认「本工作区自己」那一份被读出去（子级/平级/上级只读、不计）
      if (one.local === true && typeof onHit === 'function') {
        await onHit({ local: true, workspace: cwd, hitCount: 1, hits: [{ file: one.file }] })
      }
      const text = [
        'Read ' + one.file + ' (' + (WHERE_LABEL[one.scope] || one.scope) + ') · matched "' + (LEVEL_LABEL[one.level] || one.level) + '"',
        ' ' + (rest.length - 1) + ' more not read; if this one is wrong, put it in skip and call again.',
        '',
        one.content
      ].join('\n')
      return {
        mode: 'read', file: one.file, workspace: one.workspace,
        level: one.level, remaining: rest.length - 1, text
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall memory',
      kind: 'other',
      rawInput: args && args.need
    })
  }
}

/** 读完了：没找到就明说，并给出下一步（换说法 / 问许可）。 */
function exhausted({ need, allowOuter, blocked, read }) {
  const lines = []
  if (read === 0) lines.push('No review in this scope mentions "' + need + '".')
  else lines.push('All ' + read + ' review(s) in this scope were read; nothing fits better.')
  if (!allowOuter && blocked > 0) {
    lines.push(blocked + ' more review(s) outside are unread, but searching them needs the user\'s go-ahead.')
    lines.push('Tell the user you do not recall or are unsure and ask them to rephrase; if they insist, ask whether you may search other workspaces.')
  } else {
    lines.push('Tell the user you do not recall or are unsure and ask them to rephrase.')
  }
  return { mode: 'exhausted', file: '', workspace: '', level: '', remaining: 0, text: lines.join('\n') }
}

/**
 * 写工具定义：只给 file 就是读这一份的原文，给 keywords / diary 就是写。
 * @param {{dshHome:string}} options
 * @returns {object}
 */
export function buildWriteToolDefinition({ dshHome }) {
  return {
    name: WRITE_TOOL_NAME,
    description: [
      'Read or write one memory\'s annotation.',
      '- Locator only (file, or date + nth): returns that memory\'s original text, dialogue only, tool calls stripped.',
      '- Write one: file + keywords and/or diary. Write many: writes[], one call finishes every file, all-or-nothing.',
      '- "The first one on the 30th" is date + nth 1; nth counts by compaction time.',
      'Never changes depth — that belongs to ' + READ_TOOL_NAME + '.'
    ].join(' '),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file: { type: 'string', description: 'Memory file name (in this workspace).' },
        date: { type: 'string', description: 'Local date YYYY-MM-DD; use instead of file to locate by day.' },
        nth: { type: 'integer', description: 'Which memory of that date: 1 = earliest compaction. Defaults to 1.' },
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords, summarized from the original (not edited down from the diary); must use fewer tokens than the diary. No count limit.' },
        diary: { type: 'string', description: 'Writes the diary section; a diary longer than the summary is rejected.' },
        writes: {
          type: 'array',
          description: 'Batch write: one entry per memory, addressed by file or date+nth, each carrying keywords and/or diary. Prefer this to finish every file in one call.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              file: { type: 'string', description: 'Memory file name (in this workspace).' },
              date: { type: 'string', description: 'Local date YYYY-MM-DD; use instead of file.' },
              nth: { type: 'integer', description: 'Which memory of that date (defaults to 1).' },
              keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords for this memory.' },
              diary: { type: 'string', description: 'Diary for this memory.' }
            }
          }
        }
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['mode'],
        properties: {
          file: { type: 'string' },
          path: { type: 'string' },
          mode: { type: 'string', enum: ['read', 'write'] },
          text: { type: 'string' },
          changed: { type: 'string' },
          diary: { type: 'string' },
          keywords: { type: 'string' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string' },
                path: { type: 'string' },
                changed: { type: 'string' },
                diary: { type: 'string' },
                keywords: { type: 'string' }
              }
            }
          }
        }
      },
      render: (_args, value) => {
        if (value.mode === 'read') {
          return [{
            type: 'text',
            text: 'Original (dialogue only, tool calls excluded) · ' + value.file + ' (' + (value.path ?? '') + ')\n\n' + (value.text ?? '')
          }]
        }
        if (Array.isArray(value.items) && value.items.length > 0) {
          return [{
            type: 'text',
            text: 'Updated ' + value.items.length + ' review(s):\n' + value.items
              .map((it) => '· ' + it.file + '：' + it.changed +
                (typeof it.diary === 'string' && it.diary !== '' ? '\n  diary is now:\n  ' + it.diary : '') +
                (typeof it.keywords === 'string' && it.keywords !== '' ? '\n  keywords are now: ' + it.keywords : ''))
              .join('\n')
          }]
        }
        return [{
          type: 'text',
          text: 'Updated ' + value.file + ' (' + (value.path ?? '') + '): ' + value.changed +
            (typeof value.diary === 'string' && value.diary !== '' ? '\n\ndiary is now:\n' + value.diary : '') +
            (typeof value.keywords === 'string' && value.keywords !== '' ? '\nkeywords are now: ' + value.keywords : '')
        }]
      }
    },
    async execute(args, exec) {
      validateWriteArgs(args)
      const cwd = exec?.agent?.session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') throw new Error(WRITE_TOOL_NAME + ' needs to know the current workspace')

      // 批量：每一项先定位（date 翻成文件名），再一起交给 writeMemories——全部合格才落盘。
      if (Array.isArray(args.writes)) {
        const items = []
        for (const it of args.writes) {
          const file = typeof it.file === 'string' && it.file.trim() !== ''
            ? it.file
            : await resolveMemoryByDay({
              dshHome, cwd,
              date: it.date,
              nth: it.nth === undefined ? 1 : it.nth
            })
          items.push({ file, keywords: it.keywords, diary: it.diary })
        }
        const res = await writeMemories({ dshHome, cwd, items })
        // 把刚写进去的内容回显给模型：它就不用再读一遍文件来确认。
        return {
          mode: 'write',
          items: res.items.map((one) => ({
            file: one.file, path: one.path, changed: one.changed,
            diary: one.changed.includes('diary') ? one.diary : '',
            keywords: one.changed.includes('keywords') ? one.keywords : ''
          }))
        }
      }

      // 单份：给文件名就直接用；给日期（+第几份）就先翻成文件名，模型不用抄、也不用搜。
      const file = typeof args.file === 'string' && args.file.trim() !== ''
        ? args.file
        : await resolveMemoryByDay({
          dshHome, cwd,
          date: args.date,
          nth: args.nth === undefined ? 1 : args.nth
        })
      const wantsWrite = Array.isArray(args.keywords) || typeof args.diary === 'string'
      if (wantsWrite) {
        const res = await writeMemory({ dshHome, cwd, file, keywords: args.keywords, diary: args.diary })
        return {
          file: res.file, path: res.path, mode: 'write', changed: res.changed,
          diary: res.changed.includes('diary') ? res.diary : '',
          keywords: res.changed.includes('keywords') ? res.keywords : ''
        }
      }
      const res = await readMemorySection({ dshHome, cwd, file })
      return { file: res.file, path: res.path, mode: 'read', text: res.text }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args && (Array.isArray(args.writes) || args.keywords || args.diary) ? 'Annotate memory' : 'Read memory',
      kind: 'other',
      rawInput: args && (Array.isArray(args.writes)
        ? 'writes: ' + args.writes.length
        : (args.file || (args.date ? args.date + ' #' + (args.nth === undefined ? 1 : args.nth) : undefined)))
    })
  }
}
