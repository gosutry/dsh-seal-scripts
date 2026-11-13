/**
 * 宿主能力探测。
 *
 * 这个插件没有 npm 依赖，但它对宿主有一批硬依赖（审计 §4.2）。
 * 以前一条都不探测：宿主升级后缺了哪一条，用户看到的是「某一整块悄悄不工作」
 * 或「设置页打不开」。这里把它们变成一个可查询的表，缺了就降级那一块、并说清缺什么。
 *
 * 原则：**探测失败不是崩溃，是降级**。
 * 唯一会真正失效的是 zstd：没有它读不出会话标题，但回顾本身照常。
 *
 * 注意：cordis 的 ctx.get(name) 只返回「已经就绪」的服务。插件 inject = []，
 * 所以在 apply() 刚进来时宿主服务可能还没起来——那时只能探到 zstd。
 * 其余各项在各自的 ctx.inject 回调里用注入后的 scope 再探一次，结果合并。
 */

import { canDecodeZstd } from '../core/zstd.js'

const fn = (v) => typeof v === 'function'

/** 没有它就没有对应功能、且没有替代路径的条目。 */
export const REQUIRED = [
  'systemPrompt.context',
  'systemPrompt.section',
  'systemPrompt.getSectionOrder',
  'tools.register',
  'webServer.register',
  'agents.create',
  'agents.resume',
  'sessionPersistence.list',
  'sessionPersistence.root',
  'workspaceRegistry.list',
  'zstd.decompress'
]

/**
 * 一次性探测当前上下文能看到的能力。
 * @param {{get:(name:string)=>any}|null|undefined} ctx cordis 上下文（可以是注入后的 scope）
 * @returns {{ok: boolean, missing: Array<{block:string, why:string}>, table: Record<string, boolean>, optional: Record<string, boolean>}}
 */
export function probeCapabilities(ctx, { only } = {}) {
  const table = {}
  const optional = {}
  const missing = []
  const need = (block, name, got) => {
    table[block] = got === true
    if (!got) missing.push({ block, why: 'missing ' + name })
  }
  const more = (block, got) => { table[block] = got === true }

  const get = (name) => {
    try { return typeof ctx?.get === 'function' ? ctx.get(name) : undefined } catch { return undefined }
  }

  const systemPrompt = get('systemPrompt')
  need('systemPrompt.context', 'systemPrompt.context()', fn(systemPrompt?.context))
  need('systemPrompt.section', 'systemPrompt.section()', fn(systemPrompt?.section))
  need('systemPrompt.getSectionOrder', 'systemPrompt.getSectionOrder()', fn(systemPrompt?.getSectionOrder))

  const tools = get('tools')
  need('tools.register', 'tools.register()', fn(tools?.register))

  const webServer = get('webServer')
  need('webServer.register', 'webServer.register()', fn(webServer?.register))

  const connection = get('connection')
  // 鉴权钩子是可选增强：缺了不拦人，只少一层保护。
  optional['connection.requestRejection'] = fn(connection?.requestRejection)
  table['connection.requestRejection'] = optional['connection.requestRejection']

  const agents = get('agents')
  let proto = null
  try { proto = agents === undefined || agents === null ? null : Object.getPrototypeOf(agents) } catch { proto = null }
  need('agents.create', 'agents.create()', fn(proto?.create))
  need('agents.resume', 'agents.resume()', fn(proto?.resume))

  const persistence = get('sessionPersistence')
  need('sessionPersistence.list', 'sessionPersistence.list()', fn(persistence?.list))
  need('sessionPersistence.root', 'persistence.config.root', typeof persistence?.config?.root === 'string')

  const registry = get('workspaceRegistry')
  need('workspaceRegistry.list', 'workspaceRegistry.list()', fn(registry?.list))
  // 归档徽章：没有它只是少一个徽章。detachSession 挂在 list() 的行上，
  // 启动时拿不到，只能在删除时按行探测（delete.js 已经会把它记成 warning）。
  optional['workspaceRegistry.archivedSessionIds'] = Array.isArray(registry?.archivedSessionIds)
  const sessions = get('sessions')
  optional['sessions.flush'] = fn(sessions?.flush)
  const compaction = get('compaction')
  optional['compaction.compactNow'] = fn(compaction?.compactNow)
  for (const [k, v] of Object.entries(optional)) table[k] = v === true

  // zstd 属于「没有它就没有标题」，单独一条；与宿主服务无关，任何时候都能探。
  // 档 5 起「可用」= 原生可用或被内置解码器兜住——所以这条在本插件里恒为 true；
  // 探测函数单独留着，是为了让宿主能力表仍然是一个能查询的真值。
  const zstd = canDecodeZstd()
  need('zstd.decompress', 'zlib.zstdDecompressSync() or the built-in decoder', zstd)

  if (Array.isArray(only)) {
    // 只报「这块此刻应该就绪」的条目：apply 刚进来时别把还没起来的服务当成缺失。
    const keep = new Set(only)
    for (const k of Object.keys(table)) if (!keep.has(k)) delete table[k]
    for (const k of Object.keys(optional)) if (!keep.has(k)) delete optional[k]
    const kept = missing.filter((m) => keep.has(m.block))
    return { ok: kept.length === 0, missing: kept, table, optional }
  }
  return { ok: missing.length === 0, missing, table, optional }
}

/** 一句话说清缺了什么，给日志与界面用。 */
export function describeMissing(probe) {
  if (!probe || !Array.isArray(probe.missing) || probe.missing.length === 0) return ''
  return probe.missing.map((m) => m.why).join('；')
}

/**
 * 把多次探测（apply 时一次 + 每个 inject 回调一次）合并成一张表。
 * 后来探到的 true 覆盖先前的 false（apply 时服务常未就绪）。
 */
export function mergeCapability(base, next) {
  if (!next) return base
  for (const [k, v] of Object.entries(next.table ?? {})) {
    base.table[k] = base.table[k] === true || v === true
  }
  for (const [k, v] of Object.entries(next.optional ?? {})) {
    base.optional[k] = base.optional[k] === true || v === true
  }
  // 只报「这次确实看到过、而且没有」的项：apply 刚进来时宿主服务可能还没就绪，
  // 把「还没看到」当成「没有」会误报一整屏。
  base.missing = REQUIRED.filter((k) => Object.prototype.hasOwnProperty.call(base.table, k) && base.table[k] !== true).map((block) => {
    const hit = (next.missing ?? []).find((m) => m.block === block)
    return hit ?? { block, why: 'missing ' + block }
  })
  base.ok = base.missing.length === 0
  return base
}

/** 给 apply() 用的可增量探测对象。 */
export function createCapabilityProbe(baseCtx) {
  const state = { ok: true, missing: [], table: {}, optional: {} }
  return {
    state,
    /**
     * 探测并合并；返回本次新出现的缺失块（用于只警告一次）。
     * @param {object} [scope] 注入后的上下文；默认用 apply 时那个 ctx
     *   （ctx.get 是动态的：同一个 ctx 在服务就绪后就能看到它们）。
     */
    probe(scope, opts) {
      const before = new Set(state.missing.map((m) => m.block))
      mergeCapability(state, probeCapabilities(scope ?? baseCtx, opts))
      return state.missing.filter((m) => !before.has(m.block))
    },
    snapshot() {
      return { ok: state.ok, missing: state.missing.slice(), table: { ...state.table } }
    }
  }
}
