/**
 * dsh-session-recall —— 压缩即回顾。
 *
 * 拆  压缩一结束就把被压掉的日志拆成回顾文件（纯代码，零模型调用）
 * 装  按自然日衰减，每轮重算后作为 runtime-context 快照带进上下文
 * 用  工具 session_mem_read（一个线索：按顺序一条条读出来）/ session_mem_write（读那一份的对话原文 · 一次 writes 批量写关键词与日记）
 * 管  设置页：会话与回顾列表、删除、删除并回顾、按日期查
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { captureCompaction, memoryDir } from './store.js'
import { buildMemoryContextOrDiagnostic, snapshotAssembly, describeLoad } from './assembly.js'
import { diaryReminder } from './diary.js'
import { planInjection, composeInjection, memoryAlreadyInjected } from './inject.js'
import { readOptionsSync, REMINDER_SYSTEM } from './settings.js'
import { readLocaleSync } from './locale.js'
import { bumpHits } from './search.js'
import { buildReadToolDefinition, buildWriteToolDefinition, listMemories, readMemorySection, writeMemory, estimateTokens, READ_TOOL_NAME, WRITE_TOOL_NAME } from './tool.js'
import { buildToolCreateReadDefinition, buildToolCreateWriteDefinition, buildToolCallToolDefinition, catalogText } from './schema-tools.js'
import { ensureToolSequenceDir } from './schema.js'
import { installLifecycle } from '../host/lifecycle.js'
import { registerApi } from '../host/api.js'
import { deleteSessionPermanently } from '../host/delete.js'

/** 插件名，也是日志名。 */
export const name = 'session-recall'

/** 运行期上下文条目的标识（它产出的是一条 runtime-context 快照消息，不是系统提示词）。 */
const CONTEXT_NAME = 'session-recall:memory'

/**
 * 日记提醒在系统提示词里的段名与位置。
 *
 * 两个通道由设置页「选项 → 概括提醒」决定：
 *   「在系统侧提醒」（默认关的那一档之外）—— 本段供货，提示词里才是指令；
 *   「在上下文提醒」（0.2.0 的默认档）—— 并进回顾正文（0.1.46 的做法），本段返回空串。
 *
 * 注意 systemPrompt.context() 不是系统提示词：它渲染成 runtime-context 快照，
 * 仍然是 user 消息（renderContextSnapshot）。只有 systemPrompt.section() 进
 * assembly.sections，由 renderPrompt 拼成 system/message。
 *
 * 位置：从 DSH 自己的排序表（@deepseek-ai/dsh-system-prompt 的 SECTION_ORDERS）
 * 取最后几节里最大的序号再 +1，所以这一段永远落在系统提示词末尾、紧挨着对话。
 * 不写死数字：DSH 换了排序也只跟着它走；读不到表的老宿主退到 1e9，仍然是最后。
 */
const DIARY_SECTION_NAME = 'session-recall:diary'

/**
 * 工具组清单在系统提示词里的段名（0.3.0）。
 *
 * 它跟日记提醒同一套机制：systemPrompt.section()，紧跟在日记段后面。
 * 装/删工具脚本才会变，平时稳定——所以它只在工具脚本变动后的第一轮让缓存未命中一次。
 */
const TOOLKIT_SECTION_NAME = 'session-recall:toolSequence'

/** DSH 排序表里排在最后面的几节（探到哪个有就用哪个的最大值）。 */
const TAIL_SECTION_NAMES = ['DEPLOYMENT_PERSONA_SUFFIX', 'WEB_SURFACE', 'HARNESS_SOURCE', 'STRUCTURED_OUTPUT']

/**
 * 日记提醒段该排第几：DSH 排序表里最后一节 + 1。
 * @param {object|undefined} systemPrompt ctx.systemPrompt（带 getSectionOrder）
 * @returns {number}
 */
export function diarySectionOrder(systemPrompt) {
  let max = Number.NEGATIVE_INFINITY
  try {
    if (systemPrompt && typeof systemPrompt.getSectionOrder === 'function') {
      for (const name of TAIL_SECTION_NAMES) {
        const value = systemPrompt.getSectionOrder(name)
        if (typeof value === 'number' && Number.isFinite(value)) max = Math.max(max, value)
      }
    }
  } catch { /* 表读不到就退回兜底 */ }
  return Number.isFinite(max) ? max + 1 : 1e9
}

