/**
 * 插件入口。
 *
 * 只导出宿主加载契约需要的三个：name / apply / inject
 * （cordis-plugin-loader 的 unwrapExports 取 exports.default ?? exports）。
 *
 * 0.1.x 时代这里再导出 42 个符号，是留给「外部可能 import」的门面；
 * 实测 profile 里没有任何包 import 过这个包，档 1 起测试也全部走内部路径
 * （tests/_load.mjs 指向 lib/core/*.js），所以删掉之后测试仍然全绿——
 * 那就是「没人用」的证明。
 */
export { apply, inject, name } from './lib/core/index.js'
