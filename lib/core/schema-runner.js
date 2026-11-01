/**
 * 工具脚本执行（0.3.0）：把一套里的某个脚本按 argv 数组跑起来。
 *
 * 三条硬规矩：
 *   1. 不经过 shell 拼字符串 —— 参数是数组，模型给的 args 改不了命令行结构；
 *   2. 只跑工具脚本目录里的文件，越界直接抛（resolveInside）；
 *   3. 跑之前对一遍 toolScript.json 里的 sha256，不一致就拒绝（除非调用方显式 allowDrift）。
 *
 * 输出：单条超过上限就溢写进 _runs/（写全量，不是写截断后的），返回前一段 + 溢写路径。
 * 超时：先 SIGTERM，2 秒后 SIGKILL；Windows 上走 taskkill /T 把整棵进程树带走
 * （cygwin 的 bash 会留一个 sleep 孙进程攥着管道，只杀父进程会白等到它自己结束）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveInside, sha256OfFile, runsDir } from './schema.js'

/** 默认超时 120 秒，上限 600 秒（和 ops_bash 的上限对齐）。 */
export const DEFAULT_TIMEOUT_MS = 120000
export const MAX_TIMEOUT_MS = 600000

/** 单条输出上限 64 KB。 */
export const DEFAULT_MAX_OUTPUT = 64 * 1024

/** TERM 之后等多久再 KILL。 */
const KILL_GRACE_MS = 2000

/** 子进程退出后，等管道关闭的上限（孙进程攥着管道时不陪它等）。 */
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
      throw new Error('未知执行方式：' + String(run))
  }
}

/**
 * 跑一条。顺序、退出码、超时、截断都在这里收口。
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
 * @returns {Promise<object>}
 */
export async function runScript({
  dshHome, toolScriptId, dir, manifest, step, args = [], stdin,
  cwd, timeoutMs, maxOutputBytes, allowDrift = false
}) {
  const name = String(step ?? '').trim()
  const file = resolveInside(dir, name)
  if (!fs.existsSync(file)) throw new Error('这个工具脚本里没有这个脚本：' + name)

  const scripts = Array.isArray(manifest?.scripts) ? manifest.scripts : []
  const meta = scripts.find((s) => s && s.name === name)
  if (!meta) throw new Error('这个文件不在这个工具脚本的清单里：' + name)
  const hashes = manifest && typeof manifest.hashes === 'object' && manifest.hashes !== null ? manifest.hashes : {}
  const expected = typeof hashes[name] === 'string' ? hashes[name] : ''
  const actual = sha256OfFile(file)
  if (expected !== '' && expected !== actual && !allowDrift) {
    throw new Error('脚本和清单里的 sha256 对不上，先不跑（' + name + '）。' +
      '如果你刚手动改过它，重装这个工具脚本（session_tool_create_write + replace），或者这次显式传 allowDrift: true。')
  }

  const timeout = normalizeTimeout(timeoutMs === undefined ? (manifest?.timeoutMs ?? DEFAULT_TIMEOUT_MS) : timeoutMs)
  const cap = normalizeMaxOutput(maxOutputBytes)
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
  const result = await spawnCollect({ cmd: interp.cmd, argv, cwd: runCwd, env, timeout, cap, stdin })
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

/** 时间收口：非数字给默认，越界夹到上限。 */
export function normalizeTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.trunc(n), 1000), MAX_TIMEOUT_MS)
}

/** 输出上限收口。 */
export function normalizeMaxOutput(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_OUTPUT
  return Math.min(Math.trunc(n), 1024 * 1024)
}

/**
 * 真正跑一次子进程：收集 stdout/stderr，超上限就溢写。
 * 不 resolve 成「成功」，只如实回 exitCode / signal / timedOut。
 * @returns {Promise<{exitCode:number|null, signal:string|null, timedOut:boolean, stdout:string, stderr:string, truncated:boolean, spill:string}>}
 */
