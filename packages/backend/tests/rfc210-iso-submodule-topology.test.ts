// RFC-210 T14/T15 — iso 创建时记录 submodule 拓扑 + 终态快照前无条件回写对象。
//
// 为什么这些测试存在：
//
//  1. **最核心的一条：iso 被丢弃之后，节点在 submodule 里的提交必须还在。**
//     `git worktree remove --force` 会把 `<repo>/.git/worktrees/<iso>/modules/<sub>`
//     一起删掉（实测），而节点的子仓提交此前只存在于那里。不在丢弃前把对象推进
//     共享池，canonical 的 gitlink 就会指向一个不可达对象——父仓 `git status` 随即
//     整体失败，`snapshotFullState` 的 `add -A` 跟着崩。
//
//  2. **回写必须无条件，不能只在"子仓脏"时做。** agent 完全可能自己在子仓里
//     commit（今天 D22 的报错文案正是这么教它的），此时子仓是干净的，
//     "脏才回写"的逻辑一个字节都不会推出去，而对象照样随 iso 一起消失。
//
//  3. **无 submodule 的仓必须零额外 git 进程**（AC-12）。所有 submodule 逻辑的
//     第一道门是 `detectSubmodules`（纯 existsSync）；拓扑记录为空时后续全部短路。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  discardNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '@/services/nodeIsolation'
import { runGit } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-iso-home-'))
const created: string[] = []

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

/**
 * Canonical worktree that owns a submodule, wired the way production does:
 * a linked worktree of a host repo (so `--git-common-dir` finds the pool).
 */
async function canonWithSubmodule(): Promise<{ canon: string; host: string; pool: string }> {
  const sub = tmp('aw-rfc210-sub-')
  await initRepo(sub, 'a.txt', 'v1\n')

  const host = tmp('aw-rfc210-host-')
  await initRepo(host, 'README.md', 'root\n')
  await runGit(host, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor'])
  await runGit(host, ['commit', '-q', '-m', 'add submodule'])

  const canon = join(tmp('aw-rfc210-wt-'), 'canon')
  await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
  return { canon, host, pool: join(host, '.git', 'modules', 'vendor') }
}

function canonRepo(dir: string): CanonRepo {
  return { repoPath: dir, worktreePath: dir, worktreeDirName: '', baseBranch: 'main' }
}

describe('RFC-210 iso submodule topology', () => {
  test('a repo without .gitmodules records an empty topology and no pool', async () => {
    const canon = tmp('aw-rfc210-plain-')
    await initRepo(canon, 'base.txt', 'base\n')
    const handle = await createNodeIso({
      appHome,
      taskId: 'tplain',
      nodeRunId: 'rplain',
      canonRepos: [canonRepo(canon)],
    })
    expect(handle.repos[0]?.subBases).toEqual({})
    expect(handle.repos[0]?.poolDir).toBeNull()
    await discardNodeIso(handle)
  }, 60_000)

  test('records each submodule base head and attaches the shared pool', async () => {
    const { canon, pool } = await canonWithSubmodule()
    const subHead = (await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()

    const handle = await createNodeIso({
      appHome,
      taskId: 'ttopo',
      nodeRunId: 'rtopo',
      canonRepos: [canonRepo(canon)],
    })
    const repo = handle.repos[0]
    expect(repo?.subBases).toEqual({ vendor: subHead })
    // realpath both sides: git reports the resolved path, and on macOS the temp
    // dir arrives as /var/... while git hands back /private/var/....
    expect(realpathSync(repo?.poolDir as string)).toBe(realpathSync(pool))
    await discardNodeIso(handle)
  }, 90_000)

  test('a node commit inside the submodule SURVIVES the iso being discarded', async () => {
    const { canon, pool } = await canonWithSubmodule()
    const handle = await createNodeIso({
      appHome,
      taskId: 'tsurv',
      nodeRunId: 'rsurv',
      canonRepos: [canonRepo(canon)],
    })
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'vendor')

    // The agent commits INSIDE the submodule — the submodule ends up CLEAN, which
    // is exactly the case a "publish only when dirty" implementation would miss.
    writeFileSync(join(isoSub, 'a.txt'), 'by-node\n')
    await runGit(isoSub, ['add', '-A'])
    await runGit(isoSub, [
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'node edit',
    ])
    const nodeSha = (await runGit(isoSub, ['rev-parse', 'HEAD'])).stdout.trim()
    expect((await runGit(isoSub, ['status', '--porcelain'])).stdout.trim()).toBe('')

    await snapshotNodeIsoFinal(handle)
    await discardNodeIso(handle)

    // The iso module dir is gone with the worktree; the pool must still have it.
    const inPool = await runGit(pool, ['cat-file', '-t', nodeSha])
    expect(inPool.exitCode).toBe(0)
    expect(inPool.stdout.trim()).toBe('commit')
  }, 90_000)

  test('the published object is anchored, so a pruning gc cannot reclaim it', async () => {
    const { canon, pool } = await canonWithSubmodule()
    const handle = await createNodeIso({
      appHome,
      taskId: 'tanchor',
      nodeRunId: 'ranchor',
      canonRepos: [canonRepo(canon)],
    })
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    writeFileSync(join(isoSub, 'a.txt'), 'anchored\n')
    await runGit(isoSub, ['add', '-A'])
    await runGit(isoSub, [
      '-c',
      'user.email=t@e.com',
      '-c',
      'user.name=T',
      'commit',
      '-q',
      '-m',
      'anchor me',
    ])
    const nodeSha = (await runGit(isoSub, ['rev-parse', 'HEAD'])).stdout.trim()

    await snapshotNodeIsoFinal(handle)
    await discardNodeIso(handle)

    await runGit(pool, ['reflog', 'expire', '--expire=now', '--all'])
    await runGit(pool, ['gc', '--prune=now', '--quiet'])
    expect((await runGit(pool, ['cat-file', '-t', nodeSha])).stdout.trim()).toBe('commit')
  }, 120_000)
})

// Best-effort fixture cleanup; the OS temp dir is disposable either way.
process.on('exit', () => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})
