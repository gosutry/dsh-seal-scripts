/**
 * 极简 zip 读写（0.4.3）：「自创工具」页的「导入 / 导出」用它。
 *
 * 写：只用 store（压缩方法 0，压缩率 0）。导出的包要能被任何解压工具直接打开，
 *     而 toolScript 本身就是小文本，压不压差不了多少——不引第三方依赖，也不冒
 *     deflate 实现不一致的风险。
 * 读：store(0) 与 deflate(8) 都认，别人的 zip 也能导进来；别的压缩方法明确报错。
 *
 * 只依赖 node 内置模块（node:zlib）。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import { inflateRawSync, createInflateRaw } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

/** 通用标志位 bit 11：文件名是 UTF-8。写包时一直置上。 */
const FLAG_UTF8 = 0x0800

/*
 * 0.4.11：包内单文件 64 MB / 合计 128 MB 两个死数删掉。
 * 解压炸弹仍然要防，但改成「按磁盘余量判」而不是拍一个数：解压前先用中央目录算出
 * 解压后总字节（zipUncompressedTotal），留出余量，超过就拒绝（见 importToolSequence）。
 * 这样正常的大包不会被挡在门外，真炸弹照样装不下。
 */

/** 解压时至少要给磁盘留这么多余量，判「装不装得下」用。 */
export const DISK_RESERVE_BYTES = 16 * 1024 * 1024

let CRC_TABLE = null

/** CRC32 查表（zip 头必须填）。 */
function crcTable() {
  if (CRC_TABLE !== null) return CRC_TABLE
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c
  }
  CRC_TABLE = table
  return table
}

/**
 * @param {Buffer|Uint8Array} buf
 * @returns {number} 无符号 32 位 CRC
 */
export function crc32(buf) {
  const table = crcTable()
  let c = -1
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** Date → DOS 时间/日期（zip 固定格式）。 */
function dosDateTime(date) {
  const d = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date()
  const year = Math.max(1980, d.getFullYear())
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F)
  const day = (((year - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F)
  return { time: time & 0xFFFF, date: day & 0xFFFF }
}

/**
 * 打一个 zip 包（全部 store，压缩率 0），**在内存里拼整包**。
 *
 * 0.4.11 起导出走 writeZipFile（流式写盘），这个函数只留给「小包、顺手要一个 Buffer」
 * 的调用方；两者字节格式一致，可以互换。
 *
 * @param {Array<{name:string, data?:Buffer|string, mtime?:Date}>} entries 用 / 分隔；目录条目以 / 结尾
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = String(entry.name).split('\\').join('/')
    if (name === '') throw new Error('zip 条目名不能为空')
    const isDir = name.endsWith('/')
    const body = isDir
      ? Buffer.alloc(0)
      : (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data === undefined ? '' : entry.data), 'utf8'))
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(body)
    const stamp = dosDateTime(entry.mtime)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(FLAG_UTF8, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(body.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(FLAG_UTF8, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(body.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(isDir ? 0x10 : 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

/** 从后往前找 EOCD（注释最长 65535 字节）。 */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xFFFF)
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i
  }
  return -1
}

/**
 * 解开一个 zip。
 *
 * @param {Buffer} buf
 * @returns {Array<{name:string, isDir:boolean, data:Buffer, method:number, crc:number}>}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  if (buf.length < 22) throw new Error('不是 zip：文件太短')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是 zip：找不到中央目录（可能只是改了扩展名的普通文件）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {
    throw new Error('不支持 zip64 包；重新导出一个普通 zip 再试')
  }
  if (cdOffset + cdSize > buf.length) throw new Error('zip 损坏：中央目录越界')

  const out = []
  let total = 0
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error('zip 损坏：中央目录第 ' + (n + 1) + ' 项读不出来')
    }
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8').split('\\').join('/')
    p += 46 + nameLen + extraLen + commentLen

    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) throw new Error('不支持 zip64 包：' + name)
    if ((flags & 0x01) === 0x01) throw new Error('不支持加密的 zip：' + name)

    const isDir = name.endsWith('/')
    if (isDir) { out.push({ name, isDir: true, data: Buffer.alloc(0), method, crc }); continue }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error('zip 损坏：找不到 ' + name + ' 的本地头')
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    if (dataStart + compSize > buf.length) throw new Error('zip 损坏：' + name + ' 的数据越界')
    const raw = buf.subarray(dataStart, dataStart + compSize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error('不支持的压缩方法 ' + method + '（' + name + '）；只认 store / deflate')

    total += data.length
    if (data.length !== uncompSize) throw new Error('zip 损坏：' + name + ' 解出来的长度对不上')
    out.push({ name, isDir: false, data, method, crc })
  }
  return out
}

/**
 * 把包内条目名收成干净相对路径：不许绝对路径、不许 ..、不许盘符。
 * 越界直接抛——导入是把别人的文件写进本机工具目录，这一步不能只做「尽量」。
 *
 * @param {string} raw
 * @returns {string} 规整后的相对路径（用 / 分隔，不含结尾 /）
 */
