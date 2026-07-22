// RFC-210 后续修正 — 强制 checkout 前必须把用户在子仓里未提交的工作 pin 住。
//
// 这是 D22 退役带来的**新增**数据丢失面，不是既有行为。RFC-210 之前，
// syncSubmodules 的 `submodule update` 不带 --force：子仓脏就只是让 update 失败
// （返回值当时还被丢弃），用户的改动原样留着。退役 D22 之后，merge-back 无条件
// 走 checkoutMergedGitlinks，而它撞上脏工作区就 `checkout --detach -f` —— 用户
// 未提交的行被静默删掉，merge-back 还报 clean。
//
// 父仓的三路合并救不了：F9 决定了 snapshotFullState 对超级项目只记 gitlink，
// 用户在子仓内的改动根本不在 `ours` 里，合并时看不见。
//
// 修法是接上 G10 —— snapshotSubmodule 在这之前是**死代码**（全仓只有测试引用），
// 而 checkoutMergedGitlinks 的注释却写着 "snapshotting is the caller's job"，
// 没有任何 caller 做这件事。现在强制之前先 pin 一个全状态快照（tracked +
// untracked）并把 ref 记进日志；快照失败则拒绝强推，宁可 merge-back 失败也不
// 毁掉用户的工作。

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
import { runGit } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-ds-home-'))
const created: string[] = []

let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-ds-gitcfg-'))

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

describe('RFC-210 — user edits in a canonical submodule are pinned before -f', () => {
  test('uncommitted work is recoverable from the snapshot ref after merge-back', async () => {
    const sub = tmp('aw-rfc210-ds-sub-')
    await initRepo(sub, 'a.txt', 'l1\nl2\nl3\n')
    const host = tmp('aw-rfc210-ds-host-')
    await initRepo(host, 'README.md', 'root\n')
    await runGit(host, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor',
    ])
    await runGit(host, ['commit', '-q', '-m', 'add submodule'])
    const canon = join(tmp('aw-rfc210-ds-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
    const canonSub = join(canon, 'vendor')

    const handle = await createNodeIso({
      appHome,
      taskId: 'tds',
      nodeRunId: 'rds',
      canonRepos: [canonRepo(canon)],
    })

    // The node moves the submodule's gitlink...
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(isoSub, 'a.txt'), 'l1-NODE\nl2\nl3\n')
    await commitIn(isoSub, 'node edits line 1')

    // ...while the USER has uncommitted work sitting in the canonical submodule.
    // Both tracked edits and an untracked file.
    writeFileSync(join(canonSub, 'a.txt'), 'l1\nl2\nl3-USER-UNCOMMITTED\n')
    writeFileSync(join(canonSub, 'scratch.txt'), 'user scratch\n')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)

    // The force checkout still happens — the merged gitlink has to land — so the
    // user's line is gone from the working tree. That is expected. What must NOT
    // happen is it being gone for good.
    const after = readFileSync(join(canonSub, 'a.txt'), 'utf8')
    expect(after).toBe('l1-NODE\nl2\nl3\n')

    // THE regression: a snapshot ref must exist and must still carry the user's
    // uncommitted line. Before the fix nothing was pinned and this work was
    // unrecoverable.
    const refs = await runGit(canonSub, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/agent-workflow/subsnap/',
    ])
    const pinned = refs.stdout.trim().split('\n').filter(Boolean)
    expect(pinned.length).toBeGreaterThan(0)

    const recovered = await runGit(canonSub, ['show', `${pinned[0]!}:a.txt`])
    expect(recovered.exitCode).toBe(0)
    expect(recovered.stdout).toBe('l1\nl2\nl3-USER-UNCOMMITTED\n')

    // Untracked files are in the snapshot too — that is what "full state" means,
    // and it is the half `checkout -f` would NOT have destroyed, so a snapshot
    // that dropped them would still be a regression against doing nothing.
    const recoveredUntracked = await runGit(canonSub, ['show', `${pinned[0]!}:scratch.txt`])
    expect(recoveredUntracked.exitCode).toBe(0)
    expect(recoveredUntracked.stdout).toBe('user scratch\n')
  }, 120_000)

  test('a clean canonical submodule pins nothing (no ref litter on the common path)', async () => {
    const sub = tmp('aw-rfc210-ds-csub-')
    await initRepo(sub, 'a.txt', 'v1\n')
    const host = tmp('aw-rfc210-ds-chost-')
    await initRepo(host, 'README.md', 'root\n')
    await runGit(host, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      '-q',
      sub,
      'vendor',
    ])
    await runGit(host, ['commit', '-q', '-m', 'add submodule'])
    const canon = join(tmp('aw-rfc210-ds-cwt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tdc',
      nodeRunId: 'rdc',
      canonRepos: [canonRepo(canon)],
    })
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(isoSub, 'a.txt'), 'v2\n')
    await commitIn(isoSub, 'node edits')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)

    const refs = await runGit(join(canon, 'vendor'), [
      'for-each-ref',
      '--format=%(refname)',
      'refs/agent-workflow/subsnap/',
    ])
    expect(refs.stdout.trim()).toBe('')
  }, 120_000)
})
