/**
 * 跟着 DSH 走（0.4.11）：超时与单流输出上限不再由插件自己写死，只从宿主的终端设置里读。
 *
 * 为什么要这一层：0.4.10 及以前插件里有三个死数——
 *   DEFAULT_TIMEOUT_MS = 120000、MAX_TIMEOUT_MS = 600000、DEFAULT_MAX_OUTPUT = 64KB + 1MB 封顶。
 * 用户在设置页把「命令超时」调成别的值，插件的脚本执行完全不理，还是按 12 万毫秒走。
 * 这不是「限制」的问题，是「设置不生效」的问题；所以这里改成三档取值：
 *
 *   1. ctx.shell（dsh-bash-local / dsh-bash-sandbox 注册的执行器）的 live config —— 最准，
 *      它就是真正在跑命令的那个实例；schemastery 的字段是 ref，读 .get()。
 *   2. ctx.settings（SettingsForms）的 describe() 里 bash-sandbox 那一行的 value ——
 *      同一条设置的另一份投影（设置页显示的就是它）。
 *   3. 都不在（老宿主，或服务还没起来）：退回 DSH 自己的默认值 120000 / 600000 / 64000，
 *      并**记下来原因**。绝不退回一个比 DSH 更小的数——那等于偷偷把上限压回去。
 *
 * 三项分开取：某一项读到就用读到的，读不到的项各自降级，不会因为少一项就整组丢掉。
 */

/** DSH 自己的默认值（@deepseek-ai/dsh-bash-local 的 Config：timeoutMs 12e4 / maxTimeoutMs 6e5 / maxOutputBytes 64e3）。 */
export const DSH_DEFAULTS = Object.freeze({
  timeoutMs: 120000,
  maxTimeoutMs: 600000,
  maxOutputBytes: 64000
})

/** 设置页上「终端」那一段在宿主里的命名空间（bash / pwsh / 老名字）。 */
const SETTINGS_NS = ['bash-sandbox', 'pwsh-sandbox', 'shell']

/** 三项的名字（一次性取，避免每处各写一遍）。 */
export const LIMIT_KEYS = Object.freeze(['timeoutMs', 'maxTimeoutMs', 'maxOutputBytes'])

/** 绑定的宿主上下文（apply 时绑一次）。 */
let boundCtx = null

/** 解析结果的缓存；宿主设置变了之后由 apply 里收到的事件清掉。 */
let cached = null

/**
 * 把宿主上下文绑上来，之后所有解析都走它。
 * @param {object} ctx cordis 上下文
 * @returns {() => void} 解绑（插件 dispose 时调用）
 */
export function bindHostLimits(ctx) {
  boundCtx = ctx ?? null
  cached = null
  return () => {
    if (boundCtx === ctx) boundCtx = null
    cached = null
  }
}

/** 设置变了就下一次重新读（设置页改完立刻生效，不用重启）。 */
export function invalidateHostLimits() {
  cached = null
}

/** 测试用：清掉绑定与缓存。 */
export function resetHostLimits() {
  boundCtx = null
  cached = null
}

/**
 * 把 schematic 的 ref / 函数 / 字符串数字之类的值收成一个正数。
 * 读不出来给 undefined（由调用方决定降级），绝不猜。
 * @param {unknown} value
 * @returns {number|undefined}
 */
export function positiveNumberOf(value) {
  let raw = value
  try {
    if (typeof raw === 'function') raw = raw()
    else if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') raw = raw.get()
  } catch {
    return undefined
  }
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (text === '') return undefined
    raw = Number(text)
  }
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** 从一个配置对象里取三项（读不到的项为 undefined）。 */
function pickLimits(cfg) {
  const out = {}
  if (cfg === null || typeof cfg !== 'object') return out
  for (const key of LIMIT_KEYS) {
    if (!(key in cfg)) continue
    const n = positiveNumberOf(cfg[key])
    if (n !== undefined) out[key] = n
  }
  return out
}

