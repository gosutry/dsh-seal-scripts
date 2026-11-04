/**
 * 我们对宿主**私有格式**的三处复刻，集中登记在这里。
 *
 * | 复刻 | 上游 | 上游一改，症状 |
 * |---|---|---|
 * | core/project-key.js 的 projectKey() | dsh-session-persistence-jsonl 的 projectKey() | 回顾目录与会话目录对不上号（功能不受影响，肉眼能看出来） |
 * | host/delete.js 的 encodeSegment() | 同上，会话目录名编码 | 删不掉会话（会报「找不到会话目录」） |
 * | core/zstd.js + host/summary.js 读 session.v4.jsonl.zstd | 会话日志格式（已有 v0→v1→v2→v3 迁移包） | 会话标题读不出来、/state 全是占位 id |
 *
 * 已实测一致的部分：projectKey 与宿主实现 12/12 逐样例一致（审计 §4.4）。
 *
 * 档 5 起加一条廉价告警：会话目录里出现了我们不认识的日志名，或者日志帧头
 * 不再是 zstd，就写 _health.json（code:'host-format-changed'），设置页能看见。
 * 探测只做一次 readdir + 最多 4 字节读，不在每次拆解时解一遍日志。
 */
import fs from 'node:fs'
import path from 'node:path'

export const LOG_NAME = 'session.v4.jsonl.zstd'

/** 目前认识的日志名：session[.v1..v4].jsonl[.zstd]。v5 起视为未知（上游改格式的信号）。 */
const KNOWN_LOG = /^session(?:\.v[1-4])?\.jsonl(?:\.zstd)?$/
/** 长得像会话日志的名字（不管版本）——只有这些才参与「未知日志名」判断。 */
const LOG_LIKE = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/

const ZSTD_MAGIC = 0xfd2fb528

/**
 * 廉价探测：会话目录里出现了我们不认识的日志文件、或者帧头不是 zstd。
 * 不读全文件（最多读第一帧的前 4 字节）。
 * @param {string} sessionDir 单个会话的日志目录
 * @returns {{ok:boolean, code?:string, detail?:string}}
 */
export function probeHostFormat(sessionDir) {
  let names
  try {
    names = fs.readdirSync(sessionDir)
  } catch {
    // 目录不存在 / 读不了：这不是「宿主改了格式」，不告警。
    return { ok: true }
  }

  const unknown = names.filter((n) => LOG_LIKE.test(n) && !KNOWN_LOG.test(n))
  if (unknown.length > 0) {
    return {
      ok: false,
      code: 'host-format-changed',
      detail: '出现了未知日志名 ' + unknown.join('、')
    }
  }

  // 已知日志名在：顺手看一眼魔术字，只读 4 字节。
  const log = path.join(sessionDir, LOG_NAME)
  try {
    const fd = fs.openSync(log, 'r')
    try {
      const head = Buffer.alloc(4)
      const n = fs.readSync(fd, head, 0, 4, 0)
      if (n === 4 && head.readUInt32LE(0) !== ZSTD_MAGIC) {
        return {
          ok: false,
          code: 'host-format-changed',
          detail: LOG_NAME + ' 的帧头不是 zstd 魔术字'
        }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    // 没有日志 / 读不了：交给 summary 的 no-log / unreadable，不在这里重复报。
  }
  return { ok: true }
}
