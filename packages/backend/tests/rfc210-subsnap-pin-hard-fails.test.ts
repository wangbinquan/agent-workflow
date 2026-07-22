// RFC-210 实现门 A5-fix — pin 失败禁止强推 + 恢复点不互相覆盖，红→绿锁。
//
// Codex 实现门（design/RFC-210-recursive-submodule-isolation/codex-impl-gate-2026-07-22.md
// critical #2）实测出的链条：`snapshotFullState` 在 `update-ref` 失败时只记
// "gc-exposed" warning 仍返回 SHA；`snapshotSubmodule` 连 logger 都没传（一声不
// 吭）；`checkoutMergedGitlinks` 把它当成功并继续 `checkout -f` —— 用户在子仓的
// 未提交修改从工作树消失，"唯一快照"是一枚 gc 一到就没的悬空 commit。A5 声称的
// "快照失败则拒绝强推"实际不存在。另一半：pin ref 按 `<slug>/<preHead>` 命名，
// 同一 HEAD 的第二次快照会覆盖第一份恢复点。
//
// 修法：`snapshotFullState` 带 pinRef 时 update-ref 非零直接抛；
// `snapshotSubmodule` 抛后回读校验 ref 精确指向 snapshot；pin ref 加
// `-<pid>-<nonce>` 后缀防覆盖。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '@/services/nodeIsolation'
import { subSlug } from '@/services/gitSubmodule'
import { runGit, snapshotFullState } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-sp-home-'))
const created: string[] = []

// Must be set in THIS file: `bun test` shares one process locally (so a sibling
// file's setting leaks and everything looks green) while CI runs --isolate.
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-sp-gitcfg-'))

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

async function fixture(tag: string): Promise<{ canon: string }> {
  const sub = tmp(`aw-rfc210-sp-${tag}-sub-`)
  await initRepo(sub, 'a.txt', 'v1\n')
  const host = tmp(`aw-rfc210-sp-${tag}-host-`)
  await initRepo(host, 'README.md', 'root\n')
  await runGit(host, [...ADD, sub, 'vendor'])
  await runGit(host, ['commit', '-q', '-m', 'add vendor'])
  const canon = join(tmp(`aw-rfc210-sp-${tag}-wt-`), 'canon')
  await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
  return { canon }
}

describe('RFC-210 — snapshot pin failures are fatal', () => {
  test('snapshotFullState THROWS when the pin ref cannot be written', async () => {
    const repo = tmp('aw-rfc210-sp-unit-')
    await initRepo(repo, 'f.txt', 'v1\n')
    // D/F conflict: a ref at the parent path blocks the deeper pin ref.
    await runGit(repo, ['update-ref', 'refs/aw-test/block', 'HEAD'])
    writeFileSync(join(repo, 'f.txt'), 'dirty\n')

    // Before the fix this WARNED ("snapshot stays gc-exposed") and returned the
    // sha — a recovery point one prune away from gone, handed out as durable.
    await expect(snapshotFullState(repo, { pinRef: 'refs/aw-test/block/deeper' })).rejects.toThrow(
      /update-ref/,
    )
  }, 120_000)

  test('a dirty canonical submodule survives when its rescue pin cannot be written', async () => {
    const { canon } = await fixture('flow')
    const handle = await createNodeIso({
      appHome,
      taskId: 'tsp1',
      nodeRunId: 'rsp1',
      canonRepos: [canonRepo(canon)],
    })
    // The node moves the submodule — and its commit REWRITES the same file
    // the user has dirty edits in, so the later checkout must overwrite it.
    const isoVendor = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(isoVendor, 'a.txt'), 'node-work\n')
    await commitIn(isoVendor, 'node advance')
    // …while the USER has uncommitted edits in the canonical submodule.
    writeFileSync(join(canon, 'vendor', 'a.txt'), 'precious-uncommitted\n')
    const preHead = (await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()
    // Block the subsnap namespace so the rescue pin MUST fail (D/F conflict).
    await runGit(join(canon, 'vendor'), [
      'update-ref',
      `refs/agent-workflow/subsnap/${subSlug('vendor')}`,
      'HEAD',
    ])

    const trees = await snapshotNodeIsoFinal(handle)
    // Before the fix the pin failure was silent and `checkout -f` proceeded:
    // the edit was destroyed with a gc-exposed dangling commit as its only
    // trace. Now the merge-back refuses.
    await expect(mergeBackNodeIso(handle, trees)).rejects.toThrow(
      /refusing to discard|could not be snapshotted/,
    )
    expect(readFileSync(join(canon, 'vendor', 'a.txt'), 'utf8')).toBe('precious-uncommitted\n')
    expect((await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(preHead)
  }, 120_000)

  test('two rescues at the SAME pre-checkout HEAD keep two distinct recovery points', async () => {
    const { canon } = await fixture('nonce')
    const canonVendor = join(canon, 'vendor')
    const origHead = (await runGit(canonVendor, ['rev-parse', 'HEAD'])).stdout.trim()

    // Round 1: user edit A is rescued before the forced checkout.
    const h1 = await createNodeIso({
      appHome,
      taskId: 'tsp2',
      nodeRunId: 'rsp2a',
      canonRepos: [canonRepo(canon)],
    })
    const iso1Vendor = join(h1.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(iso1Vendor, 'a.txt'), 'node1\n')
    await commitIn(iso1Vendor, 'node 1 advance')
    writeFileSync(join(canonVendor, 'a.txt'), 'edit-A\n')
    expect((await mergeBackNodeIso(h1, await snapshotNodeIsoFinal(h1))).clean).toBe(true)

    // Rewind the canonical submodule to the SAME head, dirty it differently.
    await runGit(canonVendor, ['checkout', '-q', '--detach', origHead])
    const h2 = await createNodeIso({
      appHome,
      taskId: 'tsp2',
      nodeRunId: 'rsp2b',
      canonRepos: [canonRepo(canon)],
    })
    const iso2Vendor = join(h2.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(iso2Vendor, 'a.txt'), 'node2\n')
    await commitIn(iso2Vendor, 'node 2 advance')
    writeFileSync(join(canonVendor, 'a.txt'), 'edit-B\n')
    expect((await mergeBackNodeIso(h2, await snapshotNodeIsoFinal(h2))).clean).toBe(true)

    // Both rescues pinned at the same preHead must coexist — the old
    // `<slug>/<preHead>` naming made round 2 OVERWRITE round 1, deleting the
    // only trace of edit A.
    const refs = await runGit(canonVendor, [
      'for-each-ref',
      '--format=%(refname)',
      `refs/agent-workflow/subsnap/${subSlug('vendor')}/`,
    ])
    const names = refs.stdout.trim().split('\n').filter(Boolean)
    expect(names).toHaveLength(2)
    for (const n of names) expect(n).toContain(origHead)
    const rescued = new Set<string>()
    for (const n of names) {
      const blob = await runGit(canonVendor, ['cat-file', '-p', `${n}:a.txt`])
      rescued.add(blob.stdout)
    }
    expect(rescued).toEqual(new Set(['edit-A\n', 'edit-B\n']))
  }, 120_000)
})
