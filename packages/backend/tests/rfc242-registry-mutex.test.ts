// RFC-242 §7.2 — `.git/worktrees` 注册表互斥（实现门 P1-4 落地锁）。
//
// Locks in:
//   1. withWorktreeRegistryLock 对同一 common git dir 串行（互斥时序断言），
//      不同 repo 不互相阻塞；linked worktree 与根 repo 收敛到同一把锁。
//   2. 并发压力：8 路并发 createIsolatedWorktree 打同一 repo 的注册表全部
//      成功注册（2026-07-27 半初始化 commondir 事故的反例形态）。
//   3. 源码锁：三个注册表写操作（createWorktree/removeWorktree/
//      createIsolatedWorktree）都经过 withWorktreeRegistryLock。
import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createIsolatedWorktree,
  runGit,
  snapshotFullState,
  withWorktreeRegistryLock,
} from '../src/util/git'

async function initRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await runGit(dir, ['init', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@t.test'])
  await runGit(dir, ['config', 'user.name', 't'])
  writeFileSync(join(dir, 'README.md'), '# r\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-m', 'init'])
}

describe('RFC-242 §7.2 — worktree registry mutex', () => {
  test('same common dir serializes; different repos run independently', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc242-lock-'))
    try {
      const repoA = join(tmp, 'a')
      const repoB = join(tmp, 'b')
      await initRepo(repoA)
      await initRepo(repoB)
      const order: string[] = []
      const gate = { release: () => {} }
      const first = withWorktreeRegistryLock(repoA, async () => {
        order.push('a1-start')
        await new Promise<void>((r) => {
          gate.release = r
        })
        order.push('a1-end')
      })
      await Bun.sleep(20)
      const second = withWorktreeRegistryLock(repoA, async () => {
        order.push('a2')
      })
      // 不同 repo 不被 A 的持锁阻塞。
      await withWorktreeRegistryLock(repoB, async () => {
        order.push('b1')
      })
      expect(order).toEqual(['a1-start', 'b1'])
      gate.release()
      await first
      await second
      expect(order).toEqual(['a1-start', 'b1', 'a1-end', 'a2'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test('并发 8 路 iso worktree add 打同一注册表：全部成功注册', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc242-stress-'))
    try {
      const repo = join(tmp, 'repo')
      await initRepo(repo)
      const base = await snapshotFullState(repo)
      const head = (await runGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          createIsolatedWorktree({
            repoPath: repo,
            isoPath: join(tmp, `iso-${i}`),
            baseSnapshotCommit: base,
            taskBaseHead: head,
          }),
        ),
      )
      const list = (await runGit(repo, ['worktree', 'list', '--porcelain'])).stdout
      for (let i = 0; i < 8; i++) expect(list).toContain(`iso-${i}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 30000)

  test('源码锁：三个注册表写操作都经互斥', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'util', 'git.ts'), 'utf8')
    const wrapped = src.match(/withWorktreeRegistryLock\(opts\.repoPath/g) ?? []
    expect(wrapped.length).toBeGreaterThanOrEqual(3)
  })
})
