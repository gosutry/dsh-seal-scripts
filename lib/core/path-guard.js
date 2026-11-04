/**
 * 「路径必须落在这个目录里」的单一判据。
 *
 * 以前这条判据在三个地方各写一遍：tool.js 的 resolveMemoryFile、api.js 的 deleteMemory，
 * 而 api.js 的 readMemory / annotate 压根没写——于是它们能顺着 ../ 读到别的工作区的回顾。
 * 判据只留一份，谁要判就调这里。
 *
 * 差异说明：resolveMemoryFile 原本不拦"rel === ''"（即 file 恰好等于目录本身），
 * 这里统一拦掉——那不是一个文件。
 */

import path from 'node:path'

/**
 * 把 raw 解析成 dir 里的绝对路径；越界直接抛。
 *
 * 越界判断用「rel === '..' 或 rel 以 '..\' 开头」，不能用 rel.startsWith('..')：
 * 后者会把 '..foo.md' 这种合法文件名当成越界（它是目录内的普通文件）。
 * @param {string} dir
 * @param {string} raw 用户/模型给的文件名，可绝对可相对
 * @param {{label?:string}} [options] 报错时怎么称呼这件事
 * @returns {string} 绝对路径
 */
export function assertInside(dir, raw, options = {}) {
  const label = options.label ?? '这个目录'
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('文件名不能为空')
  const base = path.resolve(dir)
  const abs = path.resolve(base, text)
  const rel = path.relative(base, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new Error('只能操作 ' + label + ' 里的文件：' + text)
  }
  return abs
}

/** 必须是 .md（回顾文件）。 */
export function assertMarkdown(abs, raw) {
  if (!path.extname(abs).toLowerCase().endsWith('.md')) {
    throw new Error('不是回顾文件：' + String(raw ?? ''))
  }
  return abs
}
