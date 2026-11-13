/**
 * 工具脚本执行（0.3.0；0.4.11 起两处硬改）。
 *
 * 三条硬规矩（一条没动）：
 *   1. 不经过 shell 拼字符串 —— 参数是数组，模型给的 args 改不了命令行结构；
 *   2. 只跑工具脚本目录里的文件，越界直接抛（resolveInside）；
 *   3. 跑之前对一遍 toolScript.json 里的 sha256，不一致就拒绝（除非调用方显式 allowDrift）。
 *
 * 0.4.11 改的两处：
 *
 *   超时：不再「到点杀进程」。spawn 时 detached，stdout/stderr 直接重定向进 _runs/ 下的
 *        两个日志文件（不经管道，父进程走了子进程也不会 EPIPE），到点只把「还在跑」的
 *        现场交回去：pid、日志路径、已经写出来的前一段。进程继续跑，输出继续往文件里写。
 *        这就是 DSH 自己的 promoteOnTimeout 行为，只是这里不依赖宿主的 jobs 服务。
 *        要停它：killRun(pid)（SIGTERM，KILL_GRACE_MS 后 SIGKILL）。
 *
 *   上限：默认超时、超时天花板、单流输出上限全部来自宿主的终端设置（host-limits.js）。
 *        读不到就退回 DSH 自己的默认值并注明原因——绝不退回一个更小的数。
 *        输出超出上限时仍然不丢：完整内容就在日志文件里。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveInside, sha256OfFile, runsDir } from './schema.js'
import { readHostLimits, clampTimeoutToHost, clampOutputToHost } from './host-limits.js'

/*
 * 0.4.10 的三个死数（120000 / 600000 / 64 KB）在这个文件里**不再存在**。
 * 读不到宿主设置时的兜底值只有一处：lib/core/host-limits.js 的 DSH_DEFAULTS，
 * 与 DSH bash-local 的 Config 默认值一致，且绝不比它更小。
 */

/** TERM 之后等多久再 KILL：0.4.11 起只给显式的 killRun() 用（超时不再杀进程）。 */
export const KILL_GRACE_MS = 2000

/** 子进程退出后等日志落盘的上限。 */
const CLOSE_GRACE_MS = 600

/**
 * 按 run 选解释器。node 用当前进程的可执行文件（不写死运行时路径），
 * PowerShell 用系统自带的那个，bash 交给 PATH（找不到时由 runScript 说清楚）。
 * @param {'bash'|'node'|'ps1'|'cmd'} run
 * @returns {{cmd:string, args:string[]}}
 */
export function interpreterOf(run) {
  switch (run) {
    case 'bash':
      return { cmd: 'bash', args: [] }
    case 'node':
      return { cmd: process.execPath, args: [] }
    case 'ps1': {
      if (process.platform !== 'win32') return { cmd: 'pwsh', args: ['-NoProfile', '-File'] }
      const root = process.env.SystemRoot || 'C:\\Windows'
      return {
        cmd: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File']
      }
    }
    case 'cmd': {
      if (process.platform !== 'win32') return { cmd: 'sh', args: [] }
      return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/c'] }
    }
    default:
      throw new Error('unknown run mode: ' + String(run))
  }
}

/**
 * 跑一条。顺序、退出码、超时、输出都在这里收口。
 * @param {object} p
 * @param {string} p.dshHome
 * @param {string} p.toolScriptId
 * @param {string} p.dir 工具脚本目录
 * @param {object} p.manifest toolScript.json 的内容
 * @param {string} p.step 脚本文件名
 * @param {string[]} [p.args] 脚本参数（argv，不经过 shell）
 * @param {string} [p.stdin] 写进标准输入的内容（给了才写）
 * @param {string} [p.cwd] 工作目录
 * @param {number} [p.timeoutMs]
 * @param {number} [p.maxOutputBytes]
 * @param {boolean} [p.allowDrift]
 * @param {object} [p.limits] 宿主限制（默认现读）
 * @returns {Promise<object>}
 */
