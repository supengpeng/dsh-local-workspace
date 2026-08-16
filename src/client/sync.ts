/**
 * 后台双向同步引擎。
 *
 * 基于 File System Access API 持有本地文件夹句柄，与服务器工作区按 manifest 对比：
 * - 后台持续轮询（默认 30s），弹窗关闭后仍运行；
 * - 删除双向传播，依赖持久化的 baseline 区分“远端新增”与“本地删除”；
 * - 冲突策略为最后修改时间优先（mtime 新的一方覆盖旧的一方）。
 */
const API = '/local-workspace/api'
const SYNC_INTERVAL_MS = 30000
const DB_NAME = 'dsh-local-workspace-sync'
const DB_STORE = 'sync-state'
const DB_VERSION = 1

/** 清单中的单个文件。 */
export interface SyncFile {
  rel: string
  size: number
  mtime: number
}

/** baseline 中单个文件上次同步时的两侧状态。 */
export interface BaselineEntry {
  localMtime: number
  remoteMtime: number
  localSize: number
  remoteSize: number
}

export type SyncBaseline = Record<string, BaselineEntry>

/** 暴露给 UI 的只读快照。 */
export interface SyncSnapshot {
  dir: string
  handleName: string
  running: boolean
  syncing: boolean
  lastSyncAt: number | null
  lastError: string | null
  lastStats: { uploaded: number; downloaded: number; deletedLocal: number; deletedRemote: number } | null
}

interface PersistedSyncState {
  dir: string
  handle: FileSystemDirectoryHandle
  baseline: SyncBaseline
  enabled: boolean
}

/** File System Access API 的权限方法在部分 TS DOM 版本中缺失，这里补最小声明。 */
interface SyncDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
}

interface DirectoryPickerWindow extends Window {
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}

export function isDirectoryPickerSupported(): boolean {
  return typeof (window as DirectoryPickerWindow).showDirectoryPicker === 'function'
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) throw new Error('当前浏览器不支持文件夹句柄（需要 Chrome/Edge 等）')
  return picker({ mode: 'readwrite' })
}

// ─── IndexedDB 持久化 ────────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'dir' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function loadSyncStates(): Promise<PersistedSyncState[]> {
  const db = await openDb()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readonly')
      const request = transaction.objectStore(DB_STORE).getAll()
      request.onsuccess = () => resolve((request.result ?? []) as PersistedSyncState[])
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

async function saveSyncState(state: PersistedSyncState): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readwrite')
      transaction.objectStore(DB_STORE).put(state)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

async function clearSyncState(dir: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, 'readwrite')
      transaction.objectStore(DB_STORE).delete(dir)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  } finally {
    db.close()
  }
}

// ─── 本地/远端文件操作 ───────────────────────────────────────────────────────

async function collectLocalFiles(handle: FileSystemDirectoryHandle, prefix = ''): Promise<Map<string, SyncFile>> {
  const out = new Map<string, SyncFile>()
  for await (const [name, child] of handle.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name
    if (child.kind === 'file') {
      const file = await (child as FileSystemFileHandle).getFile()
      out.set(rel, { rel, size: file.size, mtime: file.lastModified })
    } else if (child.kind === 'directory') {
      const sub = await collectLocalFiles(child as FileSystemDirectoryHandle, rel)
      for (const [key, value] of sub) out.set(key, value)
    }
  }
  return out
}

async function fetchRemoteManifest(dir: string): Promise<Map<string, SyncFile>> {
  const response = await fetch(`${API}/sync/manifest?dir=${encodeURIComponent(dir)}`)
  const data = await response.json().catch(() => ({})) as { ok?: boolean; files?: SyncFile[]; error?: string }
  if (!response.ok || !data.ok) throw new Error(data.error ?? `获取远端清单失败（${response.status}）`)
  return new Map((data.files ?? []).map(file => [file.rel, file]))
}

async function uploadFile(dir: string, rel: string, file: File): Promise<void> {
  const url = `${API}/file?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}&mtime=${encodeURIComponent(String(file.lastModified))}`
  const response = await fetch(url, { method: 'POST', body: file })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `上传失败（${response.status}）`)
  }
}

