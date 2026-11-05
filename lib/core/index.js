/**
 * dsh-seal-scripts —— 压缩即回顾。
 *
 * 拆  压缩一结束就把被压掉的日志拆成回顾文件（纯代码，零模型调用）
 * 装  按自然日衰减，每轮重算后作为 runtime-context 快照带进上下文
 * 用  工具 session_mem_read（一个线索：按顺序一条条读出来）/ session_mem_write（读那一份的对话原文 · 一次 writes 批量写关键词与日记）
 * 管  设置页：会话与回顾列表、删除、删除并回顾、按日期查
 */

import { homedir } from 'node:os'
import path from 'node:path'
import { captureCompaction, memoryDir } from './store.js'
import { recordHealth } from './health.js'
import { buildMemoryContextOrDiagnostic, snapshotAssembly, describeLoad } from './assembly.js'
import { diaryReminder } from './diary.js'
import { planInjection, composeInjection, memoryAlreadyInjected } from './inject.js'
import { readOptionsSync, REMINDER_SYSTEM, DEFAULT_OPTIONS, REFRESH_REALTIME } from './settings.js'
import { catalogTextForSession, refreshCatalogSnapshots } from './catalog-snapshot.js'
import { readLocaleSync } from './locale.js'
import { bumpHits } from './search.js'
import { buildReadToolDefinition, buildWriteToolDefinition, listMemories, readMemorySection, writeMemory, estimateTokens, READ_TOOL_NAME, WRITE_TOOL_NAME } from './tool.js'
import { buildToolCreateReadDefinition, buildToolCreateWriteDefinition, buildToolCallToolDefinition, catalogText } from './schema-tools.js'
import { ensureToolSequenceDir } from './schema.js'
import { installLifecycle } from '../host/lifecycle.js'
import { registerApi } from '../host/api.js'
import { deleteSessionPermanently, sessionDirOf } from '../host/delete.js'
import { probeHostFormat } from '../host/host-contract.js'
import { createCapabilityProbe, describeMissing } from '../host/capabilities.js'

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
 * 这一段系统提示词要用的工具组清单（0.4.5）。
 * 三条分支：开关关掉给空串；realtime 每轮现算；默认档按会话冻住快照。
 * 抽成独立函数是为了能被直接调用验证——注册时只包一层 catch。
 * @param {string} dshHome
 * @param {object|null|undefined} promptContext systemPrompt.section 的 text 回调参数
 * @returns {string}
 */
export function toolListSectionText(dshHome, promptContext) {
  const options = readOptionsSync(dshHome)
  if (options.toolListEnabled === false) return ''
  const lang = readLocaleSync(dshHome)
  if (options.toolListRefresh === REFRESH_REALTIME) return catalogText(dshHome, lang)
  return catalogTextForSession(dshHome, lang, sessionIdOf(promptContext))
}

/**
 * 从装配上下文里取会话 id（0.4.5）。拿不到就给空串，调用方据此退回现算。
 * 字段名照 DSH 的会话对象：id 在 session.id，个别版本放在 session.header.id。
 * @param {object|null|undefined} promptContext systemPrompt.section 的 text 回调参数
 * @returns {string}
 */
