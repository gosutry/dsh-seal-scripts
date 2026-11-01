/**
 * 会话事件 -> 原文。
 *
 * 原文只有四种行首（见设计文档第三节）：
 *   [用户] 用户说的
 *   [模型] 模型说的
 *   ▸      工具发起
 *   ◂      工具结果 / 报错
 *
 * 铁律：所有续行缩进两个空格。这样即便用户贴了一段以 [用户] 开头的文字，
 * 它也只会是一条缩进的续行，骗不过行首匹配。
 *
 * 注意：压缩事件里的 shadowedSeqs 只列表面事件
 * （user/message、assistant/message、tool/result），
 * 独立的 tool/call 事件不在里面 —— 工具调用要从 assistant/message 的
 * tool-call 内容块里取，否则工具足迹会整个丢掉。
 *
 * PTC 还有第三层：模型写的 run_code 里，代码自己调 tools.xxx(...)。
 * 这些既不在 shadowedSeqs 里，也不在 assistant/message 的内容块里，
 * 只有 tool/ptc-dispatch-start（发起）和 tool/ptc-dispatch（结果）两种独立事件。
 * 不接住它们，内层调用就只剩代码文本里的一行字，谁调的、返回什么都查不到。
 */

/** 用户消息里真正由用户说的那种 source.kind；其余都是系统注入。 */
const USER_KIND = 'user'

/* 工具参数不做任何压缩：日志删掉之后，回顾文件里的这份就是唯一原文。 */

/** 四个行首标记，别处也复用。 */
export const MARK = { user: '[用户] ', model: '[模型] ', call: '▸ ', result: '◂ ' }

/**
 * 把工具参数摊成可读文本：换行、缩进、长度全部原样保留。
 *
 * 回顾文件是日志被删之后唯一的原文，所以这里不许截断、不许把空白压成空格——
 * 压一次，那段命令就永久没了。
 *
 * 首行放主参数（下面 PICK 里的第一个），其余字段一行一个跟在后面 —— 全都要，
 * 一个字段都不许丢：grep 的 pattern、write 的 content、edit 的 old_string
 * 以前只因为「不是第一个命中的字段」就整段没进文件。
 *
 * 入参可能是 JSON 字符串（assistant/message 的 tool-call、tool/call 事件），
 * 也可能已经是对象（tool/ptc-dispatch 的 arguments），两种都收。
 * @param {string|object} raw
 * @returns {string}
 */
const PICK = ['command', 'code', 'file_path', 'pattern', 'path', 'url', 'query']

export function toolArgsText(raw) {
  if (raw === undefined || raw === null) return ''
  let obj
  if (typeof raw === 'object') obj = raw
  else if (typeof raw === 'string') { try { obj = JSON.parse(raw) } catch { obj = undefined } }
  else return String(raw).replace(/\r\n/g, '\n')
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return String(raw).replace(/\r\n/g, '\n')
  }
  let key = PICK.find((k) => typeof obj[k] === 'string')
  let text
  if (key !== undefined) {
    text = obj[key]
  } else if (Array.isArray(obj.queries) && obj.queries.every((q) => typeof q === 'string')) {
    key = 'queries'
    text = obj.queries.join('\n')
  } else {
    // 一个主字段都对不上：整段带缩进的 JSON，不压成一行。
    return JSON.stringify(obj, null, 2).replace(/\r\n/g, '\n')
  }
  const out = [String(text).replace(/\r\n/g, '\n')]
  for (const [k, v] of Object.entries(obj)) {
    if (k === key || v === undefined) continue
    if (typeof v === 'string') {
      const s = v.replace(/\r\n/g, '\n')
      if (s.includes('\n')) out.push(k + ':', ...s.split('\n'))
      else out.push(k + ': ' + s)
    } else {
      out.push(k + ': ' + JSON.stringify(v))
    }
  }
  return out.join('\n')
}

/**
 * 追加一个带行首标记的块：首行加前缀，其余行缩进两格。空文本什么也不写。
 * @param {string[]} out
 * @param {string} prefix
 * @param {string} text
 * @returns {boolean} 是否真的写了
 */
function pushBlock(out, prefix, text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  if (lines.length === 0) return false
  out.push(prefix + lines[0])
  for (let i = 1; i < lines.length; i++) {
    out.push(lines[i] === '' ? '' : '  ' + lines[i])
  }
  return true
}

/** 取内容块里的纯文本，忽略 reasoning / tool-call / 图片。 */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
}

