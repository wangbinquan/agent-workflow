// POSITIVE GUARD — design/scheduler-audit-2026-06-10.md S-11 (P1, WP-9),
// fixed by RFC-098 B2 (design.md §B2-WP-9 + 修订#3). This file was the
// CURRENT-BEHAVIOR LOCK for the pre-fix defect and has been FLIPPED per its
// own [FLIP-ON-FIX] markers:
//
//   1. `gitStashSnapshot(path, {pinRef})` now pins the stash commit with a
//      lightweight ref (`refs/agent-workflow/snapshots/{taskId}/{nodeRunId}`
//      via `snapshotRefName`) so a user-side `git gc --prune=now` in the
//      shared source-repo odb can no longer destroy the snapshot object.
//      The BARE call (no pinRef) intentionally keeps the historical dangling
//      behavior — the contrast assertion below locks that the pin is opt-in
//      and the mechanism (ref reachability) is what protects the object.
//   2. `rollbackToSnapshot` is now fail-closed: a non-empty sha is verified
//      with `cat-file -e <sha>^{commit}` BEFORE reset --hard / clean -fd.
//      A gc-pruned snapshot → rejects 'snapshot-missing' and the worktree is
//      left byte-for-byte untouched (the old order destroyed first and threw
//      'worktree-apply-failed' after, losing the dirty state forever).
//
// 与既有覆盖的边界（勿重复）：git-snapshot.test.ts 锁「未知 sha →
//   rejects snapshot-missing 且工作区未动」（合成 sha 路径）；本文件覆盖
//   「真实快照被 gc 回收」这条产品路径 + ref 钉住的 gc 存活性。
//   端到端（scheduler 写点 pin / gc.ts 删 ref / resume 升级）见
//   rfc098-snapshot-pin.test.ts 与 resume-task-idempotent.test.ts R8b。
//
// 确定性说明：纯本地 git 操作（init/commit/stash create/gc/reset），无网络、
//   无 clone、无 stash push/pop——不属于 8859a67 用 RUN_GIT_NETWORK 门控的
//   易抖形态（submodule file:// clone / npm / spawn 链），与同形态的
//   git-snapshot.test.ts 同样不加门控。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStashSnapshot, rollbackToSnapshot, runGit, snapshotRefName } from '../src/util/git'

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

describe('S-11 fixed (RFC-098 WP-9): pinRef keeps the snapshot alive across gc; rollback is fail-closed on a pruned snapshot', () => {
  let r: Repo
  beforeEach(async () => {
    r = await buildRepo()
  })
  afterEach(() => r.cleanup())

  test('pinRef pins the snapshot sha with a ref and gc --prune=now no longer destroys it; a BARE call stays dangling (contrast)', async () => {
    // Dirty tracked state at snapshot time → non-empty stash sha, pinned.
    writeFileSync(join(r.path, 'a.txt'), 'SNAPSHOT-STATE\n')
    const pinRef = snapshotRefName('task-1', 'run-1')
    const sha = await gitStashSnapshot(r.path, { pinRef })
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    expect(await objectExists(r.path, sha)).toBe(true)

    // [FLIPPED] WP-9: the pinning ref exists and points at the snapshot sha.
    const refs = await runGit(r.path, ['for-each-ref', '--format=%(refname) %(objectname)'])
    expect(refs.exitCode).toBe(0)
    expect(refs.stdout).toContain(`${pinRef} ${sha}`)
    const stashList = await runGit(r.path, ['stash', 'list'])
    expect(stashList.stdout.trim()).toBe('') // stash create still never pushes to the list

    // Contrast: a bare call (no pinRef) over a DIFFERENT dirty state stays a
    // dangling object — the historical gc-bait shape, now opt-out via pinRef.
    writeFileSync(join(r.path, 'a.txt'), 'UNPINNED-STATE\n')
    const bareSha = await gitStashSnapshot(r.path)
    expect(bareSha).toMatch(/^[a-f0-9]{40}$/)
    expect(bareSha).not.toBe(sha)
    const refsAfterBare = await runGit(r.path, ['for-each-ref', '--format=%(objectname)'])
    expect(refsAfterBare.stdout.includes(bareSha)).toBe(false)

    // [FLIPPED] WP-9: gc with pruning keeps the PINNED snapshot (ref-reachable)
    // and collects the bare one (dangling) — the ref is what protects it.
    await gcPruneNow(r.path)
    expect(await objectExists(r.path, sha)).toBe(true)
    expect(await objectExists(r.path, bareSha)).toBe(false)
  })

  test('rollbackToSnapshot against a gc-pruned snapshot: fail-closed — rejects snapshot-missing BEFORE reset/clean, worktree byte-for-byte untouched', async () => {
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
    //    untracked file. Pre-fix these were eaten by reset --hard + clean -fd
    //    before the missing object was even noticed.
    writeFileSync(join(r.path, 'a.txt'), 'POST-GC-GARBAGE\n')
    writeFileSync(join(r.path, 'junk.txt'), 'untracked\n')

    // 4. [FLIPPED] WP-9 fail-closed: the missing object is detected up front
    //    (`cat-file -e <sha>^{commit}`) → rejects with the NEW code
    //    'snapshot-missing' and the destructive half never runs.
    await expect(rollbackToSnapshot(r.path, sha)).rejects.toMatchObject({
      code: 'snapshot-missing',
    })

    // Worktree untouched: tracked garbage survives (no reset --hard) and the
    // untracked file survives (no clean -fd).
    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('POST-GC-GARBAGE\n')
    expect(existsSync(join(r.path, 'junk.txt'))).toBe(true)

    // The snapshot itself is still gone — fail-closed protects the worktree,
    // it cannot resurrect the pruned object.
    expect(await objectExists(r.path, sha)).toBe(false)
  })
})
