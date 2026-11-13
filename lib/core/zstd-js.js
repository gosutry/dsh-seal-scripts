/**
 * 纯 JS 的 zstd 解压（只解 DSH 会写出来的那部分）。
 *
 * 为什么要有它：宿主日志是 zstd 多帧，Node 22.15 之前的 zlib 没有
 * zstdDecompressSync —— 那些机器上「会话标题」整个读不出来（档 3 只能降级提示）。
 *
 * 范围（档 5 说明 §2.4 / 用户裁定 X-3(a)）：
 *   · 帧头（FCS 字段 0/2/4/8，single-segment）；
 *   · 多帧串接；
 *   · raw / RLE block；
 *   · compressed block：literals（raw / RLE / Huffman，1 或 4 个流，含 treeless）+ sequences（FSE）；
 *   · repeat offset 0/1/2；
 *   · 跳过校验和验证（只跳过 4 字节，不算）。
 * 不支持：字典（frame header 里 dictID != 0 直接抛）、多帧并行解码、长距离匹配优化。
 *
 * 正确性的唯一 oracle：用本机 zlib.zstdCompressSync 造样本，逐字节比对。
 */

const MAGIC = 0xfd2fb528

/** 带 code 的失败：调用方据此退回降级显示，而不是把半截数据当成功。 */
function fail(message, code = 'zstd-corrupt') {
  const err = new Error('zstd: ' + message)
  err.code = code
  return err
}

function highbit32(x) {
  return 31 - Math.clz32(x)
}

/* ────────────────────────────────────────────────────────────────
 * 位流：两套方向
 *   ForwardBitReader   FSE 表描述（从前往后、每字节低位先读）
 *   BackwardBitReader  FSE sequences / Huffman（从后往前、跳过末尾 1 标记）
 * ──────────────────────────────────────────────────────────────── */

class ForwardBitReader {
  constructor(buf, start = 0) {
    this.buf = buf
    this.byte = start
    this.bit = 0
    this.consumed = 0
  }

  /** 读 n 位（低位先读）但不前进。 */
  peek(n) {
    let v = 0
    let p = this.byte
    let b = this.bit
    for (let i = 0; i < n; i++) {
      if (p >= this.buf.length) break
      v += ((this.buf[p] >> b) & 1) * (2 ** i)
      b++
      if (b === 8) { b = 0; p++ }
    }
    return v
  }

  skip(n) {
    this.consumed += n
    this.bit += n
    this.byte += this.bit >> 3
    this.bit &= 7
  }

  /** 方向流读掉的整字节数（表描述按整字节收敛）。 */
  bytesUsed() {
    return Math.ceil(this.consumed / 8)
  }
}

class BackwardBitReader {
  constructor(buf) {
    if (buf.length === 0) throw fail('empty bit stream')
    const last = buf[buf.length - 1]
    if (last === 0) throw fail('last byte of the bit stream is 0 (no end marker)')
    const hb = highbit32(last)
    // 最后一个有用位：末字节最高置位（结束标记）的前一位。
    this.bitPos = (buf.length - 1) * 8 + hb - 1
    this.buf = buf
  }

  readBit() {
    if (this.bitPos < 0) return 0
    const bit = (this.buf[this.bitPos >> 3] >> (this.bitPos & 7)) & 1
    this.bitPos--
    return bit
  }

  /** 读 n 位：第一位是结果的最高位（和参考实现的 BIT_lookBits 一致）。 */
  readBits(n) {
    let v = 0
    for (let i = 0; i < n; i++) v = (v << 1) | this.readBit()
    return v
  }

  /** 读 n 位；位不够时补 0，并把 overflow 标出来。 */
  readBitsLenient(n) {
    let v = 0
    let overflow = false
    for (let i = 0; i < n; i++) {
      if (this.bitPos < 0) overflow = true
      v = (v << 1) | this.readBit()
    }
    return { value: v, overflow }
  }