export async function runScript({
  dshHome, toolScriptId, dir, manifest, step, args = [], stdin,
  cwd, timeoutMs, maxOutputBytes, allowDrift = false, limits
}) {
  const name = String(step ?? '').trim()
  const file = resolveInside(dir, name)
  if (!fs.existsSync(file)) throw new Error('this toolScript has no such script: ' + name)

  const scripts = Array.isArray(manifest?.scripts) ? manifest.scripts : []
  const meta = scripts.find((s) => s && s.name === name)
  if (!meta) throw new Error('this file is not in the toolScript manifest: ' + name)
  const hashes = manifest && typeof manifest.hashes === 'object' && manifest.hashes !== null ? manifest.hashes : {}
  const expected = typeof hashes[name] === 'string' ? hashes[name] : ''
  const actual = sha256OfFile(file)
  if (expected !== '' && expected !== actual && !allowDrift) {
    throw new Error('script sha256 does not match the manifest, refusing to run (' + name + '). ' +
      'If you just edited it by hand, reinstall the toolScript (session_tool_create_write + replace), or pass allowDrift: true explicitly this time.')
  }

  const host = limits ?? readHostLimits()
  const timeout = normalizeTimeout(timeoutMs === undefined ? (manifest?.timeoutMs ?? host.timeoutMs) : timeoutMs, host)
  const cap = normalizeMaxOutput(maxOutputBytes, host)
  const interp = interpreterOf(meta.run)
  const argv = [...interp.args, file, ...args.map((a) => String(a))]
  const runCwd = cwd || path.resolve(dir)

  const env = {
    ...process.env,
    TOOL_NAME: name,
    TOOL_SCRIPT: String(toolScriptId),
    TOOL_ROOT: path.resolve(dir),
    DSH_HOME: String(dshHome ?? process.env.DSH_HOME ?? '')
  }

  const startedAt = Date.now()
  const result = await spawnCollect({
    cmd: interp.cmd, argv, cwd: runCwd, env, timeout, cap, stdin,
    dshHome: String(dshHome ?? process.env.DSH_HOME ?? ''),
    label: String(toolScriptId) + ':' + name,
    meta: { toolScript: String(toolScriptId), step: name, run: meta.run, cwd: runCwd, timeoutMs: timeout, maxOutputBytes: cap, limits: { source: host.source, note: host.note } }
  })
  return {
    toolScript: String(toolScriptId),
    step: name,
    run: meta.run,
    argv,
    cwd: runCwd,
    drift: expected !== '' && expected !== actual,
    durationMs: Date.now() - startedAt,
    ...result
  }
}

/**
 * 时间收口：默认值与天花板都来自宿主设置（0.4.11）。
 * 非数字 → 宿主默认超时；越界 → 夹到宿主 maxTimeoutMs（绝不夹到一个插件自己写的数）。
 * @param {unknown} value
 * @param {object} [limits]
 * @returns {number}
 */
export function normalizeTimeout(value, limits = readHostLimits()) {
  return clampTimeoutToHost(value, limits)
}

/**
 * 输出上限收口：默认值来自宿主 maxOutputBytes；0.4.10 的 1MB 封顶删掉。
 * @param {unknown} value
 * @param {object} [limits]
 * @returns {number}
 */
export function normalizeMaxOutput(value, limits = readHostLimits()) {
  return clampOutputToHost(value, limits)
}

/** 名字里不许有目录分隔符（它要进文件名）。 */
function safeTag(text) {
  return String(text).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'run'
}

/** 一条运行的三个落点：stdout 日志、stderr 日志、可追溯的 meta。 */
export function runLogPaths(dshHome, label, startedAt = Date.now()) {
  const dir = runsDir(dshHome)
  const base = path.join(dir, String(startedAt) + '-' + safeTag(label) + '-' + process.pid)
  return { dir, base, stdoutFile: base + '.stdout.log', stderrFile: base + '.stderr.log', metaFile: base + '.run.json' }
}