/**
 * 回顾排在其他 runtime context 条目中间：设备/沙箱信息之后、harness 信息之前。
 * 参照 system-prompt 自带的 CONTEXT_ORDERS（WORKING_DIRECTORY 100 … WEB_SURFACE 210）。
 */
const CONTEXT_ORDER = 150

const splitWaiters = new Map()

/**
 * 这一轮要交出去的整段回顾：正文 +（「在上下文提醒」档的）日记提醒。
 *
 * 选项每次现读，设置页一改，下一轮就按新选项装配，不用重启插件。
 * 提醒在「在系统侧提醒」档不并进来——它走 systemPrompt.section()，
 * 写在用户消息里会被当成背景资料，实测一个工具都不会调。
 * @param {string} dshHome
 * @param {string} cwd
 * @param {Date} now
 * @returns {{text:string, options:object}}
 */
function composeMemoryText(dshHome, cwd, now = new Date()) {
  const options = readOptionsSync(dshHome)
  // 总开关关掉：回顾和提醒都不进上下文（0.2.8）。工具、回顾文件、设置都还在，
  // 只是这一步不再往模型那边送任何东西。
  if (options.injectEnabled === false) return { text: '', options }
  const memoryText = buildMemoryContextOrDiagnostic(dshHome, cwd, now, options)
  const diaryText = options.reminderChannel === REMINDER_SYSTEM
    ? ''
    : diaryReminder(dshHome, cwd, now, options)
  return { text: composeInjection(memoryText, diaryText), options }
}

/**
 * 等某一轮拆解落盘：删除并回顾要在压缩之后确认文件真的写出来了。
 * @param {string} sessionId
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
export function waitForSplitOf(sessionId, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      splitWaiters.get(sessionId)?.delete(done)
      reject(new Error('等拆回顾超时'))
    }, timeoutMs)
    const done = (value) => { clearTimeout(timer); resolve(value) }
    if (!splitWaiters.has(sessionId)) splitWaiters.set(sessionId, new Set())
    splitWaiters.get(sessionId).add(done)
  })
}

function settleSplits(sessionId, value) {
  const waiting = splitWaiters.get(sessionId)
  if (waiting === undefined) return
  splitWaiters.delete(sessionId)
  for (const done of waiting) done(value)
}

/** 会话事件是订阅，不需要声明依赖；其余服务都在 ctx.inject 子 fiber 里取。 */
export const inject = []

/**
 * 解析 DSH 主目录：显式配置 > $DSH_HOME > ~/.dsh。
 * @param {string|undefined} configured
 * @returns {string}
 */
export function resolveDshHome(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.trim() !== '') return env.trim()
  return path.join(homedir(), '.dsh')
}

/**
 * 插件入口。
 * @param {object} ctx cordis 上下文
 * @param {object} config 部署配置
 */