function spawnCollect({ cmd, argv, cwd, env, timeout, cap, stdin }) {
  return new Promise((resolve, reject) => {
    const detached = process.platform !== 'win32'
    let child
    try {
      child = spawn(cmd, argv, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], detached })
    } catch (err) {
      reject(new Error('起不来解释器 ' + cmd + '：' + (err?.message ?? err)))
      return
    }

    const out = { stdout: [], stderr: [], bytes: 0, truncated: false }
    let spillFile = ''
    let spillFd = null
    let killedByTimeout = false
    let done = false
    let exited = false
    let code = null
    let sig = null

    // 溢写：第一次超限时把已经收到的头一段写进去，之后按到达顺序追加。
    const openSpill = () => {
      if (spillFile !== '') return
      try {
        const dir = runsDir(env.DSH_HOME || '')
        fs.mkdirSync(dir, { recursive: true })
        spillFile = path.join(dir, Date.now() + '-' + String(env.TOOL_SCRIPT || 'toolScript') + '-' +
          String(env.TOOL_NAME || 'step') + '.log')
        spillFd = fs.openSync(spillFile, 'w')
        if (out.stdout.length > 0) fs.writeSync(spillFd, Buffer.concat(out.stdout))
        fs.writeSync(spillFd, '\n----- stderr -----\n')
        if (out.stderr.length > 0) fs.writeSync(spillFd, Buffer.concat(out.stderr))
        fs.writeSync(spillFd, '\n----- 之后的内容按到达顺序 -----\n')
      } catch {
        spillFile = ''
        spillFd = null
      }
    }

    const take = (which, chunk) => {
      if (spillFd !== null) {
        try { fs.writeSync(spillFd, chunk) } catch { /* 盘满之类：算了，返回值还在 */ }
        return
      }
      if (out.truncated) return
      const room = cap - out.bytes
      if (chunk.length <= room) {
        out[which].push(chunk)
        out.bytes += chunk.length
        return
      }
      if (room > 0) out[which].push(chunk.subarray(0, room))
      out.bytes = cap
      out.truncated = true
      openSpill()
      const rest = room > 0 ? chunk.subarray(room) : chunk
      if (spillFd !== null) {
        try { fs.writeSync(spillFd, rest) } catch { /* 同上 */ }
      }
    }

    const killTree = (signal) => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') {
          const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          k.on('error', () => {})
        } else if (detached) {
          try { process.kill(-child.pid, signal) } catch { child.kill(signal) }
        } else {
          child.kill(signal)
        }
      } catch { /* 进程已经没了 */ }
    }

    const timer = setTimeout(() => {
      killedByTimeout = true
      killTree('SIGTERM')
      const graceTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS)
      if (typeof graceTimer.unref === 'function') graceTimer.unref()
    }, timeout)

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (spillFd !== null) {
        try { fs.closeSync(spillFd) } catch { /* 已经关了 */ }
        spillFd = null
      }
      const stdout = Buffer.concat(out.stdout).toString('utf8')
      const stderr = Buffer.concat(out.stderr).toString('utf8')
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        signal: sig ?? null,
        timedOut: killedByTimeout,
        stdout: out.truncated
          ? stdout + '\n[输出超过单条上限（' + cap + ' 字节），完整内容在 ' + (spillFile || '（溢写失败，已丢）') + ']'
          : stdout,
        stderr,
        truncated: out.truncated,
        spill: spillFile
      })
    }

    child.stdout?.on('data', (c) => take('stdout', c))
    child.stderr?.on('data', (c) => take('stderr', c))

    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (spillFd !== null) { try { fs.closeSync(spillFd) } catch { /* 忽略 */ } }
      const message = err && err.code === 'ENOENT'
        ? '找不到解释器：' + cmd + (cmd === 'bash' ? '（这个工具脚本用 bash 写的；这台机器上 bash 不在 PATH 里，改写 node 脚本或先装 bash）' : '')
        : '起不来：' + (err?.message ?? err)
      reject(new Error(message))
    })

    // 子进程自己退了：最多再等 CLOSE_GRACE_MS 让管道收完，孙进程攥着管道也不陪它等。
    child.on('exit', (c, s) => {
      code = c
      sig = s
      exited = true
      const finalTimer = setTimeout(finish, CLOSE_GRACE_MS)
      if (typeof finalTimer.unref === 'function') finalTimer.unref()
    })
    child.on('close', (c, s) => {
      if (!exited) { code = c; sig = s }
      finish()
    })

    if (stdin !== undefined && stdin !== null) {
      try { child.stdin?.end(String(stdin)) } catch { /* 子进程可能不看 stdin */ }
    } else {
      try { child.stdin?.end() } catch { /* 同上 */ }
    }
  })
}
