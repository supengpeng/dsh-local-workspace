/**
 * @dsh-external/dsh-local-workspace — 本地文件夹工作区桥（client 半）。
 *
 * 入口在侧边栏底部（sidebar.footer.action，设置按钮旁）：一个「本地文件夹」
 * 按钮，点击打开全屏弹层（shell.overlay + ui-primitives Modal），弹层内提供：
 * - 当前会话工作区状态（路径/文件数/大小）；
 * - 「选择本地文件夹」上传（<input webkitdirectory>，XHR 进度），完成后用
 *   workspaces 服务注册工作区并切换会话（新会话 cwd = 上传目录，fs 沙箱根随之指向它）；
 * - zip 打包下载与删除。
 *
 * 两个注册共享一个 apply 内构建的 store 句柄（open 开关），全部组件走
 * ui-primitives（Button/Modal/图标），外观跟随 Web UI 主题令牌。
 * 数据经宿主 HTTP API（/local-workspace/api）传输二进制，不依赖 RPC。
 */
import React from 'react'
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  Button, IconFolderOpenOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { isDirectoryPickerSupported, pickDirectory, syncManager } from './sync.js'

export const inject = ['slots', 'workspaces']

const API = '/local-workspace/api'

/** 并发上传数：平衡大文件夹速度与服务器/浏览器连接压力。 */
const UPLOAD_CONCURRENCY = 4

/** workspaces 服务的结构化视图（完整契约见 @deepseek-ai/dsh-client-runtime/client）。 */
interface WorkspacesFace {
  create(input: { path: string }): Promise<{ workspaceId: string; path: string; title: string }>
  startSession(workspaceId?: string): void
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

// ─── 侧边栏底部入口按钮 ───────────────────────────────────────────────────────

/** 侧边栏 action 条目收到的 props（宽/窄栏状态 + store 座）。 */
interface FooterActionProps {
  wide: boolean
  useStore: <T>(selector: (state: LocalWorkspaceState) => T) => T
  actions: LocalWorkspaceActions
}

function LocalWorkspaceFooterAction(props: FooterActionProps): React.ReactElement {
  const open = props.useStore(state => state.open)
  return (
    <Button
      variant={open ? 'primary' : 'ghost'}
      size="sm"
      icon={<IconFolderOpenOutline16 />}
      onClick={props.actions.toggle}
      aria-label="本地文件夹工作区"
      title="本地文件夹工作区"
    >
      {props.wide && '本地文件夹'}
    </Button>
  )
}

// ─── 弹层面板 ─────────────────────────────────────────────────────────────────

/** 弹层条目收到的 props（会话列表标准座 + store 座）。 */
interface OverlayProps {
  useSessions: <T>(selector: (state: { current?: string }) => T) => T
  useStore: <T>(selector: (state: LocalWorkspaceState) => T) => T
  actions: LocalWorkspaceActions
}

function LocalWorkspaceOverlay(ctx: ClientContext, props: OverlayProps): React.ReactElement | null {
  const open = props.useStore(state => state.open)
  const sessionId = props.useSessions(state => state.current)
  const [status, setStatus] = React.useState<Status | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [progress, setProgress] = React.useState({ sent: 0, total: 0 })
  const [message, setMessage] = React.useState('')
  const [error, setError] = React.useState('')
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
    if (!open) return
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
    try {
      const begin = await postJson('/begin', { name })
      const dir = String(begin.dir ?? '')
      await uploadAll(dir, items, UPLOAD_CONCURRENCY, xhrsRef.current!, (rel, loaded) => {
        const previous = sentByFileRef.current.get(rel) ?? 0
        const delta = loaded - previous
        sentByFileRef.current.set(rel, loaded)
        totalSentRef.current += delta
        setProgress({ sent: totalSentRef.current, total })
      })
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

  const handleStartSync = async (): Promise<void> => {
    try {
      setError('')
      setMessage('请选择要同步的本地文件夹…')
      const handle = await pickDirectory()
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
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 420, padding: '4px 2px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
          }}
        >
          <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {statusLine}
          </span>
          {status?.isLocal && (
            <span style={{ flex: 'none', color: 'var(--dsw-alias-label-tertiary)', font: 'var(--dsw-font-xs-13)' }}>
              {status.cwd}
            </span>
          )}
        </div>

        {syncSupported ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 8, background: 'var(--dsw-alias-interactive-bg-hover)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }}>后台双向同步</div>
            {syncSnapshot.running ? (
              <>
                <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary)' }}>
                  正在同步「{syncSnapshot.handleName}」{syncSnapshot.syncing ? '…' : ''}
                </div>
                {syncSnapshot.lastSyncAt !== null && (
                  <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                    上次同步：{new Date(syncSnapshot.lastSyncAt).toLocaleTimeString()}
                  </div>
                )}
                {syncSnapshot.lastStats !== null && (
                  <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                    最近一次：上传 {syncSnapshot.lastStats.uploaded} · 下载 {syncSnapshot.lastStats.downloaded} · 本地删 {syncSnapshot.lastStats.deletedLocal} · 远端删 {syncSnapshot.lastStats.deletedRemote}
                  </div>
                )}
                {syncSnapshot.lastError !== null && (
                  <div style={{ fontSize: 12, color: 'var(--dsw-alias-state-danger-label, #e5534b)' }}>
                    {syncSnapshot.lastError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
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
                <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
                  选择本地文件夹后，将在后台持续双向同步（含删除），关闭弹窗后仍继续。
                </div>
                <Button variant="outline" size="sm" onClick={() => void handleStartSync()} disabled={busy}>
                  选择文件夹并开始同步
                </Button>
              </>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
            当前浏览器不支持后台双向同步，仍可使用一次性上传。
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button variant="primary" size="md" icon={<IconFolderOpenOutline16 />} onClick={() => inputRef.current?.click()} disabled={busy}>
            选择本地文件夹
          </Button>
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
              <span
                style={{
                  flex: '1 1 auto',
                  height: 4,
                  borderRadius: 2,
                  overflow: 'hidden',
                  background: 'var(--dsw-alias-interactive-bg-hover)',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    width: `${percent}%`,
                    height: '100%',
                    borderRadius: 2,
                    background: 'var(--dsw-alias-state-business-primary)',
                  }}
                />
              </span>
              <span style={{ flex: 'none', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>{percent}%</span>
            </span>
          )}
        </div>

        {message !== '' && (
          <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-primary-dimmed)' }}>{message}</div>
        )}
        {error !== '' && (
          <div style={{ fontSize: 13, color: 'var(--dsw-alias-state-danger-label, #e5534b)' }}>{error}</div>
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

export function apply(ctx: ClientContext): void {
  // 共享 store 句柄：侧边栏按钮与弹层条目用同一实例（open 开关互通）。
  const store = createLocalWorkspaceStore()

  // 恢复上次已授权的后台同步会话（无用户手势时仅恢复已授权句柄）。
  void syncManager.restore().catch(() => { /* 恢复失败不影响插件其他功能 */ })

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'local-workspace',
        order: 50,
        label: () => '本地文件夹工作区',
        store,
      },
      LocalWorkspaceFooterAction,
    ),
  ), 'local-workspace: footer action')

  // 组件定义在 apply 内：上传/切换会话需要闭包里的 ctx（workspaces 服务）。
  const Overlay = (props: OverlayProps): React.ReactElement | null => LocalWorkspaceOverlay(ctx, props)
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
}
