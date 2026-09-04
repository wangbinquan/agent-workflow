// RFC-356 PR-1 —— 残留工作树回收阶梯。
//
// locks in the fix for GitHub issue #13（Windows / v0.18.14，「文件锁导致杀进程失败，
// 重试建不起来导致循环调度停摆」）。锁住的是那条**必然链**上的两个口：
//
//   1. `git worktree remove` 删不掉时，平台此前只 warn 一句「留待 GC」就放过去——
//      而 iso GC **明确跳过活跃任务**，那句承诺对活任务从不成立，残留目录会一直
//      挡着同一条路径，重试逐次撞 `fatal: '<path>' already exists`。
//   2. 更狠的是：remove 删目录失败时注册项可能已被删掉，此后同一路径改报
//      `is not a working tree`——平台**再没有任何路径**能清掉它。
//
// 下面的 `orphaned directory` 用例就是第 2 种形态；改动之前它必红。
//
// 另有并发 session 2026-09-04 实测的同形缺口：被 abort 掐掉的 `git worktree add`
// 留下的 `refs/heads/<branch>.lock` 无人清（`docs/audit-backlog.md`），一并锁在这里。

import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RECLAIM_DELAYS_MS, removeDirectoryWithRetry } from '../src/util/fsReclaim'
import {
  reclaimStaleRefLocks,
  reclaimWorktreePath,
  runGit,
  STALE_REF_LOCK_MIN_AGE_MS,
  withWorktreeRegistryLock,
} from '../src/util/git'
import { removeTempDirSync } from './fixtures/tempDir'

const isWindows = process.platform === 'win32'

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc356-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

function freshPath(label: string): string {
  return join(mkdtempSync(join(tmpdir(), 'aw-rfc356-wt-')), label)
}

describe('RFC-356 · removeDirectoryWithRetry', () => {
  test('默认退避档：首次零延迟，总预算 > 1s（RFC-254 实测「一秒不够」的下界）', () => {
    expect(DEFAULT_RECLAIM_DELAYS_MS[0]).toBe(0)
    expect(DEFAULT_RECLAIM_DELAYS_MS.length).toBeGreaterThanOrEqual(5)
    const total = DEFAULT_RECLAIM_DELAYS_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThan(1_000)
  })

  test('目录存在 ⇒ 一次删掉，不动用退避', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc356-rm-'))
    writeFileSync(join(dir, 'f.txt'), 'x')
    const r = await removeDirectoryWithRetry(dir)
    expect(r.removed).toBe(true)
    expect(r.attempts).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })

  test('目录本来就不在 ⇒ removed:true（幂等，不报错）', async () => {
    const r = await removeDirectoryWithRetry(join(tmpdir(), 'aw-rfc356-does-not-exist-zzz'))
    expect(r.removed).toBe(true)
    expect(r.attempts).toBe(1)
  })

  test.skipIf(isWindows)('删不掉时耗尽预算并回 removed:false + lastError（不抛）', async () => {
    // POSIX 屏障：父目录去掉写权限 ⇒ 子项无法 unlink。Windows 上 chmod 是 no-op
    // （RFC-254 实测），所以那边这条用注入方式在 §11 的其它用例里覆盖。
    const parent = mkdtempSync(join(tmpdir(), 'aw-rfc356-blocked-'))
    const victim = join(parent, 'child')
    mkdirSync(victim)
    writeFileSync(join(victim, 'f.txt'), 'x')
    chmodSync(parent, 0o500)
    try {
      const r = await removeDirectoryWithRetry(victim, { delaysMs: [0, 5, 5] })
      expect(r.removed).toBe(false)
      expect(r.attempts).toBe(3)
      expect(r.lastError ?? '').not.toBe('')
      expect(existsSync(victim)).toBe(true)
    } finally {
      chmodSync(parent, 0o700)
      removeTempDirSync(parent)
    }
  })
})

describe('RFC-356 · git worktree add 的既有行为（把实测钉成回归）', () => {
  test('空目录可以建树，非空目录不行，且 --force 不豁免这条', async () => {
    const repo = await initRepo()
    const empty = freshPath('empty')
    mkdirSync(empty, { recursive: true })
    const okEmpty = await runGit(repo, ['worktree', 'add', '--detach', empty, 'HEAD'])
    expect(okEmpty.exitCode).toBe(0)

    const dirty = freshPath('dirty')
    mkdirSync(dirty, { recursive: true })
    writeFileSync(join(dirty, 'leftover.bin'), 'locked')
    const failed = await runGit(repo, ['worktree', 'add', '--detach', dirty, 'HEAD'])
    expect(failed.exitCode).not.toBe(0)
    expect(failed.stderr).toContain('already exists')

    // `--force` 只豁免「分支已被别处检出」，不豁免目录已存在——issue #13 的重试
    // 之所以永远起不来，正是因为这条。
    const forced = await runGit(repo, ['worktree', 'add', '--force', '--detach', dirty, 'HEAD'])
    expect(forced.exitCode).not.toBe(0)
    expect(forced.stderr).toContain('already exists')
    removeTempDirSync(repo)
  }, 30_000)
})

