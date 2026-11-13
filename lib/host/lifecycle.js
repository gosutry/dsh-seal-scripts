/**
 * 抓住 agents.create / agents.resume 返回的句柄。
 *
 * 删活会话要先 cancel → whenIdle → flush → dispose，而 dispose 能力只在
 * agents.create/resume 返回的 handle 上。这里在公共边界上截一份，别的什么都不碰。
 *
 * 幂等：已经被别的插件（比如 dsh-web-mobile）打过标记就不再包一层。
 *
 * E5：缺方法不再抛。以前这里 throw，而它跑在 webCtx.effect() 里——
 * 宿主一改 agents 的形状，症状是「设置页那半块整个没加载」。
 * 现在缺了就 warn 并返回空卸载函数：只是「删除活会话」不可用，其余照常。
 *
 * 也确认过没有更窄的公开路：handle 只从 create/resume 的返回值来，
 * agent/created 事件里只有 agent 与 source，没有 dispose 句柄。
 */

const ownedHandles = new WeakMap()
const ownedHandlesOf = (agent) => ownedHandles.get(agent)
const MARK = '__dshSessionRecallLifecycle'
const METHODS = ['create', 'resume']

/**
 * 安装生命周期捕获。
 * @param {object|undefined} agents
 * @param {{warn?:Function}} [logger]
 * @returns {() => void} 卸载函数（未安装/已安装过则返回空函数）
 */
export function installLifecycle(agents, logger) {
  if (agents === undefined || agents === null) return () => {}
  if (agents[MARK] === true) return () => {}
  const proto = Object.getPrototypeOf(agents)
  if (proto === null || typeof proto !== 'object') {
    logger?.warn?.('host agents have no usable prototype; deleting live sessions is off')
    return () => {}
  }
  // 先把两条都验完再动手：验一条补一条的话，第二条缺了会留下半套补丁。
  for (const method of METHODS) {
    if (typeof proto[method] !== 'function') {
      logger?.warn?.('host lacks agents.' + method + '(); deleting live sessions is off')
      return () => {}
    }
  }
  const originals = new Map()
  for (const method of METHODS) {
    const original = proto[method]
    if (original[MARK] === true) continue
    const patched = async function (...args) {
      const handle = await Reflect.apply(original, this, args)
      if (handle?.agent !== undefined && typeof handle.dispose === 'function') ownedHandles.set(handle.agent, handle)
      return handle
    }
    patched[MARK] = true
    proto[method] = patched
    originals.set(method, { original, patched })
  }
  agents[MARK] = true
  return () => {
    // 只还原自己那一层：别人后来又包了一层的话，保持他的包装不动。
    for (const [method, { original, patched }] of originals) {
      if (proto[method] === patched) proto[method] = original
    }
    agents[MARK] = false
  }
}

export { ownedHandlesOf }