  get exhausted() {
    return this.bitPos < 0
  }
}

/* ────────────────────────────────────────────────────────────────
 * FSE 解码表（RFC 8878 §4.1）
 * ──────────────────────────────────────────────────────────────── */

/**
 * 读一张 FSE 分布表并构造解码表。
 * @param {Buffer} data
 * @param {number} pos
 * @param {number} maxAccuracyLog
 * @param {number} expectedSymbols
 * @returns {{table:{accuracyLog:number, cells:Array}, bytes:number}}
 */
function readFseTable(data, pos, maxAccuracyLog, expectedSymbols) {
  const bits = new ForwardBitReader(data, pos)
  const accuracyLog = bits.peek(4) + 5
  bits.skip(4)
  if (accuracyLog > maxAccuracyLog) throw fail('FSE accuracyLog out of range: ' + accuracyLog + ' > ' + maxAccuracyLog)

  const tableSize = 1 << accuracyLog
  // 每个符号的归一化概率；没出现的符号保持 0（零重复就是跳过这些槽位）。
  const counts = new Array(expectedSymbols).fill(0)
  // 还剩多少概率点没分配。注意位宽不是固定的 accuracyLog+1：
  // 每轮按 msb(剩余+1) 重算，这和参考实现（以及 fzstd 的 rfse）一致。
  let probs = tableSize
  let sym = -1

  while (sym < expectedSymbols - 1 && probs > 0) {
    const nbits = 31 - Math.clz32(probs + 1)   // msb(probs + 1)
    const msk = (1 << (nbits + 1)) - 1
    const val = bits.peek(nbits + 1) & msk
    const msk1fb = (1 << nbits) - 1
    const msv = msk - probs - 1
    const sval = val & msk1fb
    let v
    if (sval < msv) {
      bits.skip(nbits)
      v = sval
    } else {
      bits.skip(nbits + 1)
      v = val
      if (v > msk1fb) v -= msv
    }
    sym++
    const prob = v - 1
    counts[sym] = prob
    if (prob === -1) probs -= 1
    else probs -= prob

    if (prob === 0) {
      // 零概率后面跟 2 位重复数；值为 3 表示继续再读。被跳过的是 0 槽位。
      let rep
      do {
        rep = bits.peek(2)
        bits.skip(2)
        sym += rep
      } while (rep === 3)
    }
  }
  if (probs !== 0) throw fail('FSE distribution table not fully consumed: probs=' + probs)
  if (sym >= expectedSymbols) throw fail('FSE distribution table has more symbols than the cap ' + expectedSymbols)

  return { table: buildFseTable(counts, accuracyLog), bytes: bits.bytesUsed() }
}

/** 由归一化概率构造解码表（RFC 8878 §4.1 的 spread + baseline 算法）。 */
function buildFseTable(counts, accuracyLog) {
  const tableSize = 1 << accuracyLog
  const symbols = new Int32Array(tableSize).fill(-1)
  const symbolNext = new Int32Array(counts.length)
  let highThreshold = tableSize - 1

  for (let s = 0; s < counts.length; s++) {
    if (counts[s] === -1) {
      symbols[highThreshold--] = s
      symbolNext[s] = 1
    } else {
      symbolNext[s] = counts[s]
    }
  }

  const step = (tableSize >> 1) + (tableSize >> 3) + 3
  const mask = tableSize - 1
  let position = 0
  for (let s = 0; s < counts.length; s++) {
    for (let i = 0; i < counts[s]; i++) {
      symbols[position] = s
      position = (position + step) & mask
      while (position > highThreshold) position = (position + step) & mask
    }
  }
  if (position !== 0) throw fail('FSE table spread did not return to 0')

  const cells = new Array(tableSize)
  for (let u = 0; u < tableSize; u++) {
    const symbol = symbols[u]
    if (symbol < 0) throw fail('FSE table has holes')
    const nextState = symbolNext[symbol]++
    const nbBits = accuracyLog - highbit32(nextState)
    cells[u] = { symbol, nbBits, newState: (nextState << nbBits) - tableSize }
  }
  return { accuracyLog, cells }
}

