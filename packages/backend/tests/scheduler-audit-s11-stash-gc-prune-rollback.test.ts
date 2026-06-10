// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-11 (P1, WP-9)
//
// 当前缺陷行为（本文件全绿地锁定它）：
//   1. `gitStashSnapshot`（util/git.ts:763-769）产生的 stash commit 是 dangling
//      对象——没有任何 ref / reflog 钉住它（`git stash create` 不入 stash list，
//      全仓也没有建 refs/agent-workflow/snapshots/* 之类的轻量 ref）。一次
//      `git gc --prune=now`（或源仓里用户侧的自动 gc 过了 gc.pruneExpire 两周
//      宽限期）就把快照对象永久销毁。worktree 与源仓共享对象库，平台管不住
//      用户在源仓跑 gc。
//   2. `rollbackToSnapshot`（util/git.ts:786-801）的顺序是「先销毁后恢复」：
//      reset --hard → clean -fd → 最后才 stash apply。当快照对象已被 gc 回收，
//      apply 一步抛 `worktree-apply-failed`，但工作区已经被前两步清空——
//      pre-snapshot 时刻的未提交状态永久丢失，函数把已破坏的工作区留在原地。
//      调用方（task.ts:905-914、scheduler.ts:1529-1534、clarify.ts:432、
//      crossClarify.ts:782）全部 catch+warn 继续——用户看到「恢复成功」。
//
// 正确语义应是 fail-closed：回滚前先 `git cat-file -e <sha>` 验证快照对象存在，
//   不存在则不执行 reset/clean 直接报错；快照创建时建轻量 ref
//   （refs/agent-workflow/snapshots/{nodeRunId}）钉住对象，任务终态时清理。
//
// 修复落点：WP-9（快照 ref 钉住 + fail-closed 回滚）。修复时本文件应翻红：
//   - test 1：建 ref 后 gc 不再回收 → 按 [FLIP-ON-FIX] 翻转 cat-file 期望；
//   - test 2：fail-closed 后 reset/clean 不再执行 → 工作区脏状态应保留。
//
// 与既有覆盖的边界（勿重复）：git-snapshot.test.ts:87-92 已锁「未知 sha →
//   rejects worktree-apply-failed」，但 (a) 没有覆盖「真实快照被 gc 回收」这条
//   产品路径，(b) 没有断言 throw 发生时工作区已被 reset+clean 破坏（先销毁后
//   报错的「销毁」半边）。本文件只补这两个缺口。
//
// 确定性说明：纯本地 git 操作（init/commit/stash create/gc/reset），无网络、
//   无 clone、无 stash push/pop——不属于 8859a67 用 RUN_GIT_NETWORK 门控的
//   易抖形态（submodule file:// clone / npm / spawn 链），与同形态的
//   git-snapshot.test.ts 同样不加门控。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStashSnapshot, rollbackToSnapshot, runGit } from '../src/util/git'

interface Repo {
  path: string
  cleanup: () => void
}

async function buildRepo(): Promise<Repo> {
  const path = mkdtempSync(join(tmpdir(), 'aw-s11-gc-'))
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 'test@example.com'])
  await runGit(path, ['config', 'user.name', 'Test'])
  writeFileSync(join(path, 'a.txt'), 'original\n')
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-q', '-m', 'init'])
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

/** `git cat-file -e <sha>` — exitCode 0 iff the object exists in the odb. */
async function objectExists(repoPath: string, sha: string): Promise<boolean> {
  const r = await runGit(repoPath, ['cat-file', '-e', sha])
  return r.exitCode === 0
}

/** Expire reflogs + prune all unreachable objects immediately (what a user's
 * `git gc` does after gc.pruneExpire — collapsed to now for determinism). */
async function gcPruneNow(repoPath: string): Promise<void> {
  const expire = await runGit(repoPath, [
    'reflog',
    'expire',
    '--expire=now',
    '--expire-unreachable=now',
    '--all',
  ])
  expect(expire.exitCode).toBe(0)
  const gc = await runGit(repoPath, ['gc', '--prune=now', '--quiet'])
  expect(gc.exitCode).toBe(0)
}

