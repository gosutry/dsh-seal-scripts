/**
 * 选项：设置页「选项」标签里那几个开关。
 *
 * 存在 <dshHome>/session-memory/_options.json，与回顾同放在记忆根下，一个文件、
 * 全部工作区共用。注入路径每一步都要读它，而 systemPrompt.context() 的 text 是
 * 同步求值的，所以读用 readFileSync；写只来自设置页，用原子写。
 *
 * 七个键：
 *   autoReviewEnabled 自动回顾（0.3.10）：总闸。开着才检测压缩、才建回顾文件、才注入；
 *                   默认关。关着时下面的 injectEnabled 一律按关算（不写盘、不动已存的值）。
 *   injectEnabled   回顾注入：总开关（0.2.8）。0.3.1 起只管回顾正文与日记提醒（B、C 两段）；
 *                   工具组清单（A 段）由 toolListEnabled 单独管。关掉后其余四项只变灰不可改，
 *                   已存的值原样保留（不还原默认）
 *   toolListEnabled 注入工具组清单（0.3.1）：只管 session-seal-scripts:toolSequence 那一段，默认开
 *   toolListRefresh 清单词刷新时刻（0.4.5）：'newSession' 新会话开始之前（默认）/ 'realtime' 会话内实时刷新。
 *                   只管工具组那一段什么时候重算：newSession 在会话首次装配时算一次就固定，
 *                   会话中途装/删工具脚本不改系统提示词（否则整份会话会被当未缓存输入重发）；
 *   fullLoad        全量加载：深度 3 不再过滤工具内容（载入框与真正注入一起变）
 *   reminderChannel 概括提醒：context = 并进回顾正文（0.1.46 的做法）/ system = 系统提示词段
 *   stopLowering    停止降低：所有深度停在载入文件里记下的那个数，不再按自然日衰减
 *   loadLevel       载入数值：'follow' 跟随深度，或 3/2/1/0 强制这一级（只改载入）
 *
 * 两条规矩：
 *   1. 停止降低开启时，载入数值没有意义（都停在记下的深度），一律退回 'follow'。
 *   2. 自动回顾关着时，回顾注入没有意义（没有回顾可注入），一律按关算——
 *      这只发生在「读出来给别处用」那一层（readOptionsSync / writeOptions 的返回值），
 *      **不写进文件**：用户重新打开它时，原来那个「回顾注入」开关还在原位。
 */

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './store.js'

/** 选项文件名（位于记忆根下，不在任何工作区目录里）。 */
export const OPTIONS_FILE = '_options.json'

/** 载入数值的「跟随深度」档。 */
export const FOLLOW_DEPTH = 'follow'

/** 概括提醒的两个通道。 */
export const REMINDER_CONTEXT = 'context'
export const REMINDER_SYSTEM = 'system'

/** 工具组清单什么时候重算（0.4.5）。 */
export const REFRESH_NEW_SESSION = 'newSession'
export const REFRESH_REALTIME = 'realtime'

/**
 * 落盘默认值：自动回顾关（0.3.10，按用户要求默认关）、注入开、工具组清单开、
 * 全量关、提醒在上下文（0.1.46）、停止降低关、载入跟随深度。
 *
 * 「注入开」是**存储值**的默认，不是默认生效值：自动回顾关着时读出来的 injectEnabled 是 false。
 */
export const DEFAULT_OPTIONS = Object.freeze({
  autoReviewEnabled: false,
  injectEnabled: true,
  toolListEnabled: true,
  toolListRefresh: REFRESH_NEW_SESSION,
  fullLoad: false,
  reminderChannel: REMINDER_CONTEXT,
  stopLowering: false,
  loadLevel: FOLLOW_DEPTH
})

/**
 * 选项文件路径。
 * @param {string} dshHome
 * @returns {string}
 */
export function optionsPath(dshHome) {
  return path.join(String(dshHome), 'session-memory', OPTIONS_FILE)
}