export function apply(ctx, config = {}) {
  const dshHome = resolveDshHome(config.dshHome)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('session-recall') : console

  // 工具组目录一启动就建好：空目录也留在 $DSH_HOME/session-memory/ 下面，看得见。
  void ensureToolSequenceDir(dshHome).catch((err) => {
    logger.warn?.('建工具组目录失败：' + (err?.message ?? err))
  })

  // ── 拆：压缩一结束就落盘 ──────────────────────────────
  ctx.on('session/event', (session, event) => {
    if (!event || event.type !== 'compaction/summary') return
    // 「自动回顾」关着（0.3.10）：连检测都不做——不落盘、不建回顾文件。
    // 放在最前面：不读会话、不看工作区，压缩事件进来就退回去。
    if (readOptionsSync(dshHome).autoReviewEnabled === false) return
    // 子代理不拆：它们的 cwd 与主会话相同，不挡住会往主工作区的回顾里塞脏数据。
    const depth = session?.header?.delegationDepth
    if (typeof depth === 'number' && depth > 0) return
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd === '') {
      logger.warn?.('压缩事件没有工作目录，跳过：' + (session?.id ?? '?'))
      return
    }
    void captureCompaction({ dshHome, cwd, session, event, lang: readLocaleSync(dshHome) })
      .then((res) => {
        if (res.skipped === true) logger.info?.('这次压缩的内容已经记过，不重复落盘：' + res.reason)
        else if (res.added) logger.info?.('拆出回顾 ' + res.file + '（' + res.bytes + ' 字节）→ ' + res.dir)
        else logger.info?.('回顾已存在，跳过 ' + res.file)
        settleSplits(session.id, res)
      })
      .catch((err) => {
        logger.error?.('拆回顾失败：' + (err?.stack ?? err))
        settleSplits(session.id, { error: err })
      })
  })

  // ── 装（主通道）：自己的 kind，每步重算，变了自己替换自己 ──────
  // 只在「回顾还没以自己的 kind 落过」时用 runtime-context，避免同一段文字存两份。
  // 这一轮已经通过 decision.messages 交出去的回顾（新会话第一轮走那条路），
  // runtime-context 兜底据此让位，免得同一段文字出两份。
  const pendingDecisionInject = new Set()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision === null || typeof decision !== 'object') return decision
      if (decision.kind === 'reject') return decision
      const session = payload?.agent?.session
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') return decision
      if (typeof session?.id === 'string') pendingDecisionInject.delete(session.id)
      const messages = Array.isArray(decision.messages) ? [...decision.messages] : []
      let touched = false

      // 这里只注入回顾正文（外加「在上下文提醒」档的日记提醒）。
      // 提醒放在系统侧时，写在用户消息里会被当成背景资料 —— 实测两个新会话都收下了提醒
      // 却一个工具都没调，她把它读成了「用户给的上下文」，回了角色台词。
      const { text } = composeMemoryText(dshHome, cwd)
      const plan = planInjection(session, text)
      if (plan.mode === 'decision') {
        // 系统提示还没落盘：交给 loop 在它之后追加，否则会排到系统提示前面。
        if (typeof session?.id === 'string') pendingDecisionInject.add(session.id)
        messages.push(plan.message)
        touched = true
      } else if (plan.mode === 'direct' && plan.result.fallbackFrom !== undefined) {
        logger.warn?.('回顾替换失败，退回追加：' + plan.result.fallbackFrom)
      }

      if (touched) return { ...decision, messages }
    } catch (err) {
      logger.error?.('回顾注入失败（本轮退回 runtime-context）：' + (err?.stack ?? err))
    }
    return decision
  })

  // ── 装（兜底）：只有在主通道还没落过时才供货 ──────────────
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.context({
      name: CONTEXT_NAME,
      order: CONTEXT_ORDER,
      interpolate: false,
      text: (promptContext) => {
        const session = promptContext?.agent?.session
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return ''
        try {
          if (memoryAlreadyInjected(session)) return ''
          // 本轮已经交给 decision.messages 了：等 loop 追加完就算注入过。
          if (typeof session?.id === 'string' && pendingDecisionInject.has(session.id)) return ''
        } catch { /* 判断不了就当没注入过：宁可多一份，也不让回顾断供 */ }
        return composeMemoryText(dshHome, cwd).text
      }
    })

    // 日记提醒：系统提示词段。只有「概括提醒 = 在系统侧提醒」时供货；
    // 另一档（默认）把它并进回顾正文，这里返回空串，renderPrompt 会把这个段整个滤掉。
    scope.systemPrompt.section({
      name: DIARY_SECTION_NAME,
      order: diarySectionOrder(scope.systemPrompt),
      interpolate: false,
      text: (promptContext) => {
        const session = promptContext?.agent?.session
        const cwd = session?.header?.cwd
        if (typeof cwd !== 'string' || cwd === '') return ''
        // 子代理不管日记：它们和主会话同一个工作目录，催了只会替主会话乱写。
        const depth = session?.header?.delegationDepth
        if (typeof depth === 'number' && depth > 0) return ''
        try {
          const options = readOptionsSync(dshHome)
          // 总开关关掉：系统侧提醒段也不再供货（0.2.8）。
          if (options.injectEnabled === false) return ''
          if (options.reminderChannel !== REMINDER_SYSTEM) return ''
          return diaryReminder(dshHome, cwd, new Date(), options)
        } catch (err) {
          logger.error?.('日记提醒失败：' + (err?.stack ?? err))
          return ''
        }
      }
    })

    // 工具组清单（0.3.0）：紧跟日记段之后。
    // 0.3.1 起它有自己的开关 toolListEnabled：总开关只关回顾正文与日记提醒（B、C），
    // 不连坐这一段（A）——「自创工具」页单独管它。
    scope.systemPrompt.section({
      name: TOOLKIT_SECTION_NAME,
      order: diarySectionOrder(scope.systemPrompt) + 1,
      interpolate: false,
      text: () => {
        try {
          if (readOptionsSync(dshHome).toolListEnabled === false) return ''
          return catalogText(dshHome, readLocaleSync(dshHome))
        } catch (err) {
          logger.error?.('工具组清单失败：' + (err?.stack ?? err))
          return ''
        }
      }
    })
  })

  // ── 用：读对话原文 / 一次 writes 批量写关键词与日记 ────────────────────
  ctx.inject(['tools'], (scope) => {
    // 深度只在「read 工具真的把本工作区自己那份回顾读出去」时加一级，由插件侧记账：
    // 0 -> 1 并锁定，1 -> 2 并锁定，2 或 3 不动。子级/平级/上级读了也不计。
    const countHit = async (res) => {
      if (res === null || res === undefined || res.local !== true || res.hitCount === 0) return
      try {
        await bumpHits(memoryDir(dshHome, res.workspace), res.workspace, res.hits.map((h) => h.file), new Date())
      } catch (err) {
        logger.error?.('回顾深度失败：' + (err?.stack ?? err))
      }
    }
    scope.tools.register(buildReadToolDefinition({ dshHome, onHit: countHit }))
    scope.tools.register(buildWriteToolDefinition({ dshHome }))
    // 0.3.3：读原文（session_tool_create_read）与装工具脚本（session_tool_create_write）拆成两个工具；
    // 跑工具脚本仍是 session_tool_call。
    scope.tools.register(buildToolCreateReadDefinition({ dshHome, logger }))
    scope.tools.register(buildToolCreateWriteDefinition({ dshHome, logger }))
    scope.tools.register(buildToolCallToolDefinition({ dshHome, logger }))
  })

  // ── 管：设置页用的 HTTP 端点 + 删除所需的生命周期捕获 ──
  ctx.inject(['webServer', 'connection', 'agents'], (webCtx) => {
    webCtx.effect(() => installLifecycle(webCtx.agents), 'dsh-session-recall: 生命周期捕获')
    const getDeps = () => ({
      persistence: webCtx.get('sessionPersistence'),
      sessions: webCtx.get('sessions'),
      agents: webCtx.get('agents'),
      workspaceRegistry: webCtx.get('workspaceRegistry'),
      compaction: webCtx.get('compaction')
    })
    registerApi(webCtx, { dshHome, getDeps, waitForSplit: waitForSplitOf })
  })
}