function rleTable(symbol) {
  return { accuracyLog: 0, cells: [{ symbol, nbBits: 0, newState: 0 }] }
}

/* 预定义分布（RFC 8878 §3.1.1.3.2.2） */
const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1]
const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1]
const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]

const PREDEFINED = {
  ll: buildFseTable(LL_DEFAULT, 6),
  of: buildFseTable(OF_DEFAULT, 5),
  ml: buildFseTable(ML_DEFAULT, 6)
}

/* 长度码 -> 基线 / 附加位（RFC 8878 表 16、17） */
const LL_BASE = new Array(36)
const LL_BITS = new Array(36)
for (let i = 0; i < 16; i++) { LL_BASE[i] = i; LL_BITS[i] = 0 }
const LL_REST = [[16,1],[18,1],[20,1],[22,1],[24,2],[28,2],[32,3],[40,3],[48,4],[64,6],[128,7],[256,8],[512,9],[1024,10],[2048,11],[4096,12],[8192,13],[16384,14],[32768,15],[65536,16]]
for (let i = 0; i < LL_REST.length; i++) { LL_BASE[16 + i] = LL_REST[i][0]; LL_BITS[16 + i] = LL_REST[i][1] }

const ML_BASE = new Array(53)
const ML_BITS = new Array(53)
for (let i = 0; i < 32; i++) { ML_BASE[i] = i + 3; ML_BITS[i] = 0 }
const ML_REST = [[35,1],[37,1],[39,1],[41,1],[43,2],[47,2],[51,3],[59,3],[67,4],[83,4],[99,5],[131,7],[259,8],[515,9],[1027,10],[2051,11],[4099,12],[8195,13],[16387,14],[32771,15],[65539,16]]
for (let i = 0; i < ML_REST.length; i++) { ML_BASE[32 + i] = ML_REST[i][0]; ML_BITS[32 + i] = ML_REST[i][1] }

/* ────────────────────────────────────────────────────────────────
 * Huffman（RFC 8878 §4.2）
 * ──────────────────────────────────────────────────────────────── */

/** 解 FSE 压缩的 weight 序列（两个交错状态，RFC 8878 §4.2.1.2）。 */
function decodeFseWeights(data) {
  const { table, bytes } = readFseTable(data, 0, 6, 256)
  const stream = data.subarray(bytes)
  if (stream.length === 0) throw fail('Huffman weight bit stream is empty')
  const bits = new BackwardBitReader(stream)
  let s1 = bits.readBits(table.accuracyLog)
  let s2 = bits.readBits(table.accuracyLog)
  const out = []
  let first = true

  const advance = (state) => {
    const cell = table.cells[state]
    if (cell === undefined) throw fail('FSE state out of range')
    const { value, overflow } = bits.readBitsLenient(cell.nbBits)
    return { state: cell.newState + value, overflow }
  }

  for (;;) {
    if (out.length > 255) throw fail('too many Huffman weights')
    if (first) {
      out.push(table.cells[s1].symbol)
      const r = advance(s1)
      s1 = r.state
      if (r.overflow) { out.push(table.cells[s2].symbol); break }
    } else {
      out.push(table.cells[s2].symbol)
      const r = advance(s2)
      s2 = r.state
      if (r.overflow) { out.push(table.cells[s1].symbol); break }
    }
    first = !first
  }
  return out
}