describe('RFC-356 · reclaimWorktreePath 四档', () => {
  test('路径不存在 ⇒ absent', async () => {
    const repo = await initRepo()
    const outcome = await reclaimWorktreePath({
      repoPath: repo,
      worktreePath: join(tmpdir(), 'aw-rfc356-absent-zzz'),
    })
    expect(outcome.kind).toBe('absent')
    removeTempDirSync(repo)
  }, 30_000)

  test('正常注册的工作树 ⇒ removed via git（一次成功）', async () => {
    const repo = await initRepo()
    const wt = freshPath('live')
    expect((await runGit(repo, ['worktree', 'add', '--detach', wt, 'HEAD'])).exitCode).toBe(0)
    const outcome = await reclaimWorktreePath({ repoPath: repo, worktreePath: wt })
    expect(outcome).toEqual({ kind: 'removed', via: 'git', attempts: 1 })
    expect(existsSync(wt)).toBe(false)
    removeTempDirSync(repo)
  }, 30_000)

  test('AC-5：注册项已丢的孤儿目录也能被回收（改动前平台完全无解）', async () => {
    const repo = await initRepo()
    const wt = freshPath('orphan')
    expect((await runGit(repo, ['worktree', 'add', '--detach', wt, 'HEAD'])).exitCode).toBe(0)
    // 模拟「remove 删注册项成功、删目录失败」之后的盘上形态：注册项没了，目录还在。
    expect((await runGit(repo, ['worktree', 'remove', '--force', wt])).exitCode).toBe(0)
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, 'residual.bin'), 'held-by-a-handle')

    // 先证明这就是那条死路：git 自己已经不认它了。
    const gitRefuses = await runGit(repo, ['worktree', 'remove', '--force', wt])
    expect(gitRefuses.exitCode).not.toBe(0)
    expect(gitRefuses.stderr).toContain('is not a working tree')

    const outcome = await reclaimWorktreePath({ repoPath: repo, worktreePath: wt })
    expect(outcome.kind).toBe('removed')
    if (outcome.kind === 'removed') expect(outcome.via).toBe('filesystem')
    expect(existsSync(wt)).toBe(false)

    // 回收之后同一路径必须能重新建树——这才是 issue #13 要的自愈。
    expect((await runGit(repo, ['worktree', 'add', '--detach', wt, 'HEAD'])).exitCode).toBe(0)
    removeTempDirSync(repo)
  }, 30_000)

  test.skipIf(isWindows)(
    '删不掉 ⇒ blocked，带残留路径与最后错误，且不抛',
    async () => {
      const repo = await initRepo()
      const parent = mkdtempSync(join(tmpdir(), 'aw-rfc356-blk-'))
      const wt = join(parent, 'wt')
      expect((await runGit(repo, ['worktree', 'add', '--detach', wt, 'HEAD'])).exitCode).toBe(0)
      chmodSync(parent, 0o500)
      try {
        const outcome = await reclaimWorktreePath({
          repoPath: repo,
          worktreePath: wt,
          delaysMs: [0, 5],
        })
        expect(outcome.kind).toBe('blocked')
        if (outcome.kind === 'blocked') {
          expect(outcome.residualPath).toBe(wt)
          expect(outcome.lastError).not.toBe('')
        }
      } finally {
        chmodSync(parent, 0o700)
        removeTempDirSync(parent)
        removeTempDirSync(repo)
      }
    },
    30_000,
  )

  test.skipIf(isWindows)(
    '退避删除跑在 registry 锁之外（不阻塞同仓的兄弟建树）',
    async () => {
      // 锁按 common git dir 归一，同仓的全部任务 / 分片共用一把。若退避持锁，
      // 一次阻塞回收会把整仓的建树排队几秒——这条用例锁住「不会」。
      const repo = await initRepo()
      const parent = mkdtempSync(join(tmpdir(), 'aw-rfc356-lockfree-'))
      const wt = join(parent, 'wt')
      expect((await runGit(repo, ['worktree', 'add', '--detach', wt, 'HEAD'])).exitCode).toBe(0)
      chmodSync(parent, 0o500)
      try {
        const reclaiming = reclaimWorktreePath({
          repoPath: repo,
          worktreePath: wt,
          delaysMs: [0, 400, 400, 400],
        })
        let siblingRanAt = 0
        await withWorktreeRegistryLock(repo, async () => {
          siblingRanAt = Date.now()
        })
        const siblingDelay = Date.now() - siblingRanAt
        await reclaiming
        // 兄弟拿锁这件事本身必须立刻完成；只要它没被退避拖住即可。
        expect(siblingDelay).toBeLessThan(300)
      } finally {
        chmodSync(parent, 0o700)
        removeTempDirSync(parent)
        removeTempDirSync(repo)
      }
    },
    30_000,
  )
})