export {
  captureCompaction, memoryDir, buildMemoryContextOrDiagnostic, snapshotAssembly, describeLoad, diaryReminder,
  buildReadToolDefinition, buildWriteToolDefinition, listMemories, readMemorySection, writeMemory, estimateTokens, READ_TOOL_NAME, WRITE_TOOL_NAME,
  deleteSessionPermanently
}

// 选项：设置页读写与注入路径共用同一套默认值与收紧规则。
export { DEFAULT_OPTIONS, FOLLOW_DEPTH, REMINDER_CONTEXT, REMINDER_SYSTEM, OPTIONS_FILE, optionsPath, normalizeOptions, applyAutoReview, readOptionsSync, writeOptions } from './settings.js'

// 语言：只跟 DSH 设置；文件里的中文标记是通配键，显示时按语言换字。
export { LOCALE_FILE, localePath, readLocaleSync, writeLocale } from './locale.js'
export { LANG_ZH, LANG_EN, normalizeLang, phrasesFor, localizeBody, isBlankDiary, isBlankKeywords } from './lang.js'

// 旧名继续可用：直接调用会抛；注入路径走 OrDiagnostic 版，失败时给出「回顾过大」诊断。
export { buildMemoryContext } from './assembly.js'
export { loadLevel, effectiveCount } from './assembly.js'
export { pendingDiaries } from './diary.js'
export { injectMemory, planInjection, composeInjection, needsDecisionPath, memoryAlreadyInjected, memoryNodeOnSurface, memoryMessage, MEMORY_SOURCE_KIND } from './inject.js'
export { listCandidates, knownWorkspaces, expansionOrder } from './search.js'