/** 读 Huffman 树描述，返回 { tree, bytes }。 */
function readHuffmanTree(data, pos) {
  const header = data[pos]
  if (header === undefined) throw fail('Huffman tree description truncated')
  let weights = []
  let bytes
  if (header >= 128) {
    const n = header - 127
    bytes = 1 + Math.ceil(n / 2)
    const start = pos + 1
    for (let i = 0; i < n; i++) {
      const b = data[start + (i >> 1)]
      if (b === undefined) throw fail('Huffman weight truncated')
      weights.push(i % 2 === 0 ? (b >> 4) : (b & 0x0f))
    }
  } else {
    if (header === 0) throw fail('Huffman tree description length is 0')
    bytes = 1 + header
    const segment = data.subarray(pos + 1, pos + 1 + header)
    if (segment.length !== header) throw fail('Huffman tree description truncated')
    weights = decodeFseWeights(segment)
  }

  let sum = 0
  for (const w of weights) {
    if (w > 0) sum += 2 ** (w - 1)
  }
  if (sum === 0) throw fail('all Huffman weights are 0')
  const maxBits = Math.floor(Math.log2(sum)) + 1
  // 最后一个 weight 的“贡献”是 2^(w-1) = tableSize - sum；所以先要求它是 2 的幂，
  // 再取 w = log2(rem) + 1（RFC 例子里 rem=1，看起来像直接相减，其实不是）。
  const rem = 2 ** maxBits - sum
  if (rem <= 0 || (rem & (rem - 1)) !== 0) throw fail('Huffman last remaining sum is not a power of two: ' + rem)
  const lastWeight = Math.log2(rem) + 1
  if (lastWeight > maxBits) throw fail('invalid last Huffman weight: ' + lastWeight)
  weights.push(lastWeight)

  const lengths = weights.map((w) => (w === 0 ? 0 : maxBits + 1 - w))
  const codes = new Array(maxBits + 1)
  for (let i = 0; i <= maxBits; i++) codes[i] = new Map()
  let nextCode = 0
  for (let len = maxBits; len >= 1; len--) {
    for (let sym = 0; sym < lengths.length; sym++) {
      if (lengths[sym] !== len) continue
      codes[len].set(nextCode, sym)
      nextCode++
    }
    nextCode >>= 1
  }
  return { tree: { maxBits, codes, lengths }, bytes }
}

/** 解一条 Huffman 位流，正好出 count 个字节。 */
function decodeHuffmanStream(data, count, tree) {
  const bits = new BackwardBitReader(data)
  const out = Buffer.allocUnsafe(count)
  for (let i = 0; i < count; i++) {
    let code = 0
    let sym = -1
    for (let len = 1; len <= tree.maxBits; len++) {
      code = (code << 1) | bits.readBit()
      const hit = tree.codes[len].get(code)
      if (hit !== undefined) { sym = hit; break }
    }
    if (sym < 0) throw fail('Huffman code cannot be matched')
    out[i] = sym
  }
  return out
}

/* ────────────────────────────────────────────────────────────────
 * Literals / Sequences
 * ──────────────────────────────────────────────────────────────── */