/**
 * 从文件头读一段（同步，进程还在写也照读）。多大就是多大，不做别的解释。
 * @param {string} file
 * @param {number} cap
 * @returns {{text:string, size:number, truncated:boolean}}
 */
function readHead(file, cap) {
  let size = 0
  try { size = fs.statSync(file).size } catch { return { text: '', size: 0, truncated: false } }
  if (size <= 0) return { text: '', size: 0, truncated: false }
  const want = Math.min(size, cap)
  const buf = Buffer.allocUnsafe(want)
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const got = fs.readSync(fd, buf, 0, want, 0)
    return { text: buf.subarray(0, got).toString('utf8'), size, truncated: size > cap }
  } catch {
    return { text: '', size, truncated: size > cap }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* 已经关了 */ } }
  }
}

/**
 * 真正跑一次子进程：stdout/stderr 直接进日志文件，到点不杀、转后台。
 * 不 resolve 成「成功」，只如实回 exitCode / signal / timedOut / background。
 *
 * @returns {Promise<object>}
 */
function spawnCollect({ cmd, argv, cwd, env, timeout, cap, stdin, dshHome, label, meta }) {
  return new Promise((resolve, reject) => {
    const paths = runLogPaths(dshHome, label)
    let outFd
    let errFd
    try {
      fs.mkdirSync(paths.dir, { recursive: true })
      outFd = fs.openSync(paths.stdoutFile, 'w')
      errFd = fs.openSync(paths.stderrFile, 'w')
    } catch (err) {
      for (const fd of [outFd, errFd]) if (typeof fd === 'number') { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
      reject(new Error('failed to create the run log: ' + (err && err.message ? err.message : String(err))))
      return
    }

    let child
    try {
      child = spawn(cmd, argv, {
        cwd,
        env,
        windowsHide: true,
        // 0.4.11：detached 才不会被父进程的退出带走；输出直接进文件，不走管道。
        detached: process.platform !== 'win32',
        stdio: ['pipe', outFd, errFd]
      })
    } catch (err) {
      reject(new Error('cannot start interpreter ' + cmd + ': ' + (err && err.message ? err.message : String(err))))
      return
    } finally {
      // 子进程已经 dup 了自己的那一份，父进程这边立刻关掉，免得句柄泄漏。
      for (const fd of [outFd, errFd]) if (typeof fd === 'number') { try { fs.closeSync(fd) } catch { /* 忽略 */ } }
    }

    // 可追溯记录：这次跑的是什么、pid 几、什么时候开始。
    try {
      fs.writeFileSync(paths.metaFile, JSON.stringify({
        ...meta, pid: child.pid ?? null, startedAt: new Date().toISOString(),
        stdoutFile: paths.stdoutFile, stderrFile: paths.stderrFile
      }, null, 2) + '\n', 'utf8')
    } catch { /* 记不下来不影响跑 */ }

    let done = false
    let promoted = false
    let code = null
    let sig = null

    const settle = (fields) => {
      if (done) return
      done = true
      resolve(fields)
    }

    /** 正常结束时的回报：从日志文件头读两段，超出上限就指向完整文件。 */
    const finishNormal = () => {
      if (done || promoted) return
      // 必须清：这个定时器的默认寿命是宿主的 timeoutMs（12 万毫秒），留着会把事件循环吊住。
      clearTimeout(timer)
      const out = readHead(paths.stdoutFile, cap)
      const errOut = readHead(paths.stderrFile, cap)
      settle({
        exitCode: typeof code === 'number' ? code : null,
        signal: sig ?? null,
        timedOut: false,
        background: false,
        stdout: out.text,
        stderr: errOut.text,
        truncated: out.truncated || errOut.truncated,
        spill: out.truncated ? paths.stdoutFile : '',
        stderrSpill: errOut.truncated ? paths.stderrFile : '',
        logFile: paths.stdoutFile,
        stderrFile: paths.stderrFile
      })
    }

    // 到点：不杀，交回现场。
    const timer = setTimeout(() => {
      if (done) return
      promoted = true
      const out = readHead(paths.stdoutFile, cap)
      const errOut = readHead(paths.stderrFile, cap)
      // 让出事件循环，DSH 不被这个子进程攥着（它已经 detached，会自己跑完）。
      try { child.unref() } catch { /* 老 node 没有也就算了 */ }
      settle({
        exitCode: null,
        signal: null,
        timedOut: true,
        background: true,
        pid: child.pid ?? null,
        stdout: out.text,
        stderr: errOut.text,
        truncated: out.truncated || errOut.truncated,
        spill: out.truncated ? paths.stdoutFile : '',
        stderrSpill: errOut.truncated ? paths.stderrFile : '',
        logFile: paths.stdoutFile,
        stderrFile: paths.stderrFile,
        metaFile: paths.metaFile
      })
    }, timeout)

    // unref：跑着呢，是子进程的 handle 在撑事件循环；定时器不该单独把进程吊着。
    if (typeof timer.unref === 'function') timer.unref()

    child.on('error', (err) => {
      clearTimeout(timer)
      if (done) return
      done = true
      const message = err && err.code === 'ENOENT'
        ? 'interpreter not found: ' + cmd + (cmd === 'bash' ? ' (this toolScript is written in bash; bash is not on PATH on this machine — rewrite it as a node script or install bash first)' : '')
        : 'failed to start: ' + (err && err.message ? err.message : String(err))
      reject(new Error(message))
    })

    // 退出了就等日志落盘（CLOSE_GRACE_MS 兜底）。已经转后台的不用管，结果早交回去了。
    child.on('exit', (c, s) => {
      code = c
      sig = s
      if (promoted || done) return
      const finalTimer = setTimeout(finishNormal, CLOSE_GRACE_MS)
      if (typeof finalTimer.unref === 'function') finalTimer.unref()
    })
    child.on('close', (c, s) => {
      if (typeof code !== 'number' && code === null) { code = c; sig = s }
      finishNormal()
    })

    if (stdin !== undefined && stdin !== null) {
      try { child.stdin?.end(String(stdin)) } catch { /* 子进程可能不看 stdin */ }
    } else {
      // 不保留 stdin：后台化的进程不能攥着父进程的管道。
      try { child.stdin?.end() } catch { /* 同上 */ }
    }
  })
}

/** 进程还活着吗（pid 存在且不是自己）。 */
export function isAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err && err.code === 'EPERM'
  }
}

