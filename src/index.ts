/**
 * @dsh-external/dsh-local-workspace — 本地文件夹工作区桥（host 半）。
 *
 * 把「用户自己电脑上的文件夹」变成服务器上的工作区：
 * - 浏览器端选择文件夹 → 逐文件上传到本插件管理的目录（$DSH_HOME/local-workspaces/<name>）；
 * - 客户端随后用内置 workspaces 服务把该目录注册为工作区并开新会话（会话 cwd = 该目录，
 *   fs 沙箱的 workspace 根随之指向它，代理即可在该目录里读写）；
 * - 提供 zip 打包下载、删除、状态查询。
 *
 * 路径安全：所有目录参数必须位于 baseDir 之内（realpath 遏制，防止 symlink 逃逸）；
 * 相对路径拒绝绝对路径与 `..` 段；上传/打包均设大小与条目上限（Config）。
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import type { Context } from 'cordis'
import z from 'schemastery'

/** webServer 服务的结构化视图（完整契约见 @deepseek-ai/dsh-host-webserver）。 */
interface WebServerService {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

type AppContext = Context & { webServer: WebServerService }

export const name = '@dsh-external/dsh-local-workspace'
export const inject = ['webServer']

/** 插件配置。baseDir 留空时回落到 $DSH_HOME/local-workspaces（部署常见路径）。 */
export interface Config {
  /** 上传工作区的根目录（绝对路径；留空 = $DSH_HOME/local-workspaces）。 */
  baseDir: string
  /** 单个上传文件上限（字节）。 */
  maxFileBytes: number
  /** 单个工作区目录总大小上限（字节）。 */
  maxTotalBytes: number
  /** 单个工作区目录条目（文件数）上限。 */
  maxFiles: number
}

export const Config = z.object({
  baseDir: z.string().default(''),
  maxFileBytes: z.number().min(1024 * 1024).default(256 * 1024 * 1024),
  maxTotalBytes: z.number().min(1024 * 1024).default(1024 * 1024 * 1024),
  maxFiles: z.natural().min(1).default(20000),
})

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 工作区名：拒绝空名、`.`/`..`、`..` 开头、路径分隔符与控制字符。 */
function sanitizeName(raw: string): string {
  const cleaned = raw.trim()
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('..')) {
    throw new Error(`非法工作区名: "${raw}"`)
  }
  if (/[/\\]/.test(cleaned)) throw new Error(`非法工作区名（不允许路径分隔符）: "${raw}"`)
  if (/[\u0000-\u001f]/.test(cleaned)) throw new Error(`非法工作区名（不允许控制字符）: "${raw}"`)
  return cleaned
}

/** 相对路径：拒绝绝对路径与 `..` 段，规范化空段。 */
function safeRel(raw: string): string {
  if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`非法相对路径（不允许绝对路径）: "${raw}"`)
  }
  const segments = raw.split(/[/\\]/).filter(segment => segment !== '' && segment !== '.')
  if (segments.includes('..')) throw new Error(`非法相对路径（不允许 .. 段）: "${raw}"`)
  const joined = segments.join('/')
  if (!joined || joined.length > 2048) throw new Error(`非法相对路径: "${raw}"`)
  return joined
}

/** 目录必须存在且位于 baseReal 之内，返回其 realpath。 */
async function requireDirUnderBase(baseReal: string, raw: string): Promise<string> {
  if (!isAbsolute(raw)) throw new Error(`目录必须是绝对路径: "${raw}"`)
  const real = await realpath(raw)
  if (real !== baseReal && !real.startsWith(baseReal + sep)) {
    throw new Error(`目录不在工作区根 ${baseReal} 之内: "${real}"`)
  }
  return real
}

