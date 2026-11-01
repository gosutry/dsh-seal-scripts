/**
 * 工作区目录编码 —— 照搬 DSH 会话存储的 projectKey 规则，
 * 这样回顾目录和 $DSH_HOME/sessions/ 的目录名一一对应，肉眼就能对上。
 *
 *   /sdcard/Download        -> --sdcard-Download--
 *   /sdcard/Download/出图   -> --sdcard-Download-~51FA~56FE--
 *
 * 规则来源：dsh-session-persistence-jsonl/lib/index.js 的 projectKey()。
 * 这里重新实现一份，是为了不依赖 DSH 内部未导出的函数。
 */

/**
 * 把路径分隔符换成减号，把不安全字符换成 ~XXXX。
 * @param {string} cwd 会话的工作目录（绝对路径）
 * @returns {string} 单段、可做目录名的 key
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('cannot encode an empty project path')
  }
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/, '') || 'root'
  return '--' + trimmed.slice(0, 251) + '--'
}

/**
 * 反解：把 projectKey 还原成路径（只用于展示；有损，原路径里的 - 也会变回 /）。
 * @param {string} key
 * @returns {string}
 */
export function decodeProjectKey(key) {
  let s = key
  if (s.startsWith('--')) s = s.slice(2)
  if (s.endsWith('--')) s = s.slice(0, -2)
  s = s.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  return '/' + s
}
