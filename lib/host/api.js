/**
 * 兼容入口。
 *
 * 档 4 把原来 315 行的 api.js 拆成 register.js + routes/*.js：
 * 端点按域分开，register.js 只管建路表与装路由。
 * lib/core/index.js 与档 1–3 的测试还按这个路径 import，所以留一个纯转发的薄壳。
 */

export { registerApi } from './register.js'