/** 读 literals section，返回 { literals, end }。 */
function readLiterals(block, p, ctx) {
  const b0 = block[p]
  if (b0 === undefined) throw fail('literals header truncated')
  const type = b0 & 3
  const sf = (b0 >> 2) & 3

  if (type === 0 || type === 1) {
    let regen
    let headerSize
    if (sf === 0 || sf === 2) {
      regen = b0 >> 3
      headerSize = 1
    } else if (sf === 1) {
      regen = (b0 >> 4) + ((block[p + 1] ?? 0) << 4)
      headerSize = 2
    } else {
      regen = (b0 >> 4) + ((block[p + 1] ?? 0) << 4) + ((block[p + 2] ?? 0) << 12)
      headerSize = 3
    }
    const content = type === 1 ? 1 : regen
    if (type === 1) {
      return { literals: Buffer.alloc(regen, block[p + headerSize] ?? 0), end: p + headerSize + 1 }
    }
    const start = p + headerSize
    if (start + regen > block.length) throw fail('raw literals out of range')
    return { literals: block.subarray(start, start + regen), end: start + regen }
  }

  // Compressed / Treeless: 3/4/5 字节头
  const bitsPerField = [10, 10, 14, 18][sf]
  const headerSize = [3, 3, 4, 5][sf]
  let value = 0
  let mul = 1
  for (let i = 0; i < headerSize; i++) { value += (block[p + i] ?? 0) * mul; mul *= 256 }
  const regen = Math.floor(value / 16) % (2 ** bitsPerField)
  const compSize = Math.floor(value / (16 * 2 ** bitsPerField)) % (2 ** bitsPerField)

  let tree = ctx.huffman
  let treeBytes = 0
  if (type === 2) {
    const parsed = readHuffmanTree(block, p + headerSize)
    tree = parsed.tree
    treeBytes = parsed.bytes
    ctx.huffman = tree
  } else if (!tree) {
    throw fail('treeless literals but no previous Huffman tree')
  }

  const streamsStart = p + headerSize + treeBytes
  const totalStreams = compSize - treeBytes
  if (totalStreams < 0) throw fail('invalid Huffman stream length')

  if (sf === 0) {
    const data = block.subarray(streamsStart, streamsStart + totalStreams)
    const literals = decodeHuffmanStream(data, regen, tree)
    return { literals, end: streamsStart + totalStreams }
  }

  // 4 个流：前 3 个长度在 jump table 里
  if (totalStreams < 6) throw fail('jump table truncated')
  const jump = streamsStart
  const s1 = block.readUInt16LE(jump)
  const s2 = block.readUInt16LE(jump + 2)
  const s3 = block.readUInt16LE(jump + 4)
  const s4 = totalStreams - 6 - s1 - s2 - s3
  if (s4 < 0) throw fail('invalid Huffman stream length (jump table)')
  const sizes = [s1, s2, s3, s4]
  const segment = Math.ceil(regen / 4)
  const regenSizes = [segment, segment, segment, regen - 3 * segment]
  if (regenSizes[3] < 0) throw fail('4-stream literals too small')
  const literals = Buffer.allocUnsafe(regen)
  let cursor = jump + 6
  let outPos = 0
  for (let i = 0; i < 4; i++) {
    const data = block.subarray(cursor, cursor + sizes[i])
    if (data.length !== sizes[i]) throw fail('Huffman stream truncated')
    const part = decodeHuffmanStream(data, regenSizes[i], tree)
    part.copy(literals, outPos)
    outPos += part.length
    cursor += sizes[i]
  }
  return { literals, end: streamsStart + totalStreams }
}

/** 从位流里取一个 FSE 状态（初始状态）。 */
function initState(bits, table) {
  return bits.readBits(table.accuracyLog)
}

/** 更新一个状态，返回 { state, overflow }。 */
function stepState(bits, table, state) {
  const cell = table.cells[state]
  if (cell === undefined) throw fail('FSE state out of range')
  const { value, overflow } = bits.readBitsLenient(cell.nbBits)
  return { state: cell.newState + value, overflow }
}

