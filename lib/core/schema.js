/**
 * 工具组（0.3.0）：把回顾原文里的操作固化成「工具脚本」——一个目录、一份清单、若干脚本。
 *
 * 装起来像一个小插件，跑起来像插件自带的工具：不新增任何插件，
 * 也不让模型每次现写代码，只把入口挂在系统提示词里（catalogText），命令住在磁盘上。
 *
 * 目录：$DSH_HOME/session-memory/toolSequence/          ← 机器级，一个机器上装的所有工具脚本共用
 *   _index.json           总索引（查找、哈希、注入都读它）
 *   <id>/toolScript.json      这个工具脚本自己的清单（入口、步骤、参数、出处、验证状态）
 *   <id>/README.md        从清单自动生成，给人看
 *   <id>/<脚本文件>
 *   _runs/                输出溢写（超过单条上限才落，不删）
 *
 * 只依赖 node 内置模块；写盘走「先写临时目录，最后一次 rename」，
 * 不给读的人看到装到一半的文件。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/** 工具组目录名（在记忆根下，和 session-memory/<工作区 key>/ 平级）。 */
export const TOOL_SEQUENCE_DIR = 'toolSequence'

/** 总索引文件名。 */
export const INDEX_FILE = '_index.json'

/** 单个工具脚本的清单文件名。 */
export const TOOL_SCRIPT_FILE = 'toolScript.json'

/** 输出溢写目录。 */
export const RUNS_DIR = '_runs'

/** 索引格式版本。 */
const INDEX_VERSION = 1

/** 工具脚本 id：小写、数字、连字符，开头顶一个字母。 */
export const BUNDLE_ID_RE = /^[a-z][a-z0-9-]{1,40}$/

/** 脚本文件名：不许带路径分隔符，不许点开头。 */
export const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/

/** 每种执行方式允许的扩展名。 */
export const RUN_EXT = {
  bash: ['.sh'],
  node: ['.js', '.mjs', '.cjs'],
  ps1: ['.ps1'],
  cmd: ['.bat', '.cmd']
}

/** 执行方式的中文名（报错与 README 用）。 */
export const RUN_LABEL = { bash: 'bash 脚本', node: 'node 脚本', ps1: 'PowerShell 脚本', cmd: '批处理' }

/** 单脚本上限 64 KB；一次装一个工具脚本的上限 512 KB。 */
export const MAX_SCRIPT_BYTES = 64 * 1024
export const MAX_TOOL_SCRIPT_BYTES = 512 * 1024

/** 注入到系统提示词里的清单上限。 */
export const CATALOG_MAX_LINES = 24
export const CATALOG_MAX_CHARS = 1600

/**
 * 工具组根目录。
 * @param {string} dshHome
 * @returns {string}
 */
export function toolSequenceRoot(dshHome) {
  return path.join(String(dshHome), 'session-memory', TOOL_SEQUENCE_DIR)
}

/**
 * 某个工具脚本的目录。
 * @param {string} dshHome
 * @param {string} id
 * @returns {string}
 */
export function toolScriptDir(dshHome, id) {
  return path.join(toolSequenceRoot(dshHome), id)
}

/** 索引文件路径。 */
export function indexPath(dshHome) {
  return path.join(toolSequenceRoot(dshHome), INDEX_FILE)
}

/**
 * 把工具组目录建好（插件一启动就调用）。
 *
 * 为什么非要建：目录只在第一次装工具脚本时才出现，用户去 session-memory 下找一个
 * 「工具文件夹」就会扑空。空目录也建，看得见才算放着。
 * @param {string} dshHome
 * @returns {Promise<string>} 工具组根目录
 */
export async function ensureToolSequenceDir(dshHome) {
  const root = toolSequenceRoot(dshHome)
  await fsp.mkdir(root, { recursive: true })
  return root
}

/** 溢写目录路径。 */
export function runsDir(dshHome) {
  return path.join(toolSequenceRoot(dshHome), RUNS_DIR)
}

/**
 * id 合法性：不合格直接抛，不静默改名。
 * @param {string} id
 * @returns {string}
 */
export function assertToolScriptId(id) {
  const s = String(id ?? '').trim()
  if (!BUNDLE_ID_RE.test(s)) {
    throw new Error('toolScript.id 要写成小写字母开头的短名（a-z 0-9 -，2~41 位）：' + (s || '（空）'))
  }
  return s
}

/**
 * 把脚本文件名收干净：不许路径、不许点开头。
 * @param {string} name
 * @returns {string}
 */