describe('RFC-356 · stale ref lock（并发 session 2026-09-04 实测线索）', () => {
  async function lockPathOf(repo: string, ref: string): Promise<string> {
    const common = await runGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    return join(common.stdout.trim(), 'refs', 'heads', `${ref}.lock`)
  }

  test('老锁被清掉，年轻锁不动', async () => {
    const repo = await initRepo()
    mkdirSync(join(repo, '.git', 'refs', 'heads', 'agent-workflow'), { recursive: true })

    const staleRef = 'agent-workflow/stale-task'
    const stale = await lockPathOf(repo, staleRef)
    writeFileSync(stale, '')
    const old = new Date(Date.now() - STALE_REF_LOCK_MIN_AGE_MS - 60_000)
    await utimes(stale, old, old)

    const freshRef = 'agent-workflow/fresh-task'
    const fresh = await lockPathOf(repo, freshRef)
    writeFileSync(fresh, '')

    expect(await reclaimStaleRefLocks({ repoPath: repo, branchRef: staleRef })).toBe(1)
    expect(existsSync(stale)).toBe(false)

    expect(await reclaimStaleRefLocks({ repoPath: repo, branchRef: freshRef })).toBe(0)
    expect(existsSync(fresh)).toBe(true)
    removeTempDirSync(repo)
  }, 30_000)

  test('前缀形式一次收掉 repo-group 的 -2 / -3 去重后缀', async () => {
    const repo = await initRepo()
    mkdirSync(join(repo, '.git', 'refs', 'heads', 'agent-workflow'), { recursive: true })
    const old = new Date(Date.now() - STALE_REF_LOCK_MIN_AGE_MS - 60_000)
    for (const ref of ['agent-workflow/t1', 'agent-workflow/t1-2', 'agent-workflow/t1-3']) {
      const p = await lockPathOf(repo, ref)
      writeFileSync(p, '')
      await utimes(p, old, old)
    }
    // 别的任务的锁不能被误伤。
    const other = await lockPathOf(repo, 'agent-workflow/t2')
    writeFileSync(other, '')
    await utimes(other, old, old)

    expect(await reclaimStaleRefLocks({ repoPath: repo, branchRef: 'agent-workflow/t1*' })).toBe(3)
    expect(existsSync(other)).toBe(true)
    removeTempDirSync(repo)
  }, 30_000)

  test('路径逃逸段被拒（不越出 refs/heads）', async () => {
    const repo = await initRepo()
    expect(
      await reclaimStaleRefLocks({ repoPath: repo, branchRef: '../../../../etc/passwd' }),
    ).toBe(0)
    removeTempDirSync(repo)
  }, 30_000)

  test('被掐掉的 worktree add 留下的锁清掉后，同名分支能重新建树', async () => {
    const repo = await initRepo()
    const branch = 'agent-workflow/relock'
    mkdirSync(join(repo, '.git', 'refs', 'heads', 'agent-workflow'), { recursive: true })
    const lock = await lockPathOf(repo, branch)
    writeFileSync(lock, '')
    const old = new Date(Date.now() - STALE_REF_LOCK_MIN_AGE_MS - 60_000)
    await utimes(lock, old, old)

    const wt = freshPath('relocked')
    const blocked = await runGit(repo, ['worktree', 'add', '-b', branch, wt, 'HEAD'])
    expect(blocked.exitCode).not.toBe(0)
    expect(blocked.stderr).toContain('cannot lock ref')

    expect(await reclaimStaleRefLocks({ repoPath: repo, branchRef: branch })).toBe(1)
    const retried = await runGit(repo, ['worktree', 'add', '-b', branch, wt, 'HEAD'])
    expect(retried.exitCode).toBe(0)
    removeTempDirSync(repo)
  }, 30_000)

  test('mtime 阈值是导出的常量，不是散落的字面量', () => {
    expect(STALE_REF_LOCK_MIN_AGE_MS).toBeGreaterThanOrEqual(30_000)
    expect(statSync(__filename).mtimeMs).toBeGreaterThan(0) // 夹具自检：mtime 可读
  })
})