/** 解 sequences 段并把结果写进输出缓冲区。 */
function decodeSequences(block, seqStart, literals, ctx, out) {
  let p = seqStart
  if (p >= block.length) throw fail('missing sequences header')
  const b0 = block[p++]
  let count
  if (b0 === 0) {
    // 没有 sequence：余下 literals 全部输出。
    out.pushBuffer(literals)
    return
  } else if (b0 < 128) {
    count = b0
  } else if (b0 < 255) {
    count = ((b0 - 128) << 8) + (block[p++] ?? 0)
  } else {
    count = (block[p] ?? 0) + ((block[p + 1] ?? 0) << 8) + 0x7f00
    p += 2
  }

  const modes = block[p++]
  if (modes === undefined) throw fail('missing symbol compression modes')
  if ((modes & 3) !== 0) throw fail('symbol compression modes reserved bits are not 0')
  const modeLL = (modes >> 6) & 3
  const modeOF = (modes >> 4) & 3
  const modeML = (modes >> 2) & 3

  const readTable = (mode, key, maxLog, symbols) => {
    if (mode === 3) {
      if (!ctx[key]) throw fail('repeat mode has no previous ' + key + ' table')
      return ctx[key]
    }
    if (mode === 0) return PREDEFINED[key]
    if (mode === 1) {
      const symbol = block[p++]
      if (symbol === undefined) throw fail('RLE table is missing a symbol')
      return rleTable(symbol)
    }
    const parsed = readFseTable(block, p, maxLog, symbols)
    p += parsed.bytes
    return parsed.table
  }

  const tableLL = readTable(modeLL, 'll', 9, 36)
  const tableOF = readTable(modeOF, 'of', 8, 32)
  const tableML = readTable(modeML, 'ml', 9, 53)
  ctx.ll = tableLL
  ctx.of = tableOF
  ctx.ml = tableML

  const bits = new BackwardBitReader(block.subarray(p))
  let stateLL = initState(bits, tableLL)
  let stateOF = initState(bits, tableOF)
  let stateML = initState(bits, tableML)

  let litPos = 0
  const rep = ctx.repeatOffsets

  for (let i = 0; i < count; i++) {
    const cellOF = tableOF.cells[stateOF]
    const offsetCode = cellOF.symbol
    if (offsetCode > 31) throw fail('offset code out of range')
    const offsetValue = 2 ** offsetCode + bits.readBits(offsetCode)

    const cellML = tableML.cells[stateML]
    const mlCode = cellML.symbol
    const matchLength = ML_BASE[mlCode] + bits.readBits(ML_BITS[mlCode])

    const cellLL = tableLL.cells[stateLL]
    const llCode = cellLL.symbol
    const literalLength = LL_BASE[llCode] + bits.readBits(LL_BITS[llCode])

    if (litPos + literalLength > literals.length) throw fail('literal length out of range')
    out.pushBuffer(literals.subarray(litPos, litPos + literalLength))
    litPos += literalLength

    // repeat offset（RFC 8878 §3.1.1.5）
    let offset
    if (offsetValue > 3) {
      offset = offsetValue - 3
      rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset
    } else {
      let idx = offsetValue - 1
      if (literalLength === 0) idx += 1
      if (idx === 3) {
        offset = rep[0] - 1
        rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = offset
      } else {
        offset = rep[idx]
        for (let k = idx; k > 0; k--) rep[k] = rep[k - 1]
        rep[0] = offset
      }
    }
    if (!Number.isInteger(offset) || offset <= 0 || offset > out.pos) throw fail('match offset out of range: ' + offset)
    for (let k = 0; k < matchLength; k++) {
      out.ensure(1)
      out.buf[out.pos] = out.buf[out.pos - offset]
      out.pos++
    }

    if (i + 1 < count) {
      const sLL = stepState(bits, tableLL, stateLL); stateLL = sLL.state
      if (sLL.overflow) throw fail('sequences bit stream ran out early')
      const sML = stepState(bits, tableML, stateML); stateML = sML.state
      if (sML.overflow) throw fail('sequences bit stream ran out early')
      const sOF = stepState(bits, tableOF, stateOF); stateOF = sOF.state
      if (sOF.overflow) throw fail('sequences bit stream ran out early')
    }
  }

  if (litPos < literals.length) out.pushBuffer(literals.subarray(litPos))
}

/* ────────────────────────────────────────────────────────────────
 * 输出缓冲区 / 帧 / 多帧
 * ──────────────────────────────────────────────────────────────── */

class OutputBuffer {
  constructor(hint) {
    const initial = Math.max(1024, Math.min(hint > 0 ? hint : 131072, 256 * 1024 * 1024))
    this.buf = Buffer.allocUnsafe(initial)
    this.pos = 0
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return
    let cap = this.buf.length
    while (cap < this.pos + n) cap *= 2
    const next = Buffer.allocUnsafe(cap)
    this.buf.copy(next, 0, 0, this.pos)
    this.buf = next
  }

