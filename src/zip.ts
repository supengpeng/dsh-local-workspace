/**
 * zip 打包与工作区文件收集。
 *
 * 收集时跳过上传临时目录；打包支持整包 Buffer（测试/小包）与流式写响应（大包）。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

/** 上传临时目录前缀；collectFiles 会跳过该前缀，避免统计到进行中的上传。 */
export const UPLOAD_TMP_PREFIX = '.local-workspace-upload-'

/** 一次打包/统计的文件候选。 */
export interface ZipSourceFile {
  /** 相对目录的路径（/ 分隔）。 */
  rel: string
  /** 绝对路径。 */
  abs: string
  /** 文件大小（字节）。 */
  size: number
  /** 修改时间（ms）。 */
  mtime: number
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i])! & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function buildEntryParts(
  file: ZipSourceFile,
  data: Buffer,
  compressed: Buffer,
  crc: number,
  time: number,
  date: number,
  offset: number,
): { local: Buffer; name: Buffer; compressed: Buffer; central: Buffer; size: number } {
  const name = Buffer.from(file.rel, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6) // general purpose bit 11: UTF-8 文件名
  local.writeUInt16LE(8, 8) // method: deflate
  local.writeUInt16LE(time, 10)
  local.writeUInt16LE(date, 12)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  local.writeUInt16LE(0, 28)

  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt16LE(8, 10)
  central.writeUInt16LE(time, 12)
  central.writeUInt16LE(date, 14)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt16LE(0, 30)
  central.writeUInt16LE(0, 32)
  central.writeUInt16LE(0, 34)
  central.writeUInt16LE(0, 36)
  central.writeUInt32LE(0, 38)
  central.writeUInt32LE(offset, 42)

  return { local, name, compressed, central, size: 30 + name.length + compressed.length }
}

/**
 * 递归收集普通文件（跳过 symlink、非常规文件与上传临时目录），按名称排序并受上限约束。
 *
 * 文件数上限在每次 push 前检查：目录恰好达到上限时仍可正常统计，只有继续新增文件才报错。
 */
export async function collectFiles(dir: string, maxFiles: number, maxTotalBytes: number): Promise<ZipSourceFile[]> {
  const out: ZipSourceFile[] = []
  let total = 0
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith(UPLOAD_TMP_PREFIX)) continue
      if (entry.isSymbolicLink()) continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, prefix ? `${prefix}/${entry.name}` : entry.name)
        continue
      }
      if (!entry.isFile()) continue
      if (out.length >= maxFiles) throw new Error(`文件数超过上限 ${maxFiles}`)
      const info = await stat(abs)
      total += info.size
      if (total > maxTotalBytes) throw new Error(`总大小超过上限 ${maxTotalBytes} 字节`)
      out.push({ rel: prefix ? `${prefix}/${entry.name}` : entry.name, abs, size: info.size, mtime: info.mtimeMs })
    }
  }
  await walk(dir, '')
  return out
}

/** 打包一个文件列表为 zip Buffer（条目顺序即收集顺序，全部 deflate）。 */
export async function buildZip(files: readonly ZipSourceFile[]): Promise<Buffer> {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = await readFile(file.abs)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const { time, date } = dosDateTime(new Date(file.mtime))
    const { local, name, compressed: body, central: header, size } = buildEntryParts(file, data, compressed, crc, time, date, offset)
    parts.push(local, name, body)
    central.push(header, name)
    offset += size
  }
  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, ...central, eocd])
}

function writeChunk(res: ServerResponse, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      res.off('error', onError)
      reject(error)
    }
    res.on('error', onError)
    res.write(chunk, error => {
      res.off('error', onError)
      if (error) reject(error)
      else resolve()
    })
  })
}

/** 流式把文件列表写成 zip 响应（每次只保留一个文件的压缩数据在内存）。 */
export async function writeZip(res: ServerResponse, files: readonly ZipSourceFile[]): Promise<void> {
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = await readFile(file.abs)
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const { time, date } = dosDateTime(new Date(file.mtime))
    const { local, name, compressed: body, central: header, size } = buildEntryParts(file, data, compressed, crc, time, date, offset)
    await writeChunk(res, local)
    await writeChunk(res, name)
    await writeChunk(res, body)
    central.push(header, name)
    offset += size
  }
  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  await writeChunk(res, Buffer.concat([...central, eocd]))
  res.end()
}
