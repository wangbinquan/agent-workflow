// RFC-210 实现门 A1-fix — 子仓回写失败必须硬失败，红→绿锁。
//
// Codex 实现门（design/RFC-210-recursive-submodule-isolation/codex-impl-gate-2026-07-22.md
// critical #1）实测出的链条：`snapshotNodeIsoFinal → publishSubmoduleHeads` 里
// 子仓 `add` 失败没有处理、`commit` 失败与 `pushObjectsToPool` 失败都只记
// warning 后继续。父仓快照只记 gitlink，于是 hook 拒绝 / 索引损坏 / 池损坏时脏
// 内容完全进不了 node tree，merge-back 照样报 clean，随后 `discardNodeIso` 把
// **唯一副本**（iso worktree + 它私有的 module dir）删掉。对象回写失败的变体则
// 在 node ref 清理后被 pool gc 收割成 `bad object`。
//
// 修法：status/add/commit/rev-parse/ensure-pool/publish/回读校验/wt 锚任一失败
// 都抛错（settle 标 merge-failed，node 失败，iso 保留）；merge 侧的 worktree
// 锚失败同样抛错。scheduler 主线的 merge-back catch 补 `keepIso = true`（源码
// 级断言兜底——完整 scheduler 集成太重，锁住"catch 里保留 iso"这一行为承诺）。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '@/services/nodeIsolation'
import { runGit } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-pf-home-'))
const created: string[] = []

// Must be set in THIS file: `bun test` shares one process locally (so a sibling
// file's setting leaks and everything looks green) while CI runs --isolate.
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-pf-gitcfg-'))