async function downloadFile(
  dir: string,
  rel: string,
  remote: SyncFile,
  handle: FileSystemDirectoryHandle,
): Promise<SyncFile> {
  const response = await fetch(`${API}/sync/file?dir=${encodeURIComponent(dir)}&rel=${encodeURIComponent(rel)}`)
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `下载失败（${response.status}）`)
  }
  const blob = await response.blob()
  const parts = rel.split('/')
  let current = handle
  for (let index = 0; index < parts.length - 1; index++) {
    current = await current.getDirectoryHandle(parts[index]!, { create: true })
  }
  const fileName = parts[parts.length - 1]!
  const fileHandle = await current.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()
  const file = await fileHandle.getFile()
  return { rel, size: file.size, mtime: file.lastModified }
}

async function deleteLocalFile(handle: FileSystemDirectoryHandle, rel: string): Promise<void> {
  const parts = rel.split('/')
  let current = handle
  for (let index = 0; index < parts.length - 1; index++) {
    current = await current.getDirectoryHandle(parts[index]!)
  }
  await current.removeEntry(parts[parts.length - 1]!)
}

async function deleteRemoteFile(dir: string, rel: string): Promise<void> {
  const response = await fetch(`${API}/sync/remove-file`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dir, rel }),
  })
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `删除远端文件失败（${response.status}）`)
  }
}

async function getLocalFile(handle: FileSystemDirectoryHandle, rel: string): Promise<File> {
  const parts = rel.split('/')
  let current = handle
  for (let index = 0; index < parts.length - 1; index++) {
    current = await current.getDirectoryHandle(parts[index]!)
  }
  const fileHandle = await current.getFileHandle(parts[parts.length - 1]!)
  return fileHandle.getFile()
}

// ─── 同步管理器 ─────────────────────────────────────────────────────────────

