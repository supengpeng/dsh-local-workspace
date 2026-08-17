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
import { createWriteStream, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import z from 'schemastery'
import { assertNoSymlinkEscape, requireDirUnderBase, safeRel, sanitizeName } from './paths.js'
import { collectFiles, UPLOAD_TMP_PREFIX, writeZip, type ZipSourceFile } from './zip.js'

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
  /** 服务器目录选择方式：native 用官方原生选择器；browse 用内置浏览；tryNativeFirst 先原生、失败回退浏览。 */
  serverDirectoryMode: 'native' | 'browse' | 'tryNativeFirst'
}

export const Config = z.object({
  baseDir: z.string().default(''),
  maxFileBytes: z.number().min(1024 * 1024).default(256 * 1024 * 1024),
  maxTotalBytes: z.number().min(1024 * 1024).default(1024 * 1024 * 1024),
  maxFiles: z.natural().min(1).default(20000),
  serverDirectoryMode: z.union([
    z.const('native'),
    z.const('browse'),
    z.const('tryNativeFirst'),
  ]).default('browse'),
})

/** 上传工作区目录的实时统计（用于上传时即时限流，避免 commit 阶段才失败）。 */
interface WorkspaceStats {
  fileCount: number
  totalBytes: number
}

class WorkspaceStore {
  private readonly stats = new Map<string, WorkspaceStats>()

  async get(dir: string, maxFiles: number, maxTotalBytes: number): Promise<WorkspaceStats> {
    const cached = this.stats.get(dir)
    if (cached) return cached
    const files = await collectFiles(dir, maxFiles, maxTotalBytes)
    const next = {
      fileCount: files.length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    }
    this.stats.set(dir, next)
    return next
  }

  set(dir: string, stats: WorkspaceStats): void {
    this.stats.set(dir, stats)
  }

  remove(dir: string): void {
    this.stats.delete(dir)
  }

  addFile(dir: string, countDelta: number, bytesDelta: number): void {
    const current = this.stats.get(dir)
    if (!current) return
    current.fileCount += countDelta
    current.totalBytes += bytesDelta
  }
}

/** 按 key 串行化临界区；用于同一工作区目录的写入/删除/提交互斥。 */
class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

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

/** 流式把请求体写入文件并计数；超过上限即中断。返回实际写入字节数。 */
async function writeRequestBodyToFile(req: IncomingMessage, filePath: string, cap: number): Promise<number> {
  let size = 0
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > cap) {
        callback(new Error(`请求体超过上限 ${cap} 字节`))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(req, counter, createWriteStream(filePath, { flags: 'wx' }))
  return size
}

/** 会话 cwd（session header 的不可变 cwd；会话不存在时为 undefined）。 */
function sessionCwd(ctx: Context, sessionId: string): string | undefined {
  const sessions = ctx.get('sessions') as
    | { get(id: string): { header: { cwd?: string } } | undefined }
    | undefined
  return sessions?.get(sessionId)?.header.cwd
}

// ─── 插件主体 ─────────────────────────────────────────────────────────────────