describe('S-11 stash snapshot is a dangling object: gc destroys it; rollback destroys-then-fails (CURRENT-BEHAVIOR LOCK)', () => {
  let r: Repo
  beforeEach(async () => {
    r = await buildRepo()
  })
  afterEach(() => r.cleanup())

  test('snapshot sha is pinned by NO ref and a single gc --prune=now permanently destroys it', async () => {
    // Dirty tracked state at snapshot time → non-empty stash sha.
    writeFileSync(join(r.path, 'a.txt'), 'SNAPSHOT-STATE\n')
    const sha = await gitStashSnapshot(r.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)

    // Right after creation the commit object exists in the odb…
    expect(await objectExists(r.path, sha)).toBe(true)

    // …but NOTHING pins it: no ref of any kind points at it (this is the
    // mechanism that makes it gc-bait). The WP-9 fix should create
    // refs/agent-workflow/snapshots/{nodeRunId} here.
    // [FLIP-ON-FIX] WP-9: after ref-pinning lands, a ref containing the sha
    // must exist → flip this to expect the sha to appear in for-each-ref.
    const refs = await runGit(r.path, ['for-each-ref', '--format=%(objectname)'])
    expect(refs.exitCode).toBe(0)
    expect(refs.stdout.includes(sha)).toBe(false)
    const stashList = await runGit(r.path, ['stash', 'list'])
    expect(stashList.stdout.trim()).toBe('') // stash create never pushes to the list

    // One gc with pruning (any user-side gc past the 2-week pruneExpire — or
    // `--prune=now` — both end here) destroys the snapshot object for good.
    // [FLIP-ON-FIX] WP-9: with the pinning ref in place gc must NOT collect
    // the snapshot → flip to true.
    await gcPruneNow(r.path)
    expect(await objectExists(r.path, sha)).toBe(false)
  })

  test('rollbackToSnapshot against a gc-pruned snapshot: worktree is reset+cleaned FIRST, then apply fails — pre-snapshot uncommitted state permanently lost', async () => {
    // 1. Take a real snapshot of a dirty tree (the state we are supposed to be
    //    able to come back to — e.g. a long-parked task being resumed).
    writeFileSync(join(r.path, 'a.txt'), 'SNAPSHOT-STATE\n')
    const sha = await gitStashSnapshot(r.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)

    // 2. The snapshot object gets pruned (user ran gc in the shared-odb source
    //    repo / two weeks passed). 100% deterministic stand-in: gc --prune=now.
    await gcPruneNow(r.path)
    expect(await objectExists(r.path, sha)).toBe(false)

    // 3. Later state on disk: a failed attempt left tracked garbage + an
    //    untracked file. These are what reset --hard + clean -fd will eat.
    writeFileSync(join(r.path, 'a.txt'), 'POST-GC-GARBAGE\n')
    writeFileSync(join(r.path, 'junk.txt'), 'untracked\n')

    // 4. Roll back to the (now nonexistent) snapshot.
    //    CURRENT BEHAVIOR (util/git.ts:786-801): reset --hard HEAD and
    //    clean -fd both EXECUTE, then `stash apply <sha>` fails and the
    //    function throws worktree-apply-failed — destroy-before-restore.
    // [FLIP-ON-FIX] WP-9 fail-closed: the function must detect the missing
    //    object BEFORE touching the worktree → still rejects (new error code,
    //    e.g. snapshot-missing), but a.txt keeps 'POST-GC-GARBAGE\n' and
    //    junk.txt survives. Flip the three post-state assertions below.
    await expect(rollbackToSnapshot(r.path, sha)).rejects.toMatchObject({
      code: 'worktree-apply-failed',
    })

    // The destroy half already happened when the error surfaced:
    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('original\n') // reset --hard ran
    expect(existsSync(join(r.path, 'junk.txt'))).toBe(false) // clean -fd ran

    // And the restore half is impossible forever — the snapshot content
    // ('SNAPSHOT-STATE') is unrecoverable; this is the silent-data-loss the
    // callers' catch+warn (task.ts:905-914 / scheduler.ts:1529-1534) hides.
    expect(await objectExists(r.path, sha)).toBe(false)
  })
})
