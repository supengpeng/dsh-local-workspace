/**
 * @dsh-external/dsh-local-workspace — 本地文件夹工作区桥（client 半）。
 *
 * 入口：
 * - 侧边栏底部「本地文件夹」按钮 → 本地文件夹工作区管理弹层（上传/下载/删除/双向同步）；
 * - 官方「添加工作区」目录流 → 选择本机文件夹上传，或使用官方 DirectoryBrowser
 *   选择服务器目录。
 *
 * UI 走 ui-primitives 与官方 DirectoryBrowser，外观跟随 Web UI 主题令牌。
 * 数据经宿主 HTTP API（/local-workspace/api）传输二进制，不依赖 RPC。
 */
import React from 'react'
import { defineStore, type DirectoryListing, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button, IconFolderOpenOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/src/client/DirectoryBrowser.js'
import { isDirectoryPickerSupported, pickDirectory, syncManager } from './sync.js'
import css from './local-workspace.module.css'

export const inject = ['slots', 'workspaces']

const API = '/local-workspace/api'

/** 并发上传数：平衡大文件夹速度与服务器/浏览器连接压力。 */
const UPLOAD_CONCURRENCY = 6

/** 用 requestAnimationFrame 节流上传进度 setState，避免高频 XHR 进度触发大量渲染。 */
function createProgressThrottle(
  getSent: () => number,
  getTotal: () => number,
  setProgress: (value: { sent: number; total: number }) => void,
): () => void {
  let raf = 0
  return () => {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      setProgress({ sent: getSent(), total: getTotal() })
    })
  }
}

/** 服务器目录选择方式：native 用官方原生选择器；browse 用内置浏览；tryNativeFirst 先原生、失败回退浏览。 */
type ServerDirectoryMode = 'native' | 'browse' | 'tryNativeFirst'

/** 客户端可读的插件配置子集。 */
interface ClientConfig {
  serverDirectoryMode?: ServerDirectoryMode
}

/** workspaces 服务的结构化视图（完整契约见 @deepseek-ai/dsh-client-runtime/client）。 */
interface WorkspacesFace {
  create(input: { path: string }): Promise<{ workspaceId: string; path: string; title: string }>
  startSession(workspaceId?: string): void
  /** 打开宿主的原生目录选择器（官方原生 UI；远程需反代放行）。 */
  pickDirectory(): Promise<string | null>
  /** 列出宿主服务器上的一个目录层级（远程可用，不走受限的原生选择器）。 */
  listDirectory(path?: string, signal?: AbortSignal): Promise<DirectoryListing>
  /** 在宿主服务器上创建一个子目录。 */
  createDirectory(path: string, name: string): Promise<string>
}

/** slots 服务的结构化视图。 */
interface SlotsFace {
  inject(key: string, callback: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): unknown
}

type ClientContext = {
  slots: SlotsFace
  workspaces: WorkspacesFace
  effect(callback: () => unknown, label?: string): unknown
}

/** /status 响应。 */
interface Status {
  ok: boolean
  isLocal: boolean
  cwd: string | null
  name?: string
  fileCount?: number
  totalBytes?: number
}

// ─── 共享 store：侧边栏按钮与弹层的开关状态 ────────────────────────────────────

type LocalWorkspaceState = { open: boolean }

/** store 内部动作签名（框架注入 draft 作为首参）。 */
type LocalWorkspaceDraftActions = {
  toggle: (draft: LocalWorkspaceState) => void
  close: (draft: LocalWorkspaceState) => void
}

/** 组件侧动作签名（框架烘焙后的调用面，无 draft）。 */
type LocalWorkspaceActions = {
  toggle: () => void
  close: () => void
}