class SyncManager {
  private state: PersistedSyncState | null = null
  private running = false
  private syncing = false
  private timer: number | null = null
  private lastSyncAt: number | null = null
  private lastError: string | null = null
  private lastStats: SyncSnapshot['lastStats'] = null
  private snapshot: SyncSnapshot = {
    dir: '',
    handleName: '',
    running: false,
    syncing: false,
    lastSyncAt: null,
    lastError: null,
    lastStats: null,
  }
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): SyncSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private refreshSnapshot(): void {
    this.snapshot = {
      dir: this.state?.dir ?? '',
      handleName: this.state?.handle.name ?? '',
      running: this.running,
      syncing: this.syncing,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      lastStats: this.lastStats,
    }
    this.notify()
  }

  async restore(): Promise<void> {
    const states = await loadSyncStates()
    if (states.length === 0) return
    const state = states[0]!
    if (state.enabled === false) return
    const handle = state.handle as SyncDirectoryHandle
    if (handle.queryPermission) {
      const permission = await handle.queryPermission({ mode: 'readwrite' })
      if (permission !== 'granted') return
    }
    await this.start(state.dir, state.handle, { restore: true })
  }

  async start(dir: string, handle: FileSystemDirectoryHandle, options: { restore?: boolean } = {}): Promise<void> {
    await this.stop()
    const syncHandle = handle as SyncDirectoryHandle
    if (!options.restore) {
      const permission = syncHandle.requestPermission
        ? await syncHandle.requestPermission({ mode: 'readwrite' })
        : 'granted'
      if (permission !== 'granted') throw new Error('未获得文件夹读写权限')
    }
    const states = await loadSyncStates()
    const existing = states.find(state => state.dir === dir)
    let baseline: SyncBaseline = {}
    if (existing) {
      const sameHandle = await existing.handle.isSameEntry(handle).catch(() => false)
      if (sameHandle) baseline = existing.baseline
    }
    this.state = { dir, handle, baseline, enabled: true }
    this.running = true
    this.lastError = null
    this.lastStats = null
    try {
      await saveSyncState(this.state)
    } catch (error) {
      this.state = null
      this.running = false
      this.refreshSnapshot()
      throw error
    }
    this.refreshSnapshot()
    await this.syncNow()
    this.timer = window.setInterval(() => { void this.syncNow() }, SYNC_INTERVAL_MS)
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
    this.running = false
    if (this.state) {
      this.state = { ...this.state, enabled: false }
      await saveSyncState(this.state).catch(() => { /* 停止时持久化失败不阻塞 UI */ })
    }
    this.refreshSnapshot()
  }

  async forget(): Promise<void> {
    await this.stop()
    if (this.state) {
      await clearSyncState(this.state.dir)
      this.state = null
      this.lastSyncAt = null
      this.lastError = null
      this.lastStats = null
      this.refreshSnapshot()
    }
  }

  async syncNow(): Promise<void> {
    if (!this.state || !this.running || this.syncing) return
    this.syncing = true
    this.refreshSnapshot()
    const stats = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0 }
    try {
      const originalState = this.state
      const { dir, handle, baseline } = originalState
      const remoteMap = await fetchRemoteManifest(dir)
      const localMap = await collectLocalFiles(handle)
      const nextBaseline: SyncBaseline = { ...baseline }
      const rels = new Set([...localMap.keys(), ...remoteMap.keys(), ...Object.keys(baseline)])

      for (const rel of rels) {
        const local = localMap.get(rel)
        const remote = remoteMap.get(rel)
        const base = nextBaseline[rel]

        if (local && remote) {
          const localChanged = !base || local.mtime !== base.localMtime || local.size !== base.localSize
          const remoteChanged = !base || remote.mtime !== base.remoteMtime || remote.size !== base.remoteSize
          if (!base) {
            if (local.mtime > remote.mtime) {
              await uploadFile(dir, rel, await getLocalFile(handle, rel))
              stats.uploaded++
              nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: local.mtime, localSize: local.size, remoteSize: local.size }
            } else if (remote.mtime > local.mtime) {
              const actual = await downloadFile(dir, rel, remote, handle)
              stats.downloaded++
              nextBaseline[rel] = { localMtime: actual.mtime, remoteMtime: remote.mtime, localSize: actual.size, remoteSize: remote.size }
            } else {
              nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: remote.mtime, localSize: local.size, remoteSize: remote.size }
            }
          } else if (localChanged && !remoteChanged) {
            await uploadFile(dir, rel, await getLocalFile(handle, rel))
            stats.uploaded++
            nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: local.mtime, localSize: local.size, remoteSize: local.size }
          } else if (remoteChanged && !localChanged) {
            const actual = await downloadFile(dir, rel, remote, handle)
            stats.downloaded++
            nextBaseline[rel] = { localMtime: actual.mtime, remoteMtime: remote.mtime, localSize: actual.size, remoteSize: remote.size }
          } else if (localChanged && remoteChanged) {
            if (local.mtime > remote.mtime) {
              await uploadFile(dir, rel, await getLocalFile(handle, rel))
              stats.uploaded++
              nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: local.mtime, localSize: local.size, remoteSize: local.size }
            } else if (remote.mtime > local.mtime) {
              const actual = await downloadFile(dir, rel, remote, handle)
              stats.downloaded++
              nextBaseline[rel] = { localMtime: actual.mtime, remoteMtime: remote.mtime, localSize: actual.size, remoteSize: remote.size }
            } else {
              nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: remote.mtime, localSize: local.size, remoteSize: remote.size }
            }
          } else {
            nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: remote.mtime, localSize: local.size, remoteSize: remote.size }
          }
        } else if (local && !remote) {
          if (base) {
            await deleteLocalFile(handle, rel)
            stats.deletedLocal++
            delete nextBaseline[rel]
          } else {
            await uploadFile(dir, rel, await getLocalFile(handle, rel))
            stats.uploaded++
            nextBaseline[rel] = { localMtime: local.mtime, remoteMtime: local.mtime, localSize: local.size, remoteSize: local.size }
          }
        } else if (!local && remote) {
          if (base) {
            await deleteRemoteFile(dir, rel)
            stats.deletedRemote++
            delete nextBaseline[rel]
          } else {
            const actual = await downloadFile(dir, rel, remote, handle)
            stats.downloaded++
            nextBaseline[rel] = { localMtime: actual.mtime, remoteMtime: remote.mtime, localSize: actual.size, remoteSize: remote.size }
          }
        } else if (!local && !remote && base) {
          delete nextBaseline[rel]
        }
      }

      if (!this.running || this.state !== originalState) return
      this.state = { ...originalState, baseline: nextBaseline }
      await saveSyncState(this.state)
      this.lastSyncAt = Date.now()
      this.lastStats = stats
      this.lastError = null
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      this.syncing = false
      this.refreshSnapshot()
    }
  }
}

export const syncManager = new SyncManager()
