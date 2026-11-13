/**
 * 语言从哪来（0.2.3）：只跟 DSH 的设置。
 *
 * 设置页那一半（客户端）读 DSH 的 locale 服务，每次语言一变就把它 POST 到
 * /api/session-seal-scripts.locale 记在这里；注入这一半（宿主）每一步同步读这个文件。
 * 没有文件（还没打开过界面、或是 CLI）就按中文——文件里没写的东西一律当默认值。
 *
 * 存在 <dshHome>/session-memory/_locale.json，和 _options.json 同层。
 */

import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './store.js'
import { normalizeLang, LANG_ZH } from './lang.js'

/** 语言文件名。 */
export const LOCALE_FILE = '_locale.json'

/**
 * 语言文件路径。
 * @param {string} dshHome
 * @returns {string}
 */
export function localePath(dshHome) {
  return path.join(String(dshHome), 'session-memory', LOCALE_FILE)
}

/**
 * 读当前语言。文件不存在、坏了、没有 dshHome 都当中文，绝不抛错。
 * @param {string} dshHome
 * @returns {'zh'|'en'}
 */
export function readLocaleSync(dshHome) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') return LANG_ZH
  try {
    const raw = JSON.parse(fs.readFileSync(localePath(dshHome), 'utf8'))
    return normalizeLang(raw && raw.locale)
  } catch {
    return LANG_ZH
  }
}

/**
 * 记下客户端当前的语言（原子写）。
 * @param {string} dshHome
 * @param {string} id DSH 的 locale id，例如 zh / en / en-US
 * @returns {Promise<'zh'|'en'>} 收好之后的语言
 */
export async function writeLocale(dshHome, id) {
  if (typeof dshHome !== 'string' || dshHome.trim() === '') throw new Error('no dshHome, cannot write the locale')
  const locale = normalizeLang(id)
  await fsPromises.mkdir(path.dirname(localePath(dshHome)), { recursive: true })
  await writeFileAtomic(localePath(dshHome), JSON.stringify({ locale }, null, 2) + '\n')
  return locale
}
