import { rimrafDir } from './helpers/cleanup'
// RFC-065 T2 — services/worktreeFiles.ts unit coverage.
//
// Uses a real tmpdir so the symlink + ENAMETOOLONG paths actually exercise
// the OS, not a mock. Each test seeds a tiny tree under a fresh worktree
// root and asserts list / read behaviour.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { copyFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  listWorktreeDir,
  readWorktreeFile,
  WORKTREE_DIR_MAX_ENTRIES,
  WORKTREE_FILE_MAX_BYTES,
} from '../src/services/worktreeFiles'
import { isWindows } from './helpers/stub-runtime'

const canSymlink = isWindows
  ? (() => {
      try {
        const d = mkdirSync(join(tmpdir(), 'aw-symlink-probe-'), { recursive: true }) as string
        symlinkSync(join(d, 'x'), join(d, 'y'), 'file')
        rimrafDir(d)
        return true
      } catch {
        return false
      }
    })()
  : true

/**
 * Create a symlink, using junction for directories on Windows (no developer mode needed).
 * For file symlinks on Windows, falls back to copy if symlinks are unavailable.
 */
async function createSymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir' = 'file',
): Promise<void> {
  if (isWindows) {
    if (type === 'dir') {
      // Junctions don't need developer mode on Windows
      await symlink(target, linkPath, 'junction')
    } else if (canSymlink) {
      await symlink(target, linkPath, 'file')
    } else {
      // File symlinks unavailable on Windows without developer mode;
      // copy the file as a fallback (caller should check canSymlink first
      // for security tests where symlink semantics matter).
      await copyFile(target, linkPath)
    }
  } else {
    await symlink(target, linkPath, type)
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rfc065-worktree-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('listWorktreeDir', () => {
  test('empty root → empty entries, not truncated', async () => {
    const res = await listWorktreeDir(root, '')
    expect(res.entries).toEqual([])
    expect(res.truncated).toBe(false)
  })

  test('files: name + kind + size correct', async () => {
    await writeFile(join(root, 'a.txt'), 'hello')
    await writeFile(join(root, 'b.txt'), 'longer body')
    const res = await listWorktreeDir(root, '')
    expect(res.entries).toEqual([
      { name: 'a.txt', kind: 'file', size: 5 },
      { name: 'b.txt', kind: 'file', size: 11 },
    ])
  })

  test('directories sort before files; alpha within each group', async () => {
    await mkdir(join(root, 'zzz'))
    await mkdir(join(root, 'apple'))
    await writeFile(join(root, 'README.md'), 'r')
    await writeFile(join(root, 'app.ts'), 'a')
    const res = await listWorktreeDir(root, '')
    expect(res.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'directory:apple',
      'directory:zzz',
      'file:app.ts',
      'file:README.md',
    ])
  })

  test('.git directory hidden at every layer', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main')
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', '.git'), 'gitdir: ../.git/worktrees/sub')
    const rootRes = await listWorktreeDir(root, '')
    expect(rootRes.entries.map((e) => e.name)).not.toContain('.git')
    const subRes = await listWorktreeDir(root, 'sub')
    expect(subRes.entries.map((e) => e.name)).not.toContain('.git')
  })

  test('truncates beyond WORKTREE_DIR_MAX_ENTRIES', async () => {
    const limit = WORKTREE_DIR_MAX_ENTRIES
    // create limit + 7 files; size kept tiny to keep test fast.
    const writes: Promise<unknown>[] = []
    for (let i = 0; i < limit + 7; i += 1) {
      writes.push(writeFile(join(root, `f-${String(i).padStart(5, '0')}.txt`), 'x'))
    }
    await Promise.all(writes)
    const res = await listWorktreeDir(root, '')
    expect(res.entries.length).toBe(limit)
    expect(res.truncated).toBe(true)
    // sort prefix preserved
    expect(res.entries[0]?.name).toBe('f-00000.txt')
  })

  test('symlink inside worktree is listed with target kind', async () => {
    await mkdir(join(root, 'real'))
    await writeFile(join(root, 'real', 'file.txt'), 'x')
    // Directory symlink: use junction on Windows (no developer mode needed)
    await createSymlink(join(root, 'real'), join(root, 'linkdir'), 'dir')
    // File symlink: skip on Windows if symlinks unavailable
    if (canSymlink) {
      await createSymlink(join(root, 'real', 'file.txt'), join(root, 'linkfile'), 'file')
    }
    const res = await listWorktreeDir(root, '')
    const byName = new Map(res.entries.map((e) => [e.name, e]))
    expect(byName.get('linkdir')?.kind).toBe('directory')
    if (canSymlink) {
      expect(byName.get('linkfile')?.kind).toBe('file')
    }
  })

  test('symlink pointing outside worktree is silently skipped', async () => {
    // On Windows, file symlinks need developer mode; if unavailable, the
    // security guarantee still exists in the code — just skip the test case.
    if (!canSymlink) return
    const outside = await mkdtemp(join(tmpdir(), 'rfc065-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'leak')
      await symlink(join(outside, 'secret.txt'), join(root, 'evil'))
      const res = await listWorktreeDir(root, '')
      expect(res.entries.map((e) => e.name)).not.toContain('evil')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test('relative subdirectory path lists children only', async () => {
    await mkdir(join(root, 'pkg'))
    await writeFile(join(root, 'pkg', 'x.ts'), 'x')
    const res = await listWorktreeDir(root, 'pkg')
    expect(res.entries).toEqual([{ name: 'x.ts', kind: 'file', size: 1 }])
  })

  test('absolute path rejected as ValidationError', async () => {
    let err: unknown = null
    try {
      await listWorktreeDir(root, '/etc')
    } catch (e) {
      err = e
    }
    expect((err as Error)?.message).toContain('relative')
  })

  test('path traversal via .. rejected', async () => {
    let err: unknown = null
    try {
      await listWorktreeDir(root, '../../etc')
    } catch (e) {
      err = e
    }
    expect((err as Error)?.message).toContain('escapes')
  })

  test('non-existent path → 404 NotFound', async () => {
    let err: unknown = null
    try {
      await listWorktreeDir(root, 'does/not/exist')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe('worktree-dir-not-found')
  })

  test('path is a file (not a directory) → 404 with specific code', async () => {
    await writeFile(join(root, 'just-a-file.txt'), 'x')
    let err: unknown = null
    try {
      await listWorktreeDir(root, 'just-a-file.txt')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe('worktree-dir-not-a-directory')
  })
})

describe('readWorktreeFile', () => {
  test('small file returns content + size, oversized:false', async () => {
    await writeFile(join(root, 'hello.txt'), 'hello world')
    const res = await readWorktreeFile(root, 'hello.txt')
    expect(res).toEqual({ size: 11, oversized: false, content: 'hello world' })
  })

  test('file > 2 MiB → oversized:true with real size, content empty', async () => {
    const bigPath = join(root, 'big.bin')
    const big = Buffer.alloc(WORKTREE_FILE_MAX_BYTES + 1024, 'A')
    await writeFile(bigPath, big)
    const res = await readWorktreeFile(root, 'big.bin')
    expect(res.oversized).toBe(true)
    expect(res.size).toBe(big.length)
    expect(res.content).toBe('')
  })

  test('file at exactly 2 MiB still returned (boundary)', async () => {
    const exact = Buffer.alloc(WORKTREE_FILE_MAX_BYTES, 0x42)
    await writeFile(join(root, 'exact.bin'), exact)
    const res = await readWorktreeFile(root, 'exact.bin')
    expect(res.oversized).toBe(false)
    expect(res.size).toBe(WORKTREE_FILE_MAX_BYTES)
  })

  test('invalid UTF-8 bytes replaced with U+FFFD (no throw)', async () => {
    // Lone continuation byte 0xC3 0x28 is invalid UTF-8.
    await writeFile(join(root, 'bad.txt'), Buffer.from([0xc3, 0x28, 0x41]))
    const res = await readWorktreeFile(root, 'bad.txt')
    expect(res.oversized).toBe(false)
    expect(res.content).toContain('�')
  })

  test('non-existent file → NotFoundError', async () => {
    let err: unknown = null
    try {
      await readWorktreeFile(root, 'missing.txt')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe('worktree-file-not-found')
  })

  test('directory path → NotFoundError("not-a-file")', async () => {
    await mkdir(join(root, 'd'))
    let err: unknown = null
    try {
      await readWorktreeFile(root, 'd')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe('worktree-file-not-a-file')
  })

  test('empty relPath → ValidationError', async () => {
    let err: unknown = null
    try {
      await readWorktreeFile(root, '')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string }).code).toBe('worktree-file-missing-path')
  })

  test('symlink targeting outside worktree → ValidationError', async () => {
    // On Windows, file symlinks need developer mode; if unavailable, the
    // security guarantee still exists in the code — just skip the test case.
    if (!canSymlink) return
    const outside = await mkdtemp(join(tmpdir(), 'rfc065-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'leak')
      await symlink(join(outside, 'secret.txt'), join(root, 'evil'))
      let err: unknown = null
      try {
        await readWorktreeFile(root, 'evil')
      } catch (e) {
        err = e
      }
      expect((err as { code?: string }).code).toBe('worktree-file-symlink-escapes')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})
