import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildZip, collectFiles, crc32 } from '../lib/zip.js'

test('crc32 matches known value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('collectFiles enforces maxFiles per file and allows exact limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-zip-'))
  try {
    await writeFile(join(dir, 'a.txt'), 'a')
    await writeFile(join(dir, 'b.txt'), 'b')
    await assert.rejects(() => collectFiles(dir, 1, 1024), /文件数超过上限/)
    const files = await collectFiles(dir, 2, 1024)
    assert.equal(files.length, 2)
    assert.deepEqual(files.map(file => file.rel), ['a.txt', 'b.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectFiles enforces total bytes and skips symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-zip-'))
  const outside = await mkdtemp(join(tmpdir(), 'lw-zip-outside-'))
  try {
    await writeFile(join(dir, 'a.txt'), 'a')
    await writeFile(join(dir, 'b.txt'), 'bb')
    await assert.rejects(() => collectFiles(dir, 10, 2), /总大小超过上限/)

    const link = join(dir, 'link.txt')
    await symlink(join(outside, 'secret.txt'), link, 'file')
    await writeFile(join(outside, 'secret.txt'), 'secret')
    const files = await collectFiles(dir, 10, 1024)
    assert.deepEqual(files.map(file => file.rel), ['a.txt', 'b.txt'])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('buildZip produces a zip with local and central headers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lw-zip-'))
  try {
    await writeFile(join(dir, 'a.txt'), 'hello')
    const files = await collectFiles(dir, 10, 1024)
    const zip = await buildZip(files)
    assert.equal(zip.readUInt32LE(0), 0x04034b50)
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50)
    assert.ok(zip.includes(Buffer.from('a.txt')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
