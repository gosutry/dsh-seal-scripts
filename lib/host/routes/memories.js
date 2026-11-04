/**
 * 回顾文件本身：memory（读一份）/ memory-delete（删一份）/ annotate（改关键词与日记）。
 * 写侧两道闸门都在 core/tool.js 的 applyWrite 里，这里只负责过路径闸门与回状态码。
 */

import { join, basename } from 'node:path'
import { stat, readFile, rm, mkdir } from 'node:fs/promises'
import { memoryDir, removeEntry, writeFileAtomic } from '../../core/store.js'
import { parseMemory } from '../../core/memory-file.js'
import { applyWrite } from '../../core/tool.js'
import { assertInside, assertMarkdown } from '../../core/path-guard.js'
import { dialogueOnly } from '../../core/render.js'
import { respond, readBody } from '../http-util.js'

const PREFIX = '/api/session-recall.'

/**
 * 删掉一条回顾：先删正文，再删它的边车。路径必须在回顾目录内。
 *
 * 没有共享清单了，所以这里不需要锁：两个文件各自删各自的。
 */
async function deleteMemory(dshHome, cwd, file) {
  const dir = memoryDir(dshHome, cwd)
  // 判据只留 path-guard 一份（以前这里自带一份，用 startsWith('..') 会把 ..foo.md 误拦）。
  const abs = assertMarkdown(assertInside(dir, file, { label: '本工作区的回顾目录' }), file)
  const exists = await stat(abs).then(() => true, () => false)
  if (!exists) throw new Error('这份回顾不存在：' + file)
  // 顺序不能反：先删正文、再删边车。中间崩溃 → 边车成了孤儿，readAssembly 会自己清掉。
  // 反过来（先删边车）而正文还在，下一次读会按 mtime 把边车补回来——等于没删掉索引。
  await rm(abs, { force: true })
  await removeEntry(dir, basename(abs))
  return { ok: true, file: basename(abs), removed: 1 }
}

/**
 * 读一份回顾。
 *
 * 路径闸门只管写（annotate / delete）：读按用户裁定 (b) 保持可跨工作区——
 * 设置页翻看别的工作区的回顾是正常用途，改不了别人的记忆就够。
 */
async function readMemory(dshHome, cwd, file) {
  const dir = memoryDir(dshHome, cwd)
  const text = await readFile(join(dir, file), 'utf8')
  const parsed = parseMemory(text)
  return { file, meta: parsed.meta, sections: parsed.sections, dialogue: dialogueOnly(parsed.sections.body ?? '') }
}

/** @param {(path:string, handler:Function) => void} route @param {{dshHome:string}} deps */
export function routesMemories(route, { dshHome }) {
  route(PREFIX + 'memory-delete', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (typeof body.cwd !== 'string' || typeof body.file !== 'string') {
      respond(res, 400, { error: { code: 'invalid-body', message: '需要 cwd 与 file' } }); return
    }
    respond(res, 200, await deleteMemory(dshHome, body.cwd, body.file))
  })

  route(PREFIX + 'memory', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (typeof body.cwd !== 'string' || typeof body.file !== 'string') {
      respond(res, 400, { error: { code: 'invalid-body', message: '需要 cwd 与 file' } }); return
    }
    respond(res, 200, await readMemory(dshHome, body.cwd, body.file))
  })

  route(PREFIX + 'annotate', async (req, res) => {
    if (req.method !== 'POST') { respond(res, 405, { error: { code: 'method-not-allowed', message: 'POST' } }); return }
    const body = JSON.parse(await readBody(req) || '{}')
    if (typeof body.cwd !== 'string' || typeof body.file !== 'string') {
      respond(res, 400, { error: { code: 'invalid-body', message: '需要 cwd 与 file' } }); return
    }
    const hasKeywords = Array.isArray(body.keywords)
    const hasDiary = typeof body.diary === 'string'
    if (!hasKeywords && !hasDiary) {
      respond(res, 400, { error: { code: 'invalid-body', message: 'keywords 与 diary 至少给一个' } }); return
    }
    // 写侧必须过闸门：以前这里直接 join + 手写 tmp/rename，能改别的工作区的回顾，
    // 也不受「日记 ≤ 摘要、关键词 < 日记」约束，写不进去时还回 ok:true。
    const dir = memoryDir(dshHome, body.cwd)
    await mkdir(dir, { recursive: true })
    const abs = assertMarkdown(assertInside(dir, body.file, { label: '本工作区的回顾目录' }), body.file)
    const before = await readFile(abs, 'utf8')
    // 和 session_mem_write 走同一个 applyWrite：两道闸门、只动目标区、改完校验。
    // 它抛什么就回什么——设置页和模型看到的是同一句话。
    let applied
    try {
      applied = applyWrite(before, {
        file: basename(abs),
        keywords: hasKeywords ? body.keywords : undefined,
        diary: hasDiary ? body.diary : undefined
      })
    } catch (error) {
      // 闸门拦下来的写：原样透传那句多行中文诊断，状态用 400（调用方参数不合格，不是服务端坏了）。
      respond(res, 400, { error: { code: 'write-rejected', message: error?.message ?? String(error) } })
      return
    }
    await writeFileAtomic(abs, applied.next)
    respond(res, 200, { ok: true, changed: applied.changed, diary: applied.diary, keywords: applied.keywords })
  })
}