/**
 * 把一段会话事件渲染成原文。
 * @param {Iterable<object>} events 该区间的事件，顺序即 seq 顺序
 * @returns {string}
 */
export function renderTranscript(events) {
  const out = []
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue
    const data = event.data ?? {}
    switch (event.type) {
      case 'user/message': {
        // 只收用户本人说的话；agent-instructions / runtime-context /
        // time-context / skill-catalog / compact-checkpoint 都是系统注入，不进原文。
        if (data.source?.kind !== USER_KIND) break
        pushBlock(out, MARK.user, textOf(data.content))
        break
      }
      case 'assistant/message': {
        // 按内容块原顺序走：reasoning 是草稿丢掉，text 是模型说的话，
        // tool-call 是工具发起 —— 后者必须在这里取，工具事件不在 shadowedSeqs 里。
        const blocks = Array.isArray(data.message?.content) ? data.message.content : []
        for (const block of blocks) {
          if (!block) continue
          if (block.type === 'text') pushBlock(out, MARK.model, block.text)
          else if (block.type === 'tool-call') {
            const args = toolArgsText(block.arguments)
            pushBlock(out, MARK.call, args ? String(block.name ?? '') + ': ' + args : String(block.name ?? ''))
          }
        }
        break
      }
      case 'tool/call': {
        // 兜底：万一某个后端把工具调用单独记成事件（而不是内容块），也接住。
        // 同时存在两种记录时，assistant/message 那份总在前面，这里会重复，所以只在
        // 没有 assistant 记录过的调用上生效 —— 由调用方按需传 dedupe。
        const args = toolArgsText(data.arguments)
        pushBlock(out, MARK.call, args ? String(data.name ?? '') + ': ' + args : String(data.name ?? ''))
        break
      }
      case 'tool/ptc-dispatch-start': {
        // PTC：代码里 tools.xxx(...) 的发起。参数在这里落一次，
        // 配对的 tool/ptc-dispatch 再补结果。start 有 dispatch 无（执行中断）时也不丢参数。
        const args = toolArgsText(data.arguments)
        pushBlock(out, MARK.call, args ? String(data.name ?? '') + ': ' + args : String(data.name ?? ''))
        break
      }
      case 'tool/ptc-dispatch': {
        // 同一个 subCallId 的结果。发起已在 start 里写过，这里只写返回与成败。
        const body = textOf(data.content)
        if (body) pushBlock(out, '  ', body)
        const err = data.error
        if (err || data.isError) {
          const reason = typeof err === 'string'
            ? err
            : [err?.name, err?.reason ?? err?.code].filter(Boolean).join(': ')
          out.push(MARK.result + '报错：' + (reason || '未知错误'))
        } else {
          out.push(MARK.result + '完成')
        }
        break
      }
      case 'tool/result': {
        const body = textOf(data.message?.content ?? data.content)
        if (body) pushBlock(out, '  ', body)
        const err = data.error
        if (err) {
          const reason = typeof err === 'string' ? err : [err.name, err.reason ?? err.code].filter(Boolean).join(': ')
          out.push(MARK.result + '报错：' + (reason || '未知错误'))
        } else {
          out.push(MARK.result + '完成')
        }
        break
      }
      default:
        break
    }
  }
  return out.join('\n')
}

/**
 * 只留对话（深度 3 时用）：靠当前块类型判断，不逐行猜。
 * 工具块、工具输出、报错整块丢弃；对话块内的续行原样保留。
 * @param {string} body 原文
 * @returns {string}
 */
export function dialogueOnly(body) {
  let kind = null
  const out = []
  for (const line of String(body).split('\n')) {
    if (line.startsWith(MARK.user) || line.startsWith(MARK.model)) {
      kind = 'say'
      out.push(line)
    } else if (line.startsWith(MARK.call) || line.startsWith(MARK.result)) {
      kind = 'tool'
    } else if (line.trim() === '') {
      // 空行只是同一个块里的段落分隔，不是块的结束。
      // 以前这里把 kind 清成 null，于是多段回复从第一个空行往后整段被丢掉
      // （真实事故：注入里只剩「改好了，宝宝。」，后面的正文全没了）。
      if (kind === 'say') out.push(line)
    } else if (kind === 'say') {
      out.push(line)
    }
  }
  return out.join('\n')
}

/** 数原文里的工具调用次数与失败次数。 */
export function countTools(body) {
  let calls = 0
  let failures = 0
  for (const line of String(body).split('\n')) {
    if (line.startsWith(MARK.call)) calls++
    else if (line.startsWith(MARK.result + '报错')) failures++
  }
  return { calls, failures }
}