export function safeEntryName(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).split('\\').join('/').replace(/\/+$/, '')
  if (text === '') throw new Error('包里有空文件名的条目')
  if (text.startsWith('/')) throw new Error('包里有绝对路径：' + raw)
  if (/^[A-Za-z]:/.test(text)) throw new Error('包里有盘符路径：' + raw)
  const parts = text.split('/')
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') throw new Error('包里有越界路径：' + raw)
  }
  return parts.join('/')
}

/* ───────────────── 0.4.11：流式写包 + 按磁盘余量判解压 ───────────────── */

/**
 * 增量 CRC32（流式写盘用）：state 从 -1 起，最后 (state ^ -1) >>> 0。
 * @param {number} state
 * @param {Buffer|Uint8Array} buf
 * @returns {number}
 */
export function crc32Update(state, buf) {
  const table = crcTable()
  let c = state
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return c
}

/**
 * 打一个 zip **直接写进磁盘**，不把整包拼在内存里（0.4.11 的导出走这条路）。
 *
 * store（压缩率 0）：条目的 crc 先占位写进本地头，正文边读边写边算，
 * 写完再用 pwrite 把 crc 补回本地头 offset+14。这样源文件只读一遍。
 *
 * @param {string} file 目标文件（会被覆盖）
 * @param {Array<{name:string, source?:string, data?:Buffer|string, mtime?:Date}>} entries
 *        source 给绝对路径（流式拷贝），或 data 给内容
 * @returns {Promise<{file:string, bytes:number, entries:number}>}
 */