export function assertFileName(name) {
  const s = String(name ?? '').trim()
  if (!FILE_NAME_RE.test(s)) throw new Error('脚本文件名不合法（只许字母数字 . _ -，不许带路径）：' + (s || '（空）'))
  return s
}

/**
 * 执行方式与扩展名要对得上：bash 配 .sh、node 配 .js/.mjs/.cjs……
 * @param {string} name
 * @param {string} run
 * @returns {string}
 */
export function assertRunMatches(name, run) {
  if (!RUN_EXT[run]) throw new Error('run 只收 bash / node / ps1 / cmd：' + String(run))
  const ext = path.extname(name).toLowerCase()
  if (!RUN_EXT[run].includes(ext)) {
    throw new Error(name + ' 的扩展名是 ' + (ext || '（无）') + '，和 run=' + run +
      ' 对不上；应该是 ' + RUN_EXT[run].join(' / '))
  }
  return run
}

/** 文件 sha256（小写十六进制）。 */
export function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * 在某个目录里解析一个相对路径；越界直接抛。
 * @param {string} dir
 * @param {string} rel
 * @returns {string}
 */
export function resolveInside(dir, rel) {
  const raw = String(rel ?? '').trim()
  if (raw === '') throw new Error('文件名为空')
  const base = path.resolve(dir)
  const abs = path.resolve(base, raw)
  const r = path.relative(base, abs)
  if (r === '' || r.startsWith('..') || path.isAbsolute(r)) {
    throw new Error('只能操作这个工具脚本目录里的文件：' + raw)
  }
  return abs
}

/**
 * 读索引；没装过、坏了都给空。同步版给注入路径用（systemPrompt.section 的 text 是同步求值）。
 * @param {string} dshHome
 * @returns {{version:number, toolScripts:Record<string, object>}}
 */
export function readIndexSync(dshHome) {
  try {
    const raw = fs.readFileSync(indexPath(dshHome), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.toolScripts || typeof parsed.toolScripts !== 'object') {
      return { version: INDEX_VERSION, toolScripts: {} }
    }
    return { version: parsed.version ?? INDEX_VERSION, toolScripts: parsed.toolScripts }
  } catch {
    return { version: INDEX_VERSION, toolScripts: {} }
  }
}

/** 读索引（异步版给工具用）。 */
export async function readIndex(dshHome) {
  try {
    const raw = await fsp.readFile(indexPath(dshHome), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || !parsed.toolScripts || typeof parsed.toolScripts !== 'object') {
      return { version: INDEX_VERSION, toolScripts: {} }
    }
    return { version: parsed.version ?? INDEX_VERSION, toolScripts: parsed.toolScripts }
  } catch {
    return { version: INDEX_VERSION, toolScripts: {} }
  }
}

/** 原子写索引：临时文件 + rename（Windows 失败就退避重试）。 */
export async function writeIndex(dshHome, index) {
  const dir = toolSequenceRoot(dshHome)
  await fsp.mkdir(dir, { recursive: true })
  const file = indexPath(dshHome)
  const tmp = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  await fsp.writeFile(tmp, JSON.stringify({ version: INDEX_VERSION, toolScripts: index.toolScripts ?? {} }, null, 2) + '\n', 'utf8')
  let lastError = null
  for (let i = 0; i < 6; i++) {
    try { await fsp.rename(tmp, file); return } catch (err) {
      lastError = err
      await new Promise((r) => setTimeout(r, 12 * (i + 1)))
    }
  }
  try {
    await fsp.rm(file, { force: true })
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw lastError ?? err
  }
}

/**
 * 列出所有工具脚本（已装的那些）。
 * @param {string} dshHome
 * @returns {Promise<Array<{id:string,title:string,purpose:string,entry:string,params:string[],steps:string[]}>>}
 */