/** 读取请求体并限制大小（超出直接拒绝）。 */
async function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > cap) throw new Error(`请求体超过上限 ${cap} 字节`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** 解析请求 JSON 体（小体量参数）。 */
async function readJson(req: IncomingMessage, cap = 64 * 1024): Promise<Record<string, unknown>> {
  const text = (await readBody(req, cap)).toString('utf8')
  const parsed = JSON.parse(text) as unknown
  if (typeof parsed !== 'object' || parsed === null) throw new Error('请求体必须是 JSON 对象')
  return parsed as Record<string, unknown>
}

/** 会话 cwd（session header 的不可变 cwd；会话不存在时为 undefined）。 */
function sessionCwd(ctx: Context, sessionId: string): string | undefined {
  const sessions = ctx.get('sessions') as
    | { get(id: string): { header: { cwd?: string } } | undefined }
    | undefined
  return sessions?.get(sessionId)?.header.cwd
}

// ─── zip 打包（最小实现：deflate + UTF-8 名 + 中央目录） ──────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i])! & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** 打包一个文件列表为 zip Buffer（条目顺序即收集顺序，全部 deflate）。 */
async function buildZip(files: readonly ZipSourceFile[]): Promise<Buffer> {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = await readFile(file.abs)
    const name = Buffer.from(file.rel, 'utf8')
    const compressed = deflateRawSync(data)
    const crc = crc32(data)
    const { time, date } = dosDateTime(new Date(file.mtime))
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
    parts.push(local, name, compressed)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(8, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += 30 + name.length + compressed.length
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

/** 一次打包/统计的文件候选。 */
interface ZipSourceFile {
  /** 相对目录的路径（/ 分隔）。 */
  rel: string
  /** 绝对路径。 */
  abs: string
  /** 文件大小（字节）。 */
  size: number
  /** 修改时间（ms）。 */
  mtime: number
}

/** 递归收集普通文件（跳过 symlink 与非常规文件），按名称排序并受上限约束。 */
async function collectFiles(dir: string, maxFiles: number, maxTotalBytes: number): Promise<ZipSourceFile[]> {
  const out: ZipSourceFile[] = []
  let total = 0
  const walk = async (current: string, prefix: string): Promise<void> => {
    if (out.length >= maxFiles) throw new Error(`文件数超过上限 ${maxFiles}`)
    const entries = await readdir(current, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(abs, prefix ? `${prefix}/${entry.name}` : entry.name)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(abs)
      total += info.size
      if (total > maxTotalBytes) throw new Error(`总大小超过上限 ${maxTotalBytes} 字节`)
      out.push({ rel: prefix ? `${prefix}/${entry.name}` : entry.name, abs, size: info.size, mtime: info.mtimeMs })
    }
  }
  await walk(dir, '')
  return out
}

// ─── 插件主体 ─────────────────────────────────────────────────────────────────

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const baseDir = resolve(config.baseDir || join(dshHome, 'local-workspaces'))
  mkdirSync(baseDir, { recursive: true })
  const baseReal = realpathSync(baseDir)

  const API_PREFIX = '/local-workspace/api'
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname.replace(/^\/local-workspace\/api/, '') || '/'
      const send = (code: number, obj: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(obj))
      }
      try {
        if (req.method === 'GET' && pathname === '/ping') {
          return send(200, { ok: true, baseDir: baseReal })
        }
        if (req.method === 'GET' && pathname === '/status') {
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const cwd = sessionId ? sessionCwd(ctx, sessionId) : undefined
          if (cwd === undefined) return send(200, { ok: true, isLocal: false, cwd: null })
          if (cwd !== baseReal && !cwd.startsWith(baseReal + sep)) {
            return send(200, { ok: true, isLocal: false, cwd })
          }
          const files = await collectFiles(cwd, config.maxFiles, config.maxTotalBytes)
          return send(200, {
            ok: true,
            isLocal: true,
            cwd,
            name: basename(cwd),
            fileCount: files.length,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          })
        }
        if (req.method === 'POST' && pathname === '/begin') {
          const body = await readJson(req)
          const name = sanitizeName(String(body.name ?? ''))
          const dir = join(baseReal, name)
          const existed = existsSync(dir)
          await mkdir(dir, { recursive: true })
          const real = await requireDirUnderBase(baseReal, dir)
          return send(200, { ok: true, dir: real, path: real, existed })
        }
        if (req.method === 'POST' && pathname === '/file') {
          const dir = await requireDirUnderBase(baseReal, url.searchParams.get('dir') ?? '')
          const rel = safeRel(url.searchParams.get('rel') ?? '')
          const content = await readBody(req, config.maxFileBytes)
          const target = join(dir, ...rel.split('/'))
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, content)
          return send(200, { ok: true, size: content.length })
        }
        if (req.method === 'POST' && pathname === '/commit') {
          const body = await readJson(req)
          const dir = await requireDirUnderBase(baseReal, String(body.dir ?? ''))
          const files = await collectFiles(dir, config.maxFiles, config.maxTotalBytes)
          return send(200, {
            ok: true,
            path: dir,
            fileCount: files.length,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0),
          })
        }
        if (req.method === 'POST' && pathname === '/remove') {
          const body = await readJson(req)
          const dir = await requireDirUnderBase(baseReal, String(body.dir ?? ''))
          if (dir === baseReal) throw new Error('不能删除工作区根目录')
          await rm(dir, { recursive: true, force: true })
          return send(200, { ok: true, removed: dir })
        }
        if (req.method === 'GET' && pathname === '/download') {
          const dir = await requireDirUnderBase(baseReal, url.searchParams.get('dir') ?? '')
          const files = await collectFiles(dir, config.maxFiles, config.maxTotalBytes)
          const zip = await buildZip(files)
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${basename(dir)}.zip"`,
            'content-length': String(zip.length),
          })
          res.end(zip)
          return
        }
        return send(404, { ok: false, error: `not found: ${req.method} ${pathname}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (res.headersSent) {
          res.end()
          return
        }
        return send(400, { ok: false, error: message })
      }
    },
  }), 'local-workspace: api')

  ctx.logger?.info?.(`[${name}] 本地工作区根: ${baseReal}`)
}