/** 睡一会儿（只给 killRun 的宽限期用）。 */
function sleep(ms) {
  return new Promise((done) => {
    const t = setTimeout(done, ms)
    if (typeof t.unref === 'function') t.unref()
  })
}

/**
 * 停掉一条转后台的运行：SIGTERM，KILL_GRACE_MS 内没走就 SIGKILL。
 * 0.4.11 之前这段逻辑在超时里；现在超时不杀，这里是**显式**停它的唯一入口。
 *
 * @param {number} pid
 * @param {{graceMs?:number}} [p]
 * @returns {Promise<{pid:number, term:boolean, sigkill:boolean, exited:boolean, waitedMs:number}>}
 */
export async function killRun(pid, { graceMs = KILL_GRACE_MS } = {}) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) throw new Error('killRun needs a positive pid: ' + String(pid))
  const signal = (s) => {
    try { process.kill(-n, s); return true } catch { /* 进程组可能已经没了 */ }
    try { process.kill(n, s); return true } catch { return false }
  }
  const startedAt = Date.now()
  const term = signal('SIGTERM')
  const limit = Date.now() + Math.max(0, Number(graceMs) || 0)
  while (Date.now() < limit) {
    if (!isAlive(n)) return { pid: n, term, sigkill: false, exited: true, waitedMs: Date.now() - startedAt }
    await sleep(50)
  }
  const stillAlive = isAlive(n)
  const sigkill = stillAlive ? signal('SIGKILL') : false
  // SIGKILL 之后给一点点时间让内核回收
  for (let i = 0; i < 20 && isAlive(n); i++) await sleep(25)
  return { pid: n, term, sigkill, exited: !isAlive(n), waitedMs: Date.now() - startedAt }
}