export function sessionIdOf(promptContext) {
  try {
    const session = promptContext?.agent?.session
    const id = session?.id ?? session?.header?.id
    return typeof id === 'string' ? id : ''
  } catch {
    return ''
  }
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

  // ── 宿主能力探测（E1）：缺哪块关哪块，其余照常 ──────────────
  // cordis 的 ctx.get 只看「已经就绪」的服务；apply 刚进来时宿主服务多半还没起来，
  // 所以这里先探到 zstd（进程级），其余各项在各自的 inject 回调里再探、合并。
  const capabilities = createCapabilityProbe(ctx)
  // 只探 zstd：宿主服务此刻多半还没起来，探全表会把「还没看到」误报成「没有」。
  capabilities.probe(undefined, { only: ['zstd.decompress'] })
  if (capabilities.state.table['zstd.decompress'] !== true) {
    logger.warn?.('当前 Node 没有 zlib.zstdDecompressSync，会话标题读不出来（回顾本身不受影响）')
    void recordHealth(dshHome, '(harness)', { ok: false, code: 'host-capability', message: '当前 Node 缺 zlib.zstdDecompressSync' })
  }
  // 每个 inject 回调里调用：只把「这次新发现缺的」写一次日志。
  const reportMissing = (opts) => {
    const fresh = capabilities.probe(undefined, opts)
    if (fresh.length === 0) return capabilities.state
    const text = describeMissing({ missing: fresh })
    logger.warn?.('宿主能力不全，相关功能已降级：' + text)
    void recordHealth(dshHome, '(harness)', { ok: false, code: 'host-capability', message: text })
    return capabilities.state
  }
  const cap = () => capabilities.state.table

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
        void recordHealth(dshHome, cwd, { ok: true, file: res.file ?? '' })
        // X2：拆解成功时顺手做一次极便宜的宿主格式探测（readdir + 最多 4 字节）。
        // 宿主改了会话日志格式的话，这里留下 _health.json，设置页能看见，而不是「标题突然全空」。
        try {
          const persistence = typeof ctx.get === 'function' ? ctx.get('sessionPersistence') : undefined
          const root = persistence?.config?.root
          if (typeof root === 'string' && root !== '' && typeof session.id === 'string') {
            const fmt = probeHostFormat(sessionDirOf(root, cwd, session.id))
            if (fmt.ok === false) {
              logger.warn?.('宿主会话格式可能有变：' + fmt.detail)
              void recordHealth(dshHome, cwd, { ok: false, code: 'host-format-changed', message: fmt.detail })
            }
          }
        } catch { /* 探测失败不连累拆回顾 */ }
        settleSplits(session.id, res)
      })
      .catch((err) => {
        logger.error?.('拆回顾失败：' + (err?.stack ?? err))
        // 失败必须留下痕迹：用户看不到日志，只看得到设置页。
        // recordHealth 自己吞掉所有异常（它就跑在 catch 里），不会把 settleSplits 带走。
        void recordHealth(dshHome, cwd, { ok: false, code: err?.code ?? 'capture-failed', message: err?.message ?? String(err) })
        settleSplits(session.id, { error: err })
      })
  })

  // 工具装载的同步函数（0.4.0）：tools 作用域建好后挂上来，每步开头调一次。
  const toolGate = { sync: null }

  // ── 装（主通道）：自己的 kind，每步重算，变了自己替换自己 ──────
  // 只在「回顾还没以自己的 kind 落过」时用 runtime-context，避免同一段文字存两份。
  // 这一轮已经通过 decision.messages 交出去的回顾（新会话第一轮走那条路），
  // runtime-context 兜底据此让位，免得同一段文字出两份。
  const pendingDecisionInject = new Set()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      // 0.4.0：开关可能刚被设置页改过，工具按当前开关重装一遍（幂等，没变就什么都不做）。
      try { toolGate.sync?.() } catch (err) { logger.warn?.('同步工具失败：' + (err?.message ?? err)) }
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
    reportMissing({ only: ['systemPrompt.context', 'systemPrompt.section', 'systemPrompt.getSectionOrder'] })
    if (cap()['systemPrompt.context'] !== true) logger.warn?.('宿主没有 systemPrompt.context()，回顾注入已关闭')
    if (cap()['systemPrompt.context'] === true) scope.systemPrompt.context({
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
    if (cap()['systemPrompt.section'] !== true) logger.warn?.('宿主没有 systemPrompt.section()，日记提醒与工具组清单不出现')
    if (cap()['systemPrompt.section'] === true) scope.systemPrompt.section({
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
    // 不连坐这一段（A）——选项页「工具固存」这一类单独管它。
    // 0.4.5：多一个「清单词刷新时刻」。默认 newSession 按会话冻住快照，会话中途装/删工具
    // 脚本不改系统提示词；realtime 才是 0.4.4 及以前的行为（每轮现算）。
    if (cap()['systemPrompt.section'] === true) scope.systemPrompt.section({
      name: TOOLKIT_SECTION_NAME,
      order: diarySectionOrder(scope.systemPrompt) + 1,
      interpolate: false,
      text: (promptContext) => {
        try {
          return toolListSectionText(dshHome, promptContext)
        } catch (err) {
          logger.error?.('工具组清单失败：' + (err?.stack ?? err))
          return ''
        }
      }
    })
  })

  // ── 用：读对话原文 / 一次 writes 批量写关键词与日记 ────────────────────
  ctx.inject(['tools'], (scope) => {
    reportMissing({ only: ['tools.register'] })
    if (cap()['tools.register'] !== true) {
      logger.warn?.('宿主没有 tools.register()，回顾工具不装')
      return
    }
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
    // 0.4.0：两组工具分别跟着两个开关走，按需装载。
    //   「自动回顾」开 → 拆/读回顾有用，装 mem 两个（读原文、写日记与关键词）；
    //   「注入工具组清单」开 → 工具组这条路有用，装 tool 三个（读原文、装脚本、跑脚本）。
    //   两个都关 = 这个插件在这台机器上不提供任何工具（回顾不拆、清单不注入，本来就没事可做）。
    const memTools = [
      buildReadToolDefinition({ dshHome, onHit: countHit }),
      buildWriteToolDefinition({ dshHome })
    ]
    // 0.3.3：读原文（session_tool_create_read）与装工具脚本（session_tool_create_write）拆成两个工具；
    // 跑工具脚本仍是 session_tool_call。
    const kitTools = [
      buildToolCreateReadDefinition({ dshHome, logger }),
      buildToolCreateWriteDefinition({ dshHome, logger }),
      buildToolCallToolDefinition({ dshHome, logger })
    ]
    const live = new Map()

    /**
     * 按当前选项把工具装到与开关一致的状态。幂等：已经对上了就什么都不做。
     * @returns {string[]} 当前装载的工具名
     */
    function syncTools() {
      let options
      try {
        options = readOptionsSync(dshHome)
      } catch {
        options = DEFAULT_OPTIONS
      }
      const want = new Map()
      if (options.autoReviewEnabled !== false) for (const d of memTools) want.set(d.name, d)
      if (options.toolListEnabled !== false) for (const d of kitTools) want.set(d.name, d)
      for (const [name, off] of [...live]) {
        if (want.has(name)) continue
        try { off() } catch (err) { logger.warn?.('卸载工具失败：' + name + ' ' + (err?.message ?? err)) }
        live.delete(name)
        logger.info?.('工具已卸载：' + name)
      }
      for (const [name, definition] of want) {
        if (live.has(name)) continue
        const off = scope.tools.register(definition)
        live.set(name, typeof off === 'function' ? off : () => {})
        logger.info?.('工具已装载：' + name)
      }
      return [...want.keys()]
    }

    toolGate.sync = syncTools
    syncTools()
  })

  // ── 管：设置页用的 HTTP 端点 + 删除所需的生命周期捕获 ──
  ctx.inject(['webServer', 'connection', 'agents'], (webCtx) => {
    reportMissing({ only: ['webServer.register', 'connection.requestRejection', 'agents.create', 'agents.resume'] })
    if (cap()['webServer.register'] !== true) {
      logger.warn?.('宿主没有 webServer.register()，设置页接口不装')
      return
    }
    // 缺 agents 的公开 create/resume 时：不装生命周期捕获（以前在这里 throw，
    // 症状是设置页那半块整个没加载），只关掉「删除活会话 / 删除并回顾」；
    // 列表与回顾管理照常——它们只依赖 persistence 与文件系统。
    const canLifecycle = cap()['agents.create'] === true && cap()['agents.resume'] === true
    if (canLifecycle) webCtx.effect(() => installLifecycle(webCtx.agents, logger), 'dsh-seal-scripts: 生命周期捕获')
    else logger.warn?.('宿主缺 agents.create/resume，删除活会话与「删除并回顾」已关闭')
    const getDeps = () => ({
      persistence: webCtx.get('sessionPersistence'),
      sessions: webCtx.get('sessions'),
      agents: webCtx.get('agents'),
      workspaceRegistry: webCtx.get('workspaceRegistry'),
      compaction: webCtx.get('compaction')
    })
    // 0.4.1：选项一落盘就同步工具，赶在下一次 systemPrompt.assemble() 之前。
    // 0.4.6：切「清单词刷新时刻」那一下，把所有已记住的会话刷新成此刻的现词。
    registerApi(webCtx, {
      dshHome, getDeps, waitForSplit: waitForSplitOf, onOptionsChanged: () => toolGate.sync?.(),
      onToolListRefreshChanged: () => { refreshCatalogSnapshots(dshHome, readLocaleSync(dshHome)) },
      canLifecycle, probe: () => capabilities.snapshot()
    })
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