/** 建 store 句柄（apply 内调用一次，两个注册共享同一实例）。 */
function createLocalWorkspaceStore(): EngineStoreHandle<LocalWorkspaceState, LocalWorkspaceDraftActions> {
  return defineStore({
    init: (): LocalWorkspaceState => ({ open: false }),
    actions: {
      toggle: (draft) => { draft.open = !draft.open },
      close: (draft) => { draft.open = false },
    },
  })
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

const fmtBytes = (size: number): string =>
  size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB`
    : size >= 1024 ? `${(size / 1024).toFixed(1)} KB`
      : `${size} B`

const postJson = (path: string, body: unknown): Promise<Record<string, unknown>> =>
  fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async response => {
    const data = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) throw new Error(String(data.error ?? `请求失败（${response.status}）`))
    return data
  })

/** 单个文件上传（直接发送 File/Blob，避免整体读入内存；XHR 提供上传进度）。 */
function uploadFile(
  dir: string,
  rel: string,
  file: Blob,
  xhrs: Set<XMLHttpRequest>,
  onProgress: (loaded: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhrs.add(xhr)
    xhr.open('POST', `${API}/file?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}`)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded)
    }
    xhr.onload = () => {
      xhrs.delete(xhr)
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      let detail = ''
      try {
        const parsed = JSON.parse(xhr.responseText) as { error?: string }
        detail = parsed.error ?? ''
      } catch { /* 非 JSON 错误体 */ }
      reject(new Error(`上传失败（${xhr.status}）${detail}`))
    }
    xhr.onerror = () => {
      xhrs.delete(xhr)
      reject(new Error('上传网络错误'))
    }
    xhr.onabort = () => {
      xhrs.delete(xhr)
      reject(new Error('上传已取消'))
    }
    xhr.send(file)
  })
}

/** 有界并发上传所有文件；每个文件完成后把进度对齐到文件实际大小。 */
async function uploadAll(
  dir: string,
  files: { rel: string; file: File; size: number }[],
  concurrency: number,
  xhrs: Set<XMLHttpRequest>,
  onFileProgress: (rel: string, loaded: number) => void,
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const current = next++
      const item = files[current]!
      await uploadFile(dir, item.rel, item.file, xhrs, loaded => onFileProgress(item.rel, loaded))
      onFileProgress(item.rel, item.file.size)
    }
  }
  const count = Math.min(concurrency, files.length)
  await Promise.all(Array.from({ length: count }, () => worker()))
}

// ─── 官方「添加工作区」目录流 occupant ────────────────────────────────────────

/** 目录流 occupant 的注入面：服务器目录选择能力（原生/浏览）。 */
interface LocalDirectoryFlowInjected {
  /** 打开宿主原生目录选择器（官方原生 UI）；用户取消时返回 null。 */
  pickDirectory: () => Promise<string | null>
  /** 列出宿主服务器上的一个目录层级；缺省列出主目录。 */
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  /** 在宿主服务器上创建一个子目录。 */
  createDirectory: (path: string, name: string) => Promise<string>
  /** 服务器目录选择模式。 */
  serverDirectoryMode: ServerDirectoryMode
}

type LocalDirectoryFlowProps = DirectoryFlowOwnerProps & LocalDirectoryFlowInjected

/** 官方 DirectoryBrowser 的中文文案（与官方目录选择插件保持一致）。 */
const DIRECTORY_BROWSER_ZH: Record<string, string> = {
  'browser.title': '选择工作区目录',
  'browser.home': '主目录',
  'browser.newFolder': '新建文件夹',
  'browser.folderName': '文件夹名称',
  'browser.createIn': '在"{name}"中新建文件夹',
  'browser.untitledFolder': '未命名文件夹',
  'browser.create': '创建',
  'browser.cancel': '取消',
  'browser.open': '打开',
  'browser.editPath': '编辑路径',
  'browser.loading': '加载中…',
  'browser.truncated': '文件夹过多，仅显示开头部分。',
  'browser.showHidden': '显示隐藏文件',
}

/** 最小 Translate 实现：查表并替换 `{name}` 占位符。 */
function directoryBrowserT(key: string, params?: Record<string, unknown>): string {
  let text = DIRECTORY_BROWSER_ZH[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/**
 * 官方「添加工作区」的目录流实现：支持选择本机文件夹上传到服务器，
 * 也支持服务器目录选择。服务器目录按配置走官方原生选择器或内置浏览；
 * 上传/选择完成后把服务器目录路径交给官方 flow 的 onPicked，
 * 由官方 workspaces.create 完成注册。
 */
function LocalDirectoryFlow(props: LocalDirectoryFlowProps): React.ReactElement | null {
  const { open, busy, onPicked, onCancel, pickDirectory, listDirectory, createDirectory, serverDirectoryMode } = props
  const [uploading, setUploading] = React.useState(false)
  const [progress, setProgress] = React.useState({ sent: 0, total: 0 })
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const [serverMode, setServerMode] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const xhrsRef = React.useRef<Set<XMLHttpRequest> | null>(null)
  if (xhrsRef.current === null) xhrsRef.current = new Set()
  const sentByFileRef = React.useRef(new Map<string, number>())
  const totalSentRef = React.useRef(0)

  React.useEffect(() => {
    if (!open) {
      xhrsRef.current?.forEach(xhr => xhr.abort())
      xhrsRef.current?.clear()
      setUploading(false)
      setProgress({ sent: 0, total: 0 })
      setMessage('')
      setError('')
      setServerMode(false)
    }
  }, [open])

  const cancelUpload = (): void => {
    xhrsRef.current?.forEach(xhr => xhr.abort())
    xhrsRef.current?.clear()
  }

  const handleClose = (): void => {
    cancelUpload()
    onCancel()
  }

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    const list = Array.from(files)
    const total = list.reduce((sum, file) => sum + file.size, 0)
    if (total === 0) {
      setError('文件夹为空（没有可上传的文件）')
      return
    }
    const firstRel = list[0]?.webkitRelativePath || list[0]?.name || 'workspace'
    const name = firstRel.split('/')[0] || 'workspace'
    const items: { rel: string; file: File; size: number }[] = []
    const seen = new Set<string>()
    for (const file of list) {
      const rel = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name
      if (seen.has(rel)) {
        setError(`重复文件路径: ${rel}`)
        return
      }
      seen.add(rel)
      items.push({ rel, file, size: file.size })
    }
    setError('')
    setMessage(`正在上传「${name}」（${items.length} 个文件）…`)
    setUploading(true)
    setProgress({ sent: 0, total })
    sentByFileRef.current = new Map()
    totalSentRef.current = 0
    const pushProgress = createProgressThrottle(() => totalSentRef.current, () => total, setProgress)
    try {
      const begin = await postJson('/begin', { name })
      const dir = String(begin.dir ?? '')
      await uploadAll(dir, items, UPLOAD_CONCURRENCY, xhrsRef.current!, (rel, loaded) => {
        const previous = sentByFileRef.current.get(rel) ?? 0
        const delta = loaded - previous
        sentByFileRef.current.set(rel, loaded)
        totalSentRef.current += delta
        pushProgress()
      })
      setProgress({ sent: total, total })
      const commit = await postJson('/commit', { dir })
      setUploading(false)
      setMessage('上传完成，正在创建工作区…')
      onPicked(String(commit.path))
    } catch (uploadError) {
      cancelUpload()
      setUploading(false)
      setMessage('')
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError))
    }
  }

  const handlePickServer = async (): Promise<void> => {
    setError('')
    if (serverDirectoryMode === 'browse') {
      setServerMode(true)
      return
    }
    try {
      const path = await pickDirectory()
      if (path !== null) onPicked(path)
      // 用户取消原生选择器时留在当前弹层，仍可选择本机文件夹。
    } catch (pickError) {
      if (serverDirectoryMode === 'tryNativeFirst') {
        setServerMode(true)
      } else {
        setError(pickError instanceof Error ? pickError.message : String(pickError))
      }
    }
  }

  if (!open) return null

  // 服务器目录选择使用官方 DirectoryBrowser（官方 UI），不再自绘列表。
  if (serverMode) {
    return (
      <DirectoryBrowser
        open={serverMode}
        busy={busy}
        listDirectory={listDirectory}
        createDirectory={createDirectory}
        t={directoryBrowserT}
        onOpen={path => onPicked(path)}
        onClose={() => setServerMode(false)}
      />
    )
  }

  const percent = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="添加工作区"
      description="选择本机文件夹上传到服务器，或选择服务器已有目录。"
      closeLabel="关闭"
      className={css.modalLarge}
    >
      <div className={css.panel}>
        {busy ? (
          <div className={css.syncText}>正在创建工作区…</div>
        ) : uploading ? (
          <>
            <div className={css.message}>{message}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={css.progressTrack}>
                <span className={css.progressBar} style={{ width: `${percent}%` }} />
              </span>
              <span className={css.progressText}>{percent}%</span>
              <Button variant="ghost" size="sm" onClick={handleClose}>取消</Button>
            </div>
          </>
        ) : (
          <div className={css.addFlow}>
            <div className={css.addFlowRow}>
              <Button
                variant="outline"
                size="md"
                icon={<IconFolderOpenOutline16 />}
                onClick={() => inputRef.current?.click()}
                className={css.addFlowButton}
              >
                选择本地文件夹
              </Button>
              <Button
                variant="outline"
                size="md"
                onClick={() => void handlePickServer()}
                className={css.addFlowButton}
              >
                选择服务器目录
              </Button>
            </div>
            <div className={css.addHint}>
              本机文件夹会先上传到服务器；服务器目录直接浏览选择。
            </div>
          </div>
        )}

        {!uploading && message !== '' && (
          <div className={css.message}>{message}</div>
        )}
        {error !== '' && (
          <div className={css.error}>{error}</div>
        )}

        <input
          ref={inputRef}
          type="file"
          style={{ display: 'none' }}
          multiple
          {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
          onChange={event => {
            void handleFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </Modal>
  )
}


// ─── 官方 WorkspaceBrowser 头部本地文件夹入口 ─────────────────────────────────

/** 官方 WorkspaceBrowser 头部 action 条目收到的 props（store 座）。 */
interface BrowserActionProps {
  useStore: <T>(selector: (state: LocalWorkspaceState) => T) => T
  actions: LocalWorkspaceActions
}

function LocalWorkspaceBrowserAction(props: BrowserActionProps): React.ReactElement {
  const open = props.useStore(state => state.open)
  return (
    <Button
      variant={open ? 'primary' : 'ghost'}
      size="sm"
      icon={<IconFolderOpenOutline16 />}
      onClick={props.actions.toggle}
      aria-label="本地文件夹工作区"
      title="本地文件夹工作区"
    />
  )
}

// ─── 弹层面板 ─────────────────────────────────────────────────────────────────

/** 弹层条目收到的 props（会话列表标准座 + store 座）。 */
interface OverlayProps {
  useSessions: <T>(selector: (state: { current?: string }) => T) => T
  useStore: <T>(selector: (state: LocalWorkspaceState) => T) => T
  actions: LocalWorkspaceActions
}

function LocalWorkspaceOverlay(
  ctx: ClientContext,
  props: OverlayProps,
  serverDirectoryMode: ServerDirectoryMode = 'browse',
): React.ReactElement | null {
  const open = props.useStore(state => state.open)
  const sessionId = props.useSessions(state => state.current)
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState({ sent: 0, total: 0 })
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
  const [serverMode, setServerMode] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const xhrsRef = React.useRef<Set<XMLHttpRequest> | null>(null)
  if (xhrsRef.current === null) xhrsRef.current = new Set()
  const sentByFileRef = React.useRef(new Map<string, number>())
  const totalSentRef = React.useRef(0)
  const syncSnapshot = React.useSyncExternalStore(syncManager.subscribe, syncManager.getSnapshot)

  const refresh = React.useCallback((): void => {
    fetch(`${API}/status?sessionId=${encodeURIComponent(sessionId ?? '')}`)
      .then(async response => {
        const data = await response.json() as Status
        if (data?.ok) setStatus(data)
      })
      .catch(() => { /* 状态查询失败静默，等下一次刷新 */ })
  }, [sessionId])

  React.useEffect(() => {
    if (!open) {
      setServerMode(false)
      return
    }
    refresh()
    const timer = window.setInterval(refresh, 30000)
    return () => window.clearInterval(timer)
  }, [open, refresh])

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return
    const list = Array.from(files)
    const total = list.reduce((sum, file) => sum + file.size, 0)
    if (total === 0) {
      setError('文件夹为空（没有可上传的文件）')
      return
    }
    const firstRel = list[0]?.webkitRelativePath || list[0]?.name || 'workspace'
    const name = firstRel.split('/')[0] || 'workspace'
    const items: { rel: string; file: File; size: number }[] = []
    const seen = new Set<string>()
    for (const file of list) {
      const rel = (file.webkitRelativePath || file.name).split('/').slice(1).join('/') || file.name
      if (seen.has(rel)) {
        setError(`重复文件路径: ${rel}`)
        return
      }
      seen.add(rel)
      items.push({ rel, file, size: file.size })
    }
    setError('')
    setMessage(`正在上传「${name}」（${items.length} 个文件）…`)
    setBusy(true)
    setProgress({ sent: 0, total })
    sentByFileRef.current = new Map()
    totalSentRef.current = 0
    const pushProgress = createProgressThrottle(() => totalSentRef.current, () => total, setProgress)
    try {
      const begin = await postJson('/begin', { name })
      const dir = String(begin.dir ?? '')
      await uploadAll(dir, items, UPLOAD_CONCURRENCY, xhrsRef.current!, (rel, loaded) => {
        const previous = sentByFileRef.current.get(rel) ?? 0
        const delta = loaded - previous
        sentByFileRef.current.set(rel, loaded)
        totalSentRef.current += delta
        pushProgress()
      })
      setProgress({ sent: total, total })
      const commit = await postJson('/commit', { dir })
      setMessage('上传完成，正在创建工作区会话…')
      const created = await ctx.workspaces.create({ path: String(commit.path) })
      ctx.workspaces.startSession(created.workspaceId)
      setMessage('已切换到新工作区会话')
      setStatus(null)
    } catch (uploadError) {
      cancel()
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError))
      setMessage('')
    } finally {
      setBusy(false)
      setProgress({ sent: 0, total: 0 })
    }
  }

  const handleServerPicked = async (path: string): Promise<void> => {
    setServerMode(false)
    setBusy(true)
    setMessage('正在创建工作区会话…')
    try {
      const created = await ctx.workspaces.create({ path })
      ctx.workspaces.startSession(created.workspaceId)
      setMessage('已切换到服务器目录工作区')
      setStatus(null)
    } catch (serverError) {
      setError(serverError instanceof Error ? serverError.message : String(serverError))
      setMessage('')
    } finally {
      setBusy(false)
    }
  }

  const handlePickServer = async (): Promise<void> => {
    setError('')
    if (serverDirectoryMode === 'browse') {
      setServerMode(true)
      return
    }
    try {
      const path = await ctx.workspaces.pickDirectory()
      if (path !== null) await handleServerPicked(path)
    } catch (pickError) {
      if (serverDirectoryMode === 'tryNativeFirst') {
        setServerMode(true)
      } else {
        setError(pickError instanceof Error ? pickError.message : String(pickError))
      }
    }
  }

  const handleStartSync = async (): Promise<void> => {
    try {
      setError('')
      setMessage('请选择要同步的本地文件夹…')
      const handle = await pickDirectory()
      if (handle === null) {
        setMessage('')
        return
      }
      const begin = await postJson('/begin', { name: handle.name })
      const dir = String(begin.dir ?? '')
      await syncManager.start(dir, handle)
      const created = await ctx.workspaces.create({ path: dir })
      ctx.workspaces.startSession(created.workspaceId)
      setMessage(`已开始后台双向同步：${handle.name}`)
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError))
      setMessage('')
    }
  }

  const handleStopSync = async (): Promise<void> => {
    await syncManager.stop()
    setMessage('已停止后台同步')
  }

  const handleSyncNow = async (): Promise<void> => {
    await syncManager.syncNow()
  }

  const handleForgetSync = async (): Promise<void> => {
    if (!window.confirm('忘记此文件夹的同步状态并停止同步？')) return
    await syncManager.forget()
    setMessage('已停止并清除同步状态')
  }

  const cancel = (): void => {
    xhrsRef.current?.forEach(xhr => xhr.abort())
    xhrsRef.current?.clear()
  }

  const download = (): void => {
    if (status?.cwd === null || status?.cwd === undefined) return
    setError('')
    setMessage('正在打包下载…')
    fetch(`${API}/download?dir=${encodeURIComponent(status.cwd)}`)
      .then(async response => {
        if (!response.ok) throw new Error(`下载失败（${response.status}）`)
        const blob = await response.blob()
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${status.name ?? 'workspace'}.zip`
        anchor.click()
        URL.revokeObjectURL(url)
        setMessage('已开始下载')
      })
      .catch(downloadError => {
        setError(downloadError instanceof Error ? downloadError.message : String(downloadError))
      })
  }

  const remove = (): void => {
    if (status?.cwd === null || status?.cwd === undefined) return
    if (!window.confirm(`删除服务器上的工作区目录 ${status.cwd}？\n（工作区注册与会话不受影响）`)) return
    setError('')
    setBusy(true)
    postJson('/remove', { dir: status.cwd })
      .then(() => {
        setMessage('已删除服务器上的工作区目录')
        setStatus(null)
        refresh()
      })
      .catch(removeError => {
        setError(removeError instanceof Error ? removeError.message : String(removeError))
      })
      .finally(() => setBusy(false))
  }

  const percent = progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0

  if (!open) return null

  if (serverMode) {
    return (
      <DirectoryBrowser
        open={serverMode}
        busy={busy}
        listDirectory={(path, signal) => ctx.workspaces.listDirectory(path, signal)}
        createDirectory={(path, name) => ctx.workspaces.createDirectory(path, name)}
        t={directoryBrowserT}
        onOpen={path => void handleServerPicked(path)}
        onClose={() => setServerMode(false)}
      />
    )
  }

  const statusLine = status?.isLocal
    ? `${status.name}（${status.fileCount} 个文件 · ${fmtBytes(status.totalBytes ?? 0)}）`
    : status?.cwd !== null && status?.cwd !== undefined
      ? `当前会话工作区：${status.cwd}（非本插件目录）`
      : sessionId === undefined
        ? '当前没有打开的会话——上传完成后会自动创建新会话'
        : '把电脑上的文件夹传上来，作为本会话的工作区'
  const syncSupported = isDirectoryPickerSupported()

  return (
    <Modal
      open={open}
      onClose={props.actions.close}
      title="本地文件夹工作区"
      description="把你自己电脑上的文件夹变成服务器上的工作区（代理可读写），随时可打包下载回本地。"
      closeLabel="关闭"
      className={css.modalXLarge}
    >
      <div className={css.panel}>
        <div className={css.statusLine}>
          <span className={css.statusText}>
            {statusLine}
          </span>
          {status?.isLocal && (
            <span className={css.statusPath}>
              {status.cwd}
            </span>
          )}
        </div>

        {syncSupported ? (
          <div className={css.syncCard}>
            <div className={css.syncTitle}>后台双向同步</div>
            {syncSnapshot.running ? (
              <>
                <div className={css.syncText} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  正在同步「{syncSnapshot.handleName}」{syncSnapshot.syncing ? '…' : ''}
                </div>
                {syncSnapshot.lastSyncAt !== null && (
                  <div className={css.syncText}>
                    上次同步：{new Date(syncSnapshot.lastSyncAt).toLocaleTimeString()}
                  </div>
                )}
                {syncSnapshot.lastStats !== null && (
                  <div className={css.syncStats}>
                    最近一次：上传 {syncSnapshot.lastStats.uploaded} · 下载 {syncSnapshot.lastStats.downloaded} · 本地删 {syncSnapshot.lastStats.deletedLocal} · 远端删 {syncSnapshot.lastStats.deletedRemote}
                  </div>
                )}
                {syncSnapshot.lastError !== null && (
                  <div className={css.syncError}>
                    {syncSnapshot.lastError}
                  </div>
                )}
                <div className={css.syncActions}>
                  <Button variant="outline" size="sm" onClick={() => void handleSyncNow()} disabled={syncSnapshot.syncing}>
                    立即同步
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleStopSync()} disabled={syncSnapshot.syncing}>
                    停止同步
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => void handleForgetSync()} disabled={syncSnapshot.syncing}>
                    忘记文件夹
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className={css.syncText}>
                  选择本地文件夹后，将在后台持续双向同步（含删除），关闭弹窗后仍继续。
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleStartSync()}
                  disabled={busy}
                  className={css.buttonFull}
                >
                  选择文件夹并开始同步
                </Button>
              </>
            )}
          </div>
        ) : (
          <div className={css.syncText}>
            当前浏览器不支持后台双向同步，仍可使用一次性上传。
          </div>
        )}


        <div className={css.addFlowRow}>
          <Button variant="outline" size="md" icon={<IconFolderOpenOutline16 />} onClick={() => inputRef.current?.click()} disabled={busy} className={css.addFlowButton}>
            选择本地文件夹
          </Button>
          <Button variant="outline" size="md" onClick={() => void handlePickServer()} disabled={busy} className={css.addFlowButton}>
            选择服务器目录
          </Button>
        </div>

        <div className={css.actionRow}>
          {status?.isLocal && (
            <Button variant="outline" size="md" onClick={download} disabled={busy}>
              打包下载
            </Button>
          )}
          {status?.isLocal && (
            <Button
              variant="ghost"
              size="md"
              onClick={remove}
              disabled={busy}
              style={{ color: 'var(--dsw-alias-state-danger-label, #e5534b)' }}
            >
              删除
            </Button>
          )}
          {busy && (
            <Button variant="ghost" size="md" onClick={cancel}>
              取消
            </Button>
          )}
          {busy && progress.total > 0 && (
            <span style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={css.progressTrack}>
                <span className={css.progressBar} style={{ width: `${percent}%` }} />
              </span>
              <span className={css.progressText}>{percent}%</span>
            </span>
          )}
        </div>

        {message !== '' && (
          <div className={css.message}>{message}</div>
        )}
        {error !== '' && (
          <div className={css.error}>{error}</div>
        )}

        <input
          ref={inputRef}
          type="file"
          style={{ display: 'none' }}
          multiple
          {...({ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
          onChange={event => {
            void handleFiles(event.target.files)
            event.target.value = ''
          }}
        />
      </div>
    </Modal>
  )
}

export function apply(ctx: ClientContext, config?: ClientConfig): void {
  // 共享 store 句柄：侧边栏按钮与弹层条目用同一实例（open 开关互通）。
  const store = createLocalWorkspaceStore()

  // 恢复上次已授权的后台同步会话（无用户手势时仅恢复已授权句柄）。
  void syncManager.restore().catch(() => { /* 恢复失败不影响插件其他功能 */ })

  const serverDirectoryMode = config?.serverDirectoryMode ?? 'browse'

  // 组件定义在 apply 内：上传/切换会话需要闭包里的 ctx（workspaces 服务）。
  const Overlay = (props: OverlayProps): React.ReactElement | null => LocalWorkspaceOverlay(ctx, props, serverDirectoryMode)
  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'local-workspace',
        order: 60,
        label: () => '本地文件夹工作区',
        store,
      },
      Overlay,
    ),
  ), 'local-workspace: overlay')

  // 官方 WorkspaceBrowser 头部入口：与侧边栏按钮共用同一个 store。
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.localWorkspaceAction', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.localWorkspaceAction',
        id: 'local-workspace',
        order: 50,
        store,
      },
      LocalWorkspaceBrowserAction,
    ),
  ), 'local-workspace: workspace browser action')

  // 官方「添加工作区」目录流：支持本机文件夹上传，也支持服务器目录选择。
  const directoryFlowInjected = (): LocalDirectoryFlowInjected => ({
    pickDirectory: () => ctx.workspaces.pickDirectory(),
    listDirectory: (path, signal) => ctx.workspaces.listDirectory(path, signal),
    createDirectory: (path, name) => ctx.workspaces.createDirectory(path, name),
    serverDirectoryMode,
  })
  ctx.effect(() => ctx.slots.inject('sidebar.workspaces.directoryFlow', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.directoryFlow',
        inject: directoryFlowInjected,
        // 低于官方 browse/native 的默认 0，让官方「添加工作区」优先使用本插件。
        priority: -1,
      },
      LocalDirectoryFlow,
    ),
  ), 'local-workspace: sidebar directory flow')
  ctx.effect(() => ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.register(
      {
        name: 'conversation.hero.workspace.directoryFlow',
        inject: directoryFlowInjected,
        priority: -1,
      },
      LocalDirectoryFlow,
    ),
  ), 'local-workspace: conversation directory flow')
}