export async function listToolScripts(dshHome) {
  const { toolScripts } = await readIndex(dshHome)
  const out = []
  for (const [id, meta] of Object.entries(toolScripts)) {
    if (!meta || typeof meta !== 'object') continue
    out.push({
      id,
      title: String(meta.title ?? id),
      purpose: String(meta.purpose ?? ''),
      entry: String(meta.entry ?? ''),
      params: Array.isArray(meta.params) ? meta.params.map(String) : [],
      steps: Array.isArray(meta.steps) ? meta.steps.map(String) : []
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 读一个工具脚本的清单。
 * @param {string} dshHome
 * @param {string} id
 * @returns {Promise<{manifest:object, dir:string}>}
 */
export async function loadToolScript(dshHome, id) {
  const clean = assertToolScriptId(id)
  const dir = toolScriptDir(dshHome, clean)
  let raw
  try {
    raw = await fsp.readFile(path.join(dir, TOOL_SCRIPT_FILE), 'utf8')
  } catch {
    throw new Error('没有这个工具脚本：' + clean + '（装过的工具脚本：不带参数调用 session_tool_call 看名单）')
  }
  let manifest
  try { manifest = JSON.parse(raw) } catch { throw new Error('这个工具脚本的 toolScript.json 坏了：' + clean) }
  if (!manifest || typeof manifest !== 'object') throw new Error('这个工具脚本的 toolScript.json 不是对象：' + clean)
  return { manifest, dir }
}

/**
 * 校验并补齐一个工具脚本的规格（不碰磁盘）。故意不做「猜名字」之类的兜底：错就报错。
 * @param {object} spec
 * @returns {object} 规范化后的工具脚本规格
 */
export function normalizeToolScript(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('toolScript 必须是对象')
  const id = assertToolScriptId(spec.id)
  const title = String(spec.title ?? '').trim()
  if (title === '') throw new Error('toolScript.title 不能为空：一句话说这个工具脚本叫什么')
  const purpose = String(spec.purpose ?? '').trim()
  if (purpose === '') throw new Error('toolScript.purpose 不能为空：一句话说这个工具脚本干什么')
  if (Buffer.byteLength(purpose, 'utf8') > 600) throw new Error('toolScript.purpose 太长了（600 字节以内），它会上系统提示词')

  const scriptsIn = Array.isArray(spec.scripts) ? spec.scripts : []
  const docsIn = Array.isArray(spec.docs) ? spec.docs : []
  if (scriptsIn.length === 0) throw new Error('toolScript.scripts 不能是空的：至少要有一个能跑的脚本')

  let total = 0
  const seen = new Set()
  const scripts = scriptsIn.map((s, i) => {
    if (s === null || typeof s !== 'object' || Array.isArray(s)) throw new Error('scripts[' + i + '] 必须是对象')
    const name = assertFileName(s.name)
    const run = assertRunMatches(name, s.run)
    const content = String(s.content ?? '')
    if (content.trim() === '') throw new Error(name + ' 的内容是空的')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SCRIPT_BYTES) throw new Error(name + ' 超过 64 KB（' + bytes + ' 字节）；拆成两个脚本')
    if (content.includes('<!--ovr:')) throw new Error(name + ' 里出现了回顾文件的分区标记 <!--ovr:，会污染解析，删掉它')
    if (seen.has(name)) throw new Error('同一个脚本名出现了两次：' + name)
    seen.add(name)
    total += bytes
    return { name, run, content, params: Array.isArray(s.params) ? s.params.map(String) : [] }
  })
  const docSeen = new Set()
  const docs = docsIn.map((d, i) => {
    if (d === null || typeof d !== 'object' || Array.isArray(d)) throw new Error('docs[' + i + '] 必须是对象')
    const name = assertFileName(d.name)
    if (path.extname(name).toLowerCase() !== '.md') throw new Error(name + ' 是说明文件，扩展名要写 .md')
    if (name.toLowerCase() === 'readme.md') {
      throw new Error(name + ' 和安装时自动生成的 README.md 同名，装进去会被静默覆盖；换个名字（比如 ' + (i === 0 ? 'notes.md' : 'notes-' + i + '.md') + '）')
    }
    if (docSeen.has(name)) throw new Error('docs 里同名出现了两次：' + name + '（第二份会覆盖第一份）')
    docSeen.add(name)
    const content = String(d.content ?? '')
    if (content.trim() === '') throw new Error(name + ' 的内容是空的')
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > MAX_SCRIPT_BYTES) throw new Error(name + ' 超过 64 KB')
    total += bytes
    return { name, content }
  })
  if (total > MAX_TOOL_SCRIPT_BYTES) throw new Error('这个工具脚本超过 512 KB（' + total + ' 字节）；拆成两个')

  const entry = assertFileName(spec.entry ?? scripts[0].name)
  if (!seen.has(entry)) throw new Error('toolScript.entry 必须是 scripts 里的一个文件：' + entry)
  const steps = (Array.isArray(spec.steps) ? spec.steps : []).map((s) => assertFileName(s))
  for (const s of steps) if (!seen.has(s)) throw new Error('toolScript.steps 里的 ' + s + ' 不在 scripts 里')

  const timeoutMs = spec.timeoutMs === undefined ? 120000 : Number(spec.timeoutMs)
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error('toolScript.timeoutMs 要在 1000~600000 之间（默认 120000）')
  }

  const provenance = spec.provenance && typeof spec.provenance === 'object'
    ? {
      memory: spec.provenance.memory === undefined ? '' : String(spec.provenance.memory),
      line: Number.isInteger(spec.provenance.line) ? spec.provenance.line : null,
      seq: Number.isInteger(spec.provenance.seq) ? spec.provenance.seq : null
    }
    : { memory: '', line: null, seq: null }

  return {
    version: 1,
    id, title, purpose,
    params: Array.isArray(spec.params) ? spec.params.map(String) : [],
    entry, steps, timeoutMs, provenance,
    createdAt: new Date().toISOString(),
    verified: spec.verified && typeof spec.verified === 'object' ? spec.verified : null,
    scripts, docs
  }
}

/** 从清单生成人看的 README.md。 */
export function renderToolScriptReadme(manifest) {
  const lines = [
    '# ' + manifest.title + '（' + manifest.id + '）',
    '',
    manifest.purpose,
    '',
    '- 入口：' + manifest.entry,
    ...(manifest.params.length > 0 ? ['- 参数：' + manifest.params.join('、')] : []),
    ...(manifest.steps.length > 0 ? ['- 步骤：' + manifest.steps.join(' → ')] : []),
    ...(manifest.provenance.memory ? ['- 出处：' + manifest.provenance.memory + (manifest.provenance.line ? (' 第 ' + manifest.provenance.line + ' 行') : '')] : []),
    '- 验证：' + (manifest.verified && manifest.verified.at ? (manifest.verified.at + ' exit ' + manifest.verified.exitCode) : '还没跑过'),
    '',
    '## 文件',
    ''
  ]
  for (const s of manifest.scripts) lines.push('- ' + s.name + '（' + RUN_LABEL[s.run] + '）')
  for (const d of manifest.docs) lines.push('- ' + d.name + '（说明，不执行）')
  lines.push('', '用 session_tool_call 直接跑：toolScript 写 ' + manifest.id + '；先看一眼 argv 就加 dryRun: true。')
  return lines.join('\n') + '\n'
}

/**
 * 装一个工具脚本：先写临时目录，再整体 rename 进来。
 * @param {{dshHome:string, spec:object, replace?:boolean}} p
 * @returns {Promise<{id:string, dir:string, files:Array<{name:string,bytes:number,sha256:string,kind:string}>, indexPath:string, backup:string}>}
 */
export async function installToolScript({ dshHome, spec, replace = false }) {
  const manifest = normalizeToolScript(spec)
  const root = toolSequenceRoot(dshHome)
  await fsp.mkdir(root, { recursive: true })
  const dir = toolScriptDir(dshHome, manifest.id)
  const exists = fs.existsSync(dir)
  if (exists && !replace) {
    const abs = path.join(dir, TOOL_SCRIPT_FILE)
    const sha = fs.existsSync(abs) ? sha256OfFile(abs) : ''
    throw new Error('这个工具脚本已经装过了：' + manifest.id + '（' + dir + (sha ? '，清单 sha256 ' + sha.slice(0, 12) : '') +
      '）；要重装就传 replace: true，旧目录会留一份 .bak-<时间戳>')
  }

  const stage = path.join(root, manifest.id + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8))
  await fsp.rm(stage, { recursive: true, force: true })
  await fsp.mkdir(stage, { recursive: true })
  const files = []
  try {
    for (const s of manifest.scripts) {
      const file = path.join(stage, s.name)
      await fsp.writeFile(file, s.content, 'utf8')
      files.push({ name: s.name, bytes: Buffer.byteLength(s.content, 'utf8'), sha256: sha256OfFile(file), kind: 'script' })
    }
    for (const d of manifest.docs) {
      const file = path.join(stage, d.name)
      await fsp.writeFile(file, d.content, 'utf8')
      files.push({ name: d.name, bytes: Buffer.byteLength(d.content, 'utf8'), sha256: sha256OfFile(file), kind: 'doc' })
    }
    manifest.hashes = Object.fromEntries(files.map((f) => [f.name, f.sha256]))
    await fsp.writeFile(path.join(stage, TOOL_SCRIPT_FILE), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    await fsp.writeFile(path.join(stage, 'README.md'), renderToolScriptReadme(manifest), 'utf8')
  } catch (err) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    throw err
  }

  let backup = ''
  try {
    if (exists) {
      backup = dir + '.bak-' + Date.now()
      await fsp.rename(dir, backup)
    }
    await fsp.rename(stage, dir)
  } catch (err) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => {})
    if (backup) {
      await fsp.rename(backup, dir).catch(() => {})
      backup = ''
    }
    throw err
  }

  const index = await readIndex(dshHome)
  index.toolScripts[manifest.id] = {
    title: manifest.title,
    purpose: manifest.purpose,
    entry: manifest.entry,
    params: manifest.params,
    steps: manifest.steps,
    dir: manifest.id,
    timeoutMs: manifest.timeoutMs,
    updatedAt: new Date().toISOString(),
    hashes: Object.fromEntries(files.map((f) => [f.name, f.sha256]))
  }
  await writeIndex(dshHome, index)

  return { id: manifest.id, dir, files, indexPath: indexPath(dshHome), backup }
}