/** 来源一：ctx.shell（真正在跑命令的执行器）的 live config。 */
function fromShell(ctx) {
  let shell
  try { shell = typeof ctx?.get === 'function' ? ctx.get('shell') : undefined } catch { return {} }
  if (shell === null || shell === undefined) return {}
  // 执行器把 schemastery 的结果挂在 this.config 上（LocalBashExecutor 的构造里就是 this.config = config）。
  for (const holder of [shell.config, shell.options, shell]) {
    const picked = pickLimits(holder)
    if (Object.keys(picked).length > 0) return picked
  }
  return {}
}

/** 来源二：ctx.settings.describe() 里终端那一行。 */
function fromSettings(ctx) {
  let rows
  try {
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    if (!settings || typeof settings.describe !== 'function') return {}
    rows = settings.describe()
  } catch {
    return {}
  }
  if (!Array.isArray(rows)) return {}
  for (const ns of SETTINGS_NS) {
    const row = rows.find((r) => r && r.ns === ns && r.value && typeof r.value === 'object')
    if (!row) continue
    const picked = pickLimits(row.value)
    if (Object.keys(picked).length > 0) return picked
  }
  return {}
}

/**
 * 读当前生效的三项。
 *
 * @param {{ctx?:object, force?:boolean}} [p]
 * @returns {{timeoutMs:number, maxTimeoutMs:number, maxOutputBytes:number, followed:string[], missed:string[], source:string, note:string}}
 */
export function readHostLimits({ ctx = null, force = false } = {}) {
  if (!force && cached !== null && ctx === null) return cached
  const target = ctx ?? boundCtx

  const shell = fromShell(target)
  const settings = Object.keys(shell).length === LIMIT_KEYS.length ? {} : fromSettings(target)
  const followed = []
  const missed = []
  const sources = new Set()
  const out = { ...DSH_DEFAULTS }

  for (const key of LIMIT_KEYS) {
    if (shell[key] !== undefined) {
      out[key] = shell[key]
      followed.push(key)
      sources.add('ctx.shell')
      continue
    }
    if (settings[key] !== undefined) {
      out[key] = settings[key]
      followed.push(key)
      sources.add('ctx.settings')
      continue
    }
    missed.push(key)
  }

  const source = sources.size === 0 ? 'dsh-defaults' : [...sources].join('+')
  const note = missed.length === 0
    ? '跟随宿主终端设置（' + source + '）'
    : (sources.size === 0
      ? '读不到宿主终端设置（没有 ctx.shell.config，也没有 settings.describe().' + SETTINGS_NS[0] + '），这一轮按 DSH 默认值走'
      : '部分跟随宿主终端设置（' + source + '）；未读到：' + missed.join('、') + '，这几项按 DSH 默认值走')

  const result = {
    timeoutMs: out.timeoutMs,
    maxTimeoutMs: out.maxTimeoutMs,
    maxOutputBytes: out.maxOutputBytes,
    followed,
    missed,
    source,
    note
  }
  // 只有三项全都读到时才缓存：读不全就下一次重读，
  // 免得某个服务晚一步起来就把「降级值」永久钉住。
  if (ctx === null && missed.length === 0) cached = result
  return result
}

/** 一行的说明，给日志与 dryRun 回报用。 */
export function describeHostLimits(limits = readHostLimits()) {
  return limits.note + '：超时默认 ' + limits.timeoutMs + 'ms，上限 ' + limits.maxTimeoutMs +
    'ms，单流输出 ' + limits.maxOutputBytes + ' 字节'
}

/**
 * 把一次请求的超时收成宿主允许的值。
 *
 * 优先级（0.4.10 定的，不动）：单条 → 顶层 → 清单 → 默认。
 * 收口（0.4.11 改的）：只夹上界（宿主 maxTimeoutMs）与 1ms 下界。
 * 以前的下界 1000ms 也是死数，一并去掉。
 *
 * @param {unknown} value
 * @param {object} [limits]
 * @returns {number}
 */
export function clampTimeoutToHost(value, limits = readHostLimits()) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return limits.timeoutMs
  return Math.min(Math.max(Math.trunc(n), 1), limits.maxTimeoutMs)
}

/**
 * 把输出上限收成宿主允许的值：默认值来自宿主，不再另设封顶。
 * @param {unknown} value
 * @param {object} [limits]
 * @returns {number}
 */
export function clampOutputToHost(value, limits = readHostLimits()) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return limits.maxOutputBytes
  return Math.trunc(n)
}