  pushBuffer(b) {
    this.ensure(b.length)
    b.copy(this.buf, this.pos)
    this.pos += b.length
  }

  pushByte(byte, n) {
    this.ensure(n)
    this.buf.fill(byte, this.pos, this.pos + n)
    this.pos += n
  }

  result() {
    return this.buf.subarray(0, this.pos)
  }
}

/** 解一帧，返回 { output, length }。 */
function decodeFrame(buf, start) {
  let p = start + 4
  if (p >= buf.length) throw fail('frame header truncated')
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const single = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const dictFlag = fhd & 3
  if (((fhd >> 3) & 1) === 1) throw fail('reserved bits are not 0')

  let windowSize = 0
  if (!single) {
    const wd = buf[p++]
    if (wd === undefined) throw fail('window descriptor truncated')
    const exp = wd >> 3
    const mant = wd & 7
    windowSize = 2 ** (10 + exp) + (2 ** (10 + exp) / 8) * mant
  }

  const dictSize = [0, 1, 2, 4][dictFlag]
  let dictId = 0
  for (let i = 0; i < dictSize; i++) dictId += (buf[p + i] ?? 0) * (256 ** i)
  p += dictSize
  if (dictId !== 0) throw fail('frames with a dictionary are not supported (dictID=' + dictId + ')', 'zstd-unsupported')

  let fcsSize = [0, 2, 4, 8][fcsFlag]
  if (fcsFlag === 0 && single) fcsSize = 1
  let contentSize = 0
  if (fcsSize === 1) contentSize = buf[p]
  else if (fcsSize === 2) contentSize = buf.readUInt16LE(p) + 256
  else if (fcsSize === 4) contentSize = buf.readUInt32LE(p)
  else if (fcsSize === 8) contentSize = Number(buf.readBigUInt64LE(p))
  p += fcsSize
  if (!single && contentSize > 0) windowSize = Math.max(windowSize, contentSize)
  void windowSize

  const out = new OutputBuffer(contentSize || 131072)
  const ctx = {
    repeatOffsets: [1, 4, 8],
    huffman: null,
    ll: null,
    of: null,
    ml: null
  }

  let last = false
  while (!last) {
    if (p + 3 > buf.length) throw fail('block header truncated')
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    last = (h & 1) === 1
    const type = (h >> 1) & 3
    const size = h >>> 3

    if (type === 0) {
      if (p + size > buf.length) throw fail('raw block truncated')
      out.pushBuffer(buf.subarray(p, p + size))
      p += size
    } else if (type === 1) {
      if (p >= buf.length) throw fail('RLE block truncated')
      out.pushByte(buf[p++], size)
    } else if (type === 2) {
      if (p + size > buf.length) throw fail('compressed block truncated')
      const block = buf.subarray(p, p + size)
      const lit = readLiterals(block, 0, ctx)
      decodeSequences(block, lit.end, lit.literals, ctx, out)
      p += size
    } else {
      throw fail('reserved block type')
    }
  }

  if (checksum) p += 4
  return { output: out.result(), length: p - start }
}

/**
 * 解一个缓冲区里的所有帧。
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function decodeFrames(buf) {
  const chunks = []
  let off = 0
  while (off < buf.length) {
    if (off + 4 > buf.length) throw fail('trailing bytes shorter than one frame header')
    if (buf.readUInt32LE(off) !== MAGIC) throw fail('bad magic number @' + off)
    const { output, length } = decodeFrame(buf, off)
    if (length <= 0) throw fail('invalid frame length')
    chunks.push(output)
    off += length
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks)
}

/** 这台机器上内置解码器能不能用（永远能：纯 JS）。 */
export function builtinAvailable() {
  return true
}