/**
 * 注入到系统提示词的那几行：短、按 id 排、有上限。
 * 每次装配时现读索引（同步），装/删工具脚本后下一轮就变——这是它唯一会动缓存的地方。
 * @param {string} dshHome
 * @param {'zh'|'en'|string} lang
 * @returns {string}
 */
export function catalogText(dshHome, lang = 'zh') {
  const { toolScripts } = readIndexSync(dshHome)
  const entries = Object.entries(toolScripts)
    .filter(([, m]) => m && typeof m === 'object')
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  const en = String(lang).toLowerCase().startsWith('en')
  // 「自创工具 = 工具脚本」的词表桥接。模型在决定「产物该是什么」时看的是这一段，
  // 而不是某个工具的描述——0.3.6 的新句放进了 create_write 描述里，实测仍未被采纳。
  const runHint = en ? 'Look before running: pass "dryRun": true to session_tool_call. ' : '跑之前想看命令，就给 session_tool_call 加 dryRun: true。'
  const guide = en
    ? 'When the user asks to turn a working setup into a reusable procedure (summarize it into a toolList / freeze it as a workflow / do it this way next time), the artifact is a toolScript — the exact commands to run again, not a markdown note and not a skill that only states a method. Write it with session_tool_create_write: from the steps you just ran, from a recall original via session_tool_create_read, or from material already in the workspace. Call session_tool_create_write only with a script that already ran clean, never a draft; editing after installing re-sends the whole context.'
    : '用户说「把那套总结成经验 / 固化成流程 / 以后照这个做」时，要的产物就是工具脚本——能直接跑的脚本，不是 md 笔记，也不是教方法的 skill。用 session_tool_create_write 写下来：命令来自刚跑通的步骤、经 session_tool_create_read 翻出的回顾原文，或工作区里现成的材料。调用 session_tool_create_write 之前，脚本必须已经跑通；写进去的就是跑通的那一份，不是装好再改的草稿。装完再改，等于把整段上下文重发一遍。'
  // 空工具组也要留一句：否则模型根本不知道有写侧工具，更不会把工具脚本当成候选产物。
  if (entries.length === 0) {
    return (en ? '【ToolSequence · empty】Nothing frozen yet. ' : '【工具组 · 空】还没有固化任何工具脚本。') + guide
  }
  const lines = []
  lines.push(en
    ? '【ToolSequence · ' + entries.length + ' toolScript(s)】Whole scripts already frozen from paths that worked. Run them with session_tool_call — do not rewrite them, do not re-derive commands.'
    : '【工具组 · ' + entries.length + ' 个工具脚本】已经固化好的脚本，直接用 session_tool_call 跑；不用自己写代码，也不用重新找命令。')
  // 指引紧跟标题、排在工具脚本条目之前：一旦触发 CATALOG_MAX_CHARS 截断，被截掉的应是条目，不是这段词表。
  lines.push(runHint + guide)
  let shown = 0
  for (const [id, m] of entries) {
    if (shown >= CATALOG_MAX_LINES) {
      lines.push(en ? '…（more: run session_tool_call without arguments）'
        : '…（还有 ' + (entries.length - CATALOG_MAX_LINES) + ' 个，不带参数调用 session_tool_call 看全名单）')
      break
    }
    const title = String(m.title ?? id)
    const purpose = String(m.purpose ?? '').replace(/\s+/g, ' ')
    const short = purpose.length > 80 ? purpose.slice(0, 78) + '…' : purpose
    const params = Array.isArray(m.params) && m.params.length > 0 ? '｜' + (en ? 'args ' : '参数 ') + m.params.join(' ') : ''
    lines.push(en
      ? '· ' + id + ' (' + title + '): ' + short + '｜entry ' + String(m.entry ?? '') + params
      : '· ' + id + '（' + title + '）：' + short + '｜入口 ' + String(m.entry ?? '') + params)
    shown++
  }
  let text = lines.join('\n')
  if (text.length > CATALOG_MAX_CHARS) text = text.slice(0, CATALOG_MAX_CHARS - 1) + '…'
  return text
}