export async function writeZipFile(file, entries) {
  const handle = await fsp.open(file, 'w')
  const centrals = []
  let offset = 0
  try {
    for (const entry of entries) {
      const name = String(entry.name).split('\\').join('/')
      if (name === '') throw new Error('zip 条目名不能为空')
      const isDir = name.endsWith('/')
      const nameBuf = Buffer.from(name, 'utf8')
      const stamp = dosDateTime(entry.mtime)
      let size = 0
      let body = null
      if (!isDir) {
        if (typeof entry.source === 'string' && entry.source !== '') {
          size = (await fsp.stat(entry.source)).size
        } else {
          body = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data === undefined ? '' : entry.data), 'utf8')
          size = body.length
        }
      }

      const local = Buffer.alloc(30)
      local.writeUInt32LE(SIG_LOCAL, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(FLAG_UTF8, 6)
      local.writeUInt16LE(0, 8)
      local.writeUInt16LE(stamp.time, 10)
      local.writeUInt16LE(stamp.date, 12)
      local.writeUInt32LE(0, 14)          // crc 占位，写完正文补
      local.writeUInt32LE(size, 18)
      local.writeUInt32LE(size, 22)
      local.writeUInt16LE(nameBuf.length, 26)
      local.writeUInt16LE(0, 28)
      const headerOffset = offset
      await handle.write(Buffer.concat([local, nameBuf]))
      offset += local.length + nameBuf.length

      let crc = 0
      if (!isDir) {
        let state = -1
        if (body !== null) {
          await handle.write(body)
          offset += body.length
          crc = crc32(body)
        } else {
          const stream = fs.createReadStream(entry.source, { highWaterMark: 1 << 20 })
          for await (const chunk of stream) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            await handle.write(buf)
            offset += buf.length
            state = crc32Update(state, buf)
          }
          crc = (state ^ -1) >>> 0
        }
        const crcBuf = Buffer.alloc(4)
        crcBuf.writeUInt32LE(crc, 0)
        await handle.write(crcBuf, 0, 4, headerOffset + 14)
      }

      const central = Buffer.alloc(46)
      central.writeUInt32LE(SIG_CENTRAL, 0)
      central.writeUInt16LE(20, 4)
      central.writeUInt16LE(20, 6)
      central.writeUInt16LE(FLAG_UTF8, 8)
      central.writeUInt16LE(0, 10)
      central.writeUInt16LE(stamp.time, 12)
      central.writeUInt16LE(stamp.date, 14)
      central.writeUInt32LE(crc, 16)
      central.writeUInt32LE(size, 20)
      central.writeUInt32LE(size, 24)
      central.writeUInt16LE(nameBuf.length, 28)
      central.writeUInt16LE(0, 30)
      central.writeUInt16LE(0, 32)
      central.writeUInt16LE(0, 34)
      central.writeUInt16LE(0, 36)
      central.writeUInt32LE(isDir ? 0x10 : 0, 38)
      central.writeUInt32LE(headerOffset, 42)
      centrals.push(central, nameBuf)
    }

    const centralBuf = Buffer.concat(centrals)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(SIG_EOCD, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(centralBuf.length, 12)
    eocd.writeUInt32LE(offset, 16)
    eocd.writeUInt16LE(0, 20)
    await handle.write(centralBuf)
    await handle.write(eocd)
    offset += centralBuf.length + eocd.length
  } finally {
    await handle.close().catch(() => {})
  }
  return { file, bytes: offset, entries: entries.length }
}

/**
 * 只读中央目录，算出「解压后一共多大」——不解、不占内存。
 * 解压炸弹的判断就靠它 + 磁盘余量。
 * @param {Buffer} buf
 * @returns {{bytes:number, files:number}}
 */
export function zipUncompressedTotal(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  if (buf.length < 22) throw new Error('不是 zip：文件太短')
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error('不是 zip：找不到中央目录（可能只是改了扩展名的普通文件）')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {
    throw new Error('不支持 zip64 包；重新导出一个普通 zip 再试')
  }
  if (cdOffset + cdSize > buf.length) throw new Error('zip 损坏：中央目录越界')
  let bytes = 0
  let files = 0
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error('zip 损坏：中央目录第 ' + (n + 1) + ' 项读不出来')
    }
    const uncompSize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (uncompSize === 0xFFFFFFFF) throw new Error('不支持 zip64 包：' + name)
    if (name.endsWith('/')) continue
    bytes += uncompSize
    files++
  }
  return { bytes, files }
}

/**
 * 目录所在磁盘的可用字节数；拿不到给 null（调用方据此跳过这一道检查）。
 * @param {string} dir
 * @returns {Promise<number|null>}
 */
export async function freeBytesOf(dir) {
  try {
    const st = await fsp.statfs(dir)
    return Number(st.bavail) * Number(st.bsize)
  } catch {
    return null
  }
}

/**
 * 从磁盘上的 zip 文件里读中央目录（只读表，不解压任何条目）。
 * 0.4.11 的导入走这条路：包有多大都不用整个读进内存。
 * @param {string} file
 * @returns {Promise<Array<{name:string,isDir:boolean,method:number,crc:number,compSize:number,uncompSize:number,localOffset:number}>>}
 */