export function apply(ctx: AppContext, config: Config): void {
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const baseDir = resolve(config.baseDir || join(dshHome, 'local-workspaces'))
  mkdirSync(baseDir, { recursive: true })
  const baseReal = realpathSync(baseDir)
  const store = new WorkspaceStore()
  const mutex = new KeyedMutex()

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
          let files: ZipSourceFile[]
          try {
            files = await collectFiles(cwd, config.maxFiles, config.maxTotalBytes)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              return send(200, { ok: true, isLocal: false, cwd })
            }
            throw error
          }
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
          const stats = await store.get(real, config.maxFiles, config.maxTotalBytes)
          return send(200, {
            ok: true,
            dir: real,
            path: real,
            existed,
            fileCount: stats.fileCount,
            totalBytes: stats.totalBytes,
          })
        }
        if (req.method === 'POST' && pathname === '/file') {
          const dir = await requireDirUnderBase(baseReal, url.searchParams.get('dir') ?? '')
          const rel = safeRel(url.searchParams.get('rel') ?? '')
          const target = join(dir, ...rel.split('/'))
          await assertNoSymlinkEscape(dir, rel)

          const contentLengthHeader = req.headers['content-length']
          if (contentLengthHeader !== undefined) {
            const declared = Number(contentLengthHeader)
            if (Number.isFinite(declared) && declared > config.maxFileBytes) {
              throw new Error(`请求体超过上限 ${config.maxFileBytes} 字节`)
            }
          }

          const tempDir = await mkdtemp(join(baseReal, UPLOAD_TMP_PREFIX))
          const tempFile = join(tempDir, 'payload')
          try {
            const contentLength = await writeRequestBodyToFile(req, tempFile, config.maxFileBytes)
            await mutex.run(dir, async () => {
              await assertNoSymlinkEscape(dir, rel)
              let existed = false
              let oldSize = 0
              try {
                const info = await stat(target)
                existed = true
                oldSize = info.size
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              }

              const current = await store.get(dir, config.maxFiles, config.maxTotalBytes)
              const newCount = current.fileCount + (existed ? 0 : 1)
              const newBytes = current.totalBytes - oldSize + contentLength
              if (newCount > config.maxFiles) throw new Error(`文件数超过上限 ${config.maxFiles}`)
              if (newBytes > config.maxTotalBytes) throw new Error(`总大小超过上限 ${config.maxTotalBytes} 字节`)
              await mkdir(dirname(target), { recursive: true })
              await assertNoSymlinkEscape(dir, rel)
              const mtimeRaw = url.searchParams.get('mtime')
              if (mtimeRaw) {
                const mtime = Number(mtimeRaw)
                if (Number.isFinite(mtime) && mtime > 0) {
                  await utimes(tempFile, new Date(mtime), new Date(mtime))
                }
              }
              await rename(tempFile, target)
              store.addFile(dir, existed ? 0 : 1, contentLength - oldSize)
            })
            return send(200, { ok: true, size: contentLength })
          } finally {
            await rm(tempDir, { recursive: true, force: true })
          }
        }
        if (req.method === 'POST' && pathname === '/commit') {
          const body = await readJson(req)
          const dir = await requireDirUnderBase(baseReal, String(body.dir ?? ''))
          return await mutex.run(dir, async () => {
            const files = await collectFiles(dir, config.maxFiles, config.maxTotalBytes)
            store.set(dir, {
              fileCount: files.length,
              totalBytes: files.reduce((sum, file) => sum + file.size, 0),
            })
            return send(200, {
              ok: true,
              path: dir,
              fileCount: files.length,
              totalBytes: files.reduce((sum, file) => sum + file.size, 0),
            })
          })
        }
        if (req.method === 'POST' && pathname === '/remove') {
          const body = await readJson(req)
          const dir = await requireDirUnderBase(baseReal, String(body.dir ?? ''))
          if (dir === baseReal) throw new Error('不能删除工作区根目录')
          return await mutex.run(dir, async () => {
            await rm(dir, { recursive: true, force: true })
            store.remove(dir)
            return send(200, { ok: true, removed: dir })
          })
        }
        if (req.method === 'GET' && pathname === '/sync/manifest') {
          const dir = await requireDirUnderBase(baseReal, url.searchParams.get('dir') ?? '')
          const files = await collectFiles(dir, config.maxFiles, config.maxTotalBytes)
          return send(200, {
            ok: true,
            files: files.map(file => ({ rel: file.rel, size: file.size, mtime: file.mtime })),
          })
        }
        if (req.method === 'GET' && pathname === '/sync/file') {
          const dir = await requireDirUnderBase(baseReal, url.searchParams.get('dir') ?? '')
          const rel = safeRel(url.searchParams.get('rel') ?? '')
          const target = join(dir, ...rel.split('/'))
          await assertNoSymlinkEscape(dir, rel)
          const info = await stat(target)
          if (info.isDirectory()) throw new Error('不能下载目录')
          const data = await readFile(target)
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(data.length),
            'x-mtime': String(info.mtimeMs),
          })
          res.end(data)
          return
        }
        if (req.method === 'POST' && pathname === '/sync/remove-file') {
          const body = await readJson(req)
          const dir = await requireDirUnderBase(baseReal, String(body.dir ?? ''))
          const rel = safeRel(String(body.rel ?? ''))
          return await mutex.run(dir, async () => {
            const target = join(dir, ...rel.split('/'))
            await assertNoSymlinkEscape(dir, rel)
            try {
              const info = await stat(target)
              if (info.isDirectory()) throw new Error('不能删除目录')
              await rm(target, { force: true })
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            }
            store.remove(dir)
            return send(200, { ok: true, removed: rel })
          })
        }
        if (req.method === 'GET' && pathname === '/download') {
          const dir = await requireDirUnderBase(baseReal, url.searchParams.get('dir') ?? '')
          const files = await collectFiles(dir, config.maxFiles, config.maxTotalBytes)
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${basename(dir)}.zip"`,
          })
          await writeZip(res, files)
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