/**
 * 把任意输入收成一份合法的**存储**选项。坏值一律回落默认，不抛错。
 *
 * 只做逐键收紧，不叠「自动回顾关 ⇒ 注入关」那条连带后果：那是读出来用的时候算的
 * （applyAutoReview），否则一次保存就会把用户存的「回顾注入」状态抹成关。
 * @param {object|undefined|null} raw
 * @returns {{autoReviewEnabled:boolean, injectEnabled:boolean, toolListEnabled:boolean, fullLoad:boolean, reminderChannel:'context'|'system', stopLowering:boolean, loadLevel:'follow'|0|1|2|3}}
 */
export function normalizeOptions(raw) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  // 只有明确写 true 才算开：缺键（老选项文件）与坏值都按「自动回顾默认关」走。
  const autoReviewEnabled = src.autoReviewEnabled === true
  // 只有明确写 false 才算关；缺键、坏值都保持默认开（老选项文件没有这个键）。
  const injectEnabled = src.injectEnabled !== false
  const stopLowering = src.stopLowering === true
  const rawLevel = src.loadLevel
  const num = typeof rawLevel === 'number'
    ? rawLevel
    : (typeof rawLevel === 'string' && /^[0-3]$/.test(rawLevel.trim()) ? Number(rawLevel.trim()) : NaN)
  let loadLevel = Number.isInteger(num) && num >= 0 && num <= 3 ? num : FOLLOW_DEPTH
  // 停止降低时「载入数值」禁用：都停在记下的深度，强制某一级没有意义，按规矩退回跟随。
  // 注意：这不套用到「回顾注入」关闭上——关总开关只禁用设置，不动已存的值。
  if (stopLowering) loadLevel = FOLLOW_DEPTH
  return {
    autoReviewEnabled,
    injectEnabled,
    toolListEnabled: src.toolListEnabled !== false,
    // 0.4.5：只有明确写 realtime 才实时刷新；缺键（老选项文件）、坏值都按默认「新会话开始之前」。
    toolListRefresh: src.toolListRefresh === REFRESH_REALTIME ? REFRESH_REALTIME : REFRESH_NEW_SESSION,
    fullLoad: src.fullLoad === true,
    reminderChannel: src.reminderChannel === REMINDER_SYSTEM ? REMINDER_SYSTEM : REMINDER_CONTEXT,
    stopLowering,
    loadLevel
  }
}

/**
 * 叠「自动回顾」的连带后果：它一关，回顾注入一律按关算。
 * 只改返回值，不改文件；自动回顾打开时存储值原样返回。
 * @param {object} stored normalizeOptions 的结果
 * @returns {object}
 */
export function applyAutoReview(stored) {
  const base = stored !== null && typeof stored === 'object' ? stored : { ...DEFAULT_OPTIONS }
  if (base.autoReviewEnabled === true) return base
  return { ...base, injectEnabled: false }
}

/** 读**存储**值（不做自动回顾连带收紧）；坏文件、缺 dshHome 都给默认。 */
function readStoredSync(dshHome) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') return { ...DEFAULT_OPTIONS }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(optionsPath(dshHome), 'utf8'))
  } catch {
    return { ...DEFAULT_OPTIONS }
  }
  return normalizeOptions(raw)
}

/**
 * 读选项（**生效值**）。文件不存在、坏了、没有 dshHome 都当默认值，绝不抛错
 * （注入路径每一步都过这里）。自动回顾关着时 injectEnabled 一律是 false。
 * @param {string} dshHome
 * @returns {object}
 */
export function readOptionsSync(dshHome) {
  return applyAutoReview(readStoredSync(dshHome))
}

/**
 * 改选项：拿现有**存储**值合并补丁，收紧后原子落盘；返回生效值给设置页显示。
 * @param {string} dshHome
 * @param {object} patch 只写要改的键
 * @returns {Promise<object>} 落盘后的生效选项
 */
export async function writeOptions(dshHome, patch) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') throw new Error('no dshHome, cannot write options')
  const merged = { ...readStoredSync(dshHome), ...(patch !== null && typeof patch === 'object' ? patch : {}) }
  const next = normalizeOptions(merged)
  await fsPromises.mkdir(path.dirname(optionsPath(dshHome)), { recursive: true })
  await writeFileAtomic(optionsPath(dshHome), JSON.stringify(next, null, 2) + '\n')
  return applyAutoReview(next)
}