export async function readZipCentralFromFile(file) {
  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    if (size < 22) throw new Error('不是 zip：文件太短')
    const tailLen = Math.min(size, 22 + 0xFFFF)
    const tail = Buffer.alloc(tailLen)
    await handle.read(tail, 0, tailLen, size - tailLen)
    const eocd = findEocd(tail)
    if (eocd < 0) throw new Error('不是 zip：找不到中央目录（可能只是改了扩展名的普通文件）')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF || count === 0xFFFF) {
      throw new Error('不支持 zip64 包；重新导出一个普通 zip 再试')
    }
    if (cdOffset + cdSize > size) throw new Error('zip 损坏：中央目录越界')
    const cd = Buffer.alloc(cdSize)
    await handle.read(cd, 0, cdSize, cdOffset)
    const entries = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) {
        throw new Error('zip 损坏：中央目录第 ' + (n + 1) + ' 项读不出来')
      }
      const flags = cd.readUInt16LE(p + 8)
      const method = cd.readUInt16LE(p + 10)
      const crc = cd.readUInt32LE(p + 16)
      const compSize = cd.readUInt32LE(p + 20)
      const uncompSize = cd.readUInt32LE(p + 24)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const localOffset = cd.readUInt32LE(p + 42)
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8').split('\\').join('/')
      p += 46 + nameLen + extraLen + commentLen
      if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF) throw new Error('不支持 zip64 包：' + name)
      if ((flags & 0x01) === 0x01) throw new Error('不支持加密的 zip：' + name)
      entries.push({ name, isDir: name.endsWith('/'), method, crc, compSize, uncompSize, localOffset })
    }
    return entries
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * 逐条取出包里的文件内容（流式：一条读完再下一条，内存里只有一块）。
 *
 * visit 收到 { name, isDir, method, uncompSize, read }，read 是 async iterator（给 Buffer 块）。
 * 目录条目 content 为空；读取条目的完整性（长度 + crc）在流结束时校验，不一致直接抛。
 *
 * @param {string} file
 * @param {(entry:{name:string,isDir:boolean,method:number,uncompSize:number,read:()=>AsyncIterable<Buffer>}) => Promise<void>} visit
 */
export async function forEachZipEntry(file, visit) {
  const entries = await readZipCentralFromFile(file)
  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    for (const e of entries) {
      if (e.isDir) {
        await visit({ name: e.name, isDir: true, method: e.method, uncompSize: 0, read: null })
        continue
      }
      const head = Buffer.alloc(30)
      await handle.read(head, 0, 30, e.localOffset)
      if (head.readUInt32LE(0) !== SIG_LOCAL) throw new Error('zip 损坏：找不到 ' + e.name + ' 的本地头')
      const lNameLen = head.readUInt16LE(26)
      const lExtraLen = head.readUInt16LE(28)
      const dataStart = e.localOffset + 30 + lNameLen + lExtraLen
      const dataEnd = dataStart + e.compSize
      if (dataEnd > size) throw new Error('zip 损坏：' + e.name + ' 的数据越界')

      const rawChunks = async function* () {
        let pos = dataStart
        while (pos < dataEnd) {
          const want = Math.min(1 << 20, dataEnd - pos)
          const buf = Buffer.allocUnsafe(want)
          const { bytesRead } = await handle.read(buf, 0, want, pos)
          if (bytesRead <= 0) break
          pos += bytesRead
          yield buf.subarray(0, bytesRead)
        }
      }

      const read = async function* () {
        let state = -1
        let total = 0
        if (e.method === 0) {
          for await (const chunk of rawChunks()) {
            state = crc32Update(state, chunk)
            total += chunk.length
            yield chunk
          }
        } else if (e.method === 8) {
          const inflater = createInflateRaw()
          const src = Readable.from(rawChunks())
          src.pipe(inflater)
          try {
            for await (const chunk of inflater) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              state = crc32Update(state, buf)
              total += buf.length
              yield buf
            }
          } finally {
            src.destroy()
            inflater.destroy()
          }
        } else {
          throw new Error('不支持的压缩方法 ' + e.method + '（' + e.name + '）；只认 store / deflate')
        }
        if (total !== e.uncompSize) {
          throw new Error('zip 损坏：' + e.name + ' 解出来的长度对不上（' + total + ' != ' + e.uncompSize + '）')
        }
        if (((state ^ -1) >>> 0) !== e.crc) throw new Error('zip 损坏：' + e.name + ' 的 crc 对不上')
      }

      await visit({ name: e.name, isDir: false, method: e.method, uncompSize: e.uncompSize, read: () => read() })
    }
  } finally {
    await handle.close().catch(() => {})
  }
}
