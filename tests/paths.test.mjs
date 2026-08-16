import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoSymlinkEscape, requireDirUnderBase, safeRel, sanitizeName } from '../lib/paths.js'

test('sanitizeName rejects unsafe names', () => {
  assert.equal(sanitizeName(' demo '), 'demo')
  assert.throws(() => sanitizeName(''), /非法工作区名/)
  assert.throws(() => sanitizeName('.'), /非法工作区名/)
  assert.throws(() => sanitizeName('..'), /非法工作区名/)
  assert.throws(() => sanitizeName('../x'), /非法工作区名/)
  assert.throws(() => sanitizeName('a/b'), /非法工作区名/)
  assert.throws(() => sanitizeName('a\\b'), /非法工作区名/)
  assert.throws(() => sanitizeName('a\u0000b'), /非法工作区名/)
})

test('safeRel rejects traversal and normalizes', () => {
  assert.equal(safeRel('a//b/./c'), 'a/b/c')
  assert.equal(safeRel('a\\b'), 'a/b')
  assert.throws(() => safeRel('/abs'), /非法相对路径/)
  assert.throws(() => safeRel('C:/abs'), /非法相对路径/)
  assert.throws(() => safeRel('a/../b'), /不允许 .. 段/)
  assert.throws(() => safeRel(''), /非法相对路径/)
})

test('requireDirUnderBase enforces containment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-paths-'))
  try {
    const inside = join(root, 'inside')
    await mkdir(inside)
    const outside = await mkdtemp(join(tmpdir(), 'lw-outside-'))
    try {
      const real = await requireDirUnderBase(root, inside)
      assert.equal(real, inside)
      await assert.rejects(() => requireDirUnderBase(root, outside), /不在工作区根/)
      await assert.rejects(() => requireDirUnderBase(root, 'relative'), /必须是绝对路径/)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('assertNoSymlinkEscape rejects symlink in upload path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-symlink-'))
  try {
    const inside = join(root, 'inside')
    await mkdir(inside)
    const outside = await mkdtemp(join(tmpdir(), 'lw-symlink-outside-'))
    try {
      const link = join(root, 'link')
      await symlink(outside, link, 'dir')
      await writeFile(join(outside, 'secret.txt'), 'secret')
      await assert.rejects(() => assertNoSymlinkEscape(root, 'link/file.txt'), /symlink/)
      await assertNoSymlinkEscape(root, 'new/file.txt')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
