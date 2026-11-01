/**
 * 抓住 agents.create / agents.resume 返回的句柄。
 *
 * 删活会话要先 cancel → whenIdle → flush → dispose，而 dispose 能力只在
 * agents.create/resume 返回的 handle 上。这里在公共边界上截一份，别的什么都不碰。
 *
 * 幂等：已经被别的插件（比如 dsh-web-mobile）打过标记就不再包一层。
 */

const ownedHandles = new WeakMap()
const ownedHandlesOf = (agent) => ownedHandles.get(agent)
const MARK = '__dshSessionRecallLifecycle'

/**
 * 安装生命周期捕获。
 * @param {object|undefined} agents
 * @returns {() => void} 卸载函数（已安装过则返回空函数）
 */
export function installLifecycle(agents) {
  if (agents === undefined || agents === null) return () => {}
  if (agents[MARK] === true) return () => {}
  const proto = Object.getPrototypeOf(agents)
  const originals = new Map()
  for (const method of ['create', 'resume']) {
    const original = proto[method]
    if (typeof original !== 'function') throw new Error('missing public agents.' + method + ' API')
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
    for (const [method, { original, patched }] of originals) {
      if (proto[method] === patched) proto[method] = original
    }
    agents[MARK] = false
  }
}

export { ownedHandlesOf }