beforeAll(() => {
  const cfg = join(gitCfgDir, 'gitconfig')
  writeFileSync(cfg, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@e.com\n')
  prevGitGlobal = process.env.GIT_CONFIG_GLOBAL
  process.env.GIT_CONFIG_GLOBAL = cfg
})

afterAll(() => {
  if (prevGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = prevGitGlobal
  rmSync(gitCfgDir, { recursive: true, force: true })
  for (const d of created) rmSync(d, { recursive: true, force: true })
  rmSync(appHome, { recursive: true, force: true })
})

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  created.push(d)
  return d
}

async function initRepo(dir: string, file: string, content: string): Promise<void> {
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  writeFileSync(join(dir, file), content)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
}

async function commitIn(dir: string, msg: string): Promise<string> {
  await runGit(dir, ['add', '-A'])
  await runGit(dir, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', msg])
  return (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

function canonRepo(dir: string): CanonRepo {
  return { repoPath: dir, worktreePath: dir, worktreeDirName: '', baseBranch: 'main' }
}

const ADD = ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q'] as const

/** host + canonical worktree with one initialized submodule `vendor`. */
async function fixture(tag: string): Promise<{ canon: string }> {
  const sub = tmp(`aw-rfc210-pf-${tag}-sub-`)
  await initRepo(sub, 'a.txt', 'v1\n')
  const host = tmp(`aw-rfc210-pf-${tag}-host-`)
  await initRepo(host, 'README.md', 'root\n')
  await runGit(host, [...ADD, sub, 'vendor'])
  await runGit(host, ['commit', '-q', '-m', 'add vendor'])
  const canon = join(tmp(`aw-rfc210-pf-${tag}-wt-`), 'canon')
  await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
  return { canon }
}

describe('RFC-210 — submodule publish failures fail the snapshot', () => {
  test('a commit hook rejecting the auto-commit throws instead of clean-settling', async () => {
    const { canon } = await fixture('hook')
    const handle = await createNodeIso({
      appHome,
      taskId: 'tpf1',
      nodeRunId: 'rpf1',
      canonRepos: [canonRepo(canon)],
    })
    const isoVendor = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    // The node leaves uncommitted work in the submodule; the platform's
    // auto-commit is rejected by a pre-commit hook (an everyday setup).
    writeFileSync(join(isoVendor, 'a.txt'), 'dirty-agent-work\n')
    const gitDir = (await runGit(isoVendor, ['rev-parse', '--absolute-git-dir'])).stdout.trim()
    const hook = join(gitDir, 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n')
    chmodSync(hook, 0o755)

    // Before the fix this resolved cleanly: the failure was a warn, the parent
    // snapshot recorded the OLD gitlink, merge-back reported clean, and the
    // discard deleted the only copy of `dirty-agent-work`.
    await expect(snapshotNodeIsoFinal(handle)).rejects.toThrow(/submodule publish failed .*commit/)
    // The work is still there for the kept iso (nothing destroyed by failing).
    expect(readFileSync(join(isoVendor, 'a.txt'), 'utf8')).toBe('dirty-agent-work\n')
  }, 120_000)

  test('a blocked pool anchor fails the publish loudly instead of warn-and-continue', async () => {
    const { canon } = await fixture('pool')
    const handle = await createNodeIso({
      appHome,
      taskId: 'tpf2',
      nodeRunId: 'rpf2',
      canonRepos: [canonRepo(canon)],
    })
    const pool = handle.repos[0]!.poolDirs['vendor']
    expect(pool).toBeDefined()
    // A ref at the node anchor's PARENT path makes the publish's `update-ref`
    // fail deterministically (D/F conflict) — standing in for ref lock
    // contention, disk and permission failures. (Deleting pool dirs instead
    // does NOT work as a sabotage: gitdir discovery walks up and lands the
    // fetch in the HOST repo, which succeeds.)
    const base = (await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()
    await runGit(pool!, ['update-ref', 'refs/agent-workflow/pool/tpf2', base])
    expect(
      (await runGit(pool!, ['rev-parse', '--verify', 'refs/agent-workflow/pool/tpf2'])).exitCode,
    ).toBe(0)

    await expect(snapshotNodeIsoFinal(handle)).rejects.toThrow(/submodule publish failed .*publish/)
  }, 120_000)

  test('a blocked worktree anchor fails the merge instead of landing a gc-orphan', async () => {
    const { canon } = await fixture('anchor')
    const handle = await createNodeIso({
      appHome,
      taskId: 'tpf3',
      nodeRunId: 'rpf3',
      canonRepos: [canonRepo(canon)],
    })
    // The blocking value must be a sha the POOL already has — the base commit
    // qualifies.
    const base = (await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()
    // The node moves the submodule; even the trivial take-theirs result MUST be
    // anchored (the node-scoped ref dies with the iso), so this reaches the
    // worktree-anchor write without needing a canonical-side advance.
    const isoVendor = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(isoVendor, 'b.txt'), 'node-line\n')
    await commitIn(isoVendor, 'node advance')

    // A ref at the anchor's PARENT path makes `update-ref` fail (D/F conflict)
    // — standing in for lock contention / permission failures.
    const pool = handle.repos[0]!.poolDirs['vendor']!
    await runGit(pool, ['update-ref', 'refs/agent-workflow/wt/tpf3', base])
    expect(
      (await runGit(pool, ['rev-parse', '--verify', 'refs/agent-workflow/wt/tpf3'])).exitCode,
    ).toBe(0)

    const trees = await snapshotNodeIsoFinal(handle)
    // Before the fix the anchor failure was a warn; the merged gitlink landed
    // held only by node-scoped refs, and the first pool gc after discard turned
    // canonical's submodule into `bad object HEAD`.
    await expect(mergeBackNodeIso(handle, trees)).rejects.toThrow(/worktree anchor failed/)
  }, 120_000)

  test('scheduler keeps the iso when merge-back throws (source-level lock)', () => {
    // The full scheduler loop is too heavy to spin here; lock the disposition
    // at the source level instead (repo policy: minimum one source-text
    // assertion when the runtime shape is impractical to integrate). The catch
    // that stamps merge-failed MUST also keep the iso — it can hold the only
    // copy of the node's product when the snapshot phase itself failed.
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    const catchBlock = src.match(
      /log\.warn\('merge-back failed'[\s\S]{0,900}?markMergeFailed\(db, nodeRunId, msg, log\)/,
    )
    expect(catchBlock).not.toBeNull()
    expect(catchBlock![0]).toContain('keepIso = true')
    // And the iso worktree remains on disk in the unit-level flows above; the
    // existence of the discard-in-finally is exactly why the flag must flip.
    expect(existsSync(appHome)).toBe(true)
  })
})
