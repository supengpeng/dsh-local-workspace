/**
 * 路径安全工具：工作区名校验、相对路径规范化、目录 containment 与 symlink 逃逸检查。
 */
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

/** 工作区名：拒绝空名、`.`/`..`、`..` 开头、路径分隔符与控制字符。 */
export function sanitizeName(raw: string): string {
  const cleaned = raw.trim()
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('..')) {
    throw new Error(`非法工作区名: "${raw}"`)
  }
  if (/[/\\]/.test(cleaned)) throw new Error(`非法工作区名（不允许路径分隔符）: "${raw}"`)
  if (/[\u0000-\u001f]/.test(cleaned)) throw new Error(`非法工作区名（不允许控制字符）: "${raw}"`)
  return cleaned
}

/** 相对路径：拒绝绝对路径与 `..` 段，规范化空段。 */
export function safeRel(raw: string): string {
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
export async function requireDirUnderBase(baseReal: string, raw: string): Promise<string> {
  if (!isAbsolute(raw)) throw new Error(`目录必须是绝对路径: "${raw}"`)
  const real = await realpath(raw)
  if (real !== baseReal && !real.startsWith(baseReal + sep)) {
    throw new Error(`目录不在工作区根 ${baseReal} 之内: "${real}"`)
  }
  return real
}

/**
 * 校验上传相对路径不会经由 symlink 逃逸。
 *
 * 逐段检查已存在的路径：任一中间段是 symlink 或非目录、最后一段是 symlink 或目录都拒绝；
 * 不存在的段会在后续 mkdir 时以普通目录创建，因此无需继续检查。
 */
export async function assertNoSymlinkEscape(dir: string, rel: string): Promise<void> {
  const segments = safeRel(rel).split('/')
  let current = dir
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    const candidate = join(current, segment)
    try {
      const info = await lstat(candidate)
      if (info.isSymbolicLink()) throw new Error(`不允许通过 symlink 写入: "${candidate}"`)
      if (index === segments.length - 1) {
        if (info.isDirectory()) throw new Error(`目标路径是目录: "${candidate}"`)
        return
      }
      if (!info.isDirectory()) throw new Error(`路径中间段不是目录: "${candidate}"`)
      current = candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}
