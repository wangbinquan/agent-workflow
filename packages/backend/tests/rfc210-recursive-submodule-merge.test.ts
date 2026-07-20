// RFC-210 T23 — 子仓层递归三路合并（AC-5）。
//
// 为什么这些测试存在：
//
// git 自己不做这件事。父仓层的 `merge-tree` 一旦看到 gitlink 两边都动过就放弃：
//   "Recursive merging with submodules currently only supports trivial cases.
//    Please manually handle the merging of each conflicted submodule."
// 而在 submodule 内部跑同一条命令是能干净合并的（设计门实测：两个节点改同一文件
// 不同行 → 合成并集）。所以递归必须由平台自己驱动。
//
// 没有这一层的话，两个并发节点改同一个子仓时，后合并的那个会**整个覆盖**先合并
// 的那个（gitlink 是单个条目，父仓层按「一边动就取那边」处理），前一个节点的工作
// 静默消失——正是 RFC-210 用户故事 2 要修的形态。
//
// 合并结果的 parentage 也有讲究：merged commit 必须以 `ours` 为祖先，否则父仓层
// 仍旧拒绝。设计门实测四组：`-p theirs` 单亲 ⟹ 父仓层 exit 1；`-p ours` 单亲、
// `-p ours -p theirs`、`-p theirs -p ours` ⟹ 都 exit 0。所以真正的不变量是
// **祖先关系**，不是 parent 个数或顺序。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  discardNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '@/services/nodeIsolation'
import { runGit } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-rec-home-'))
const created: string[] = []

// See reference: this machine's global gitconfig enables protocol.file.allow, so
// without an explicit injection these tests pass locally and fail under CI's
// --isolate. The production path (createNodeIso → syncSubmodules) deliberately
// runs without the flag, so it must come from the environment.
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-rec-cfg-'))

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
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
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

async function canonWithSubmodule(subSeed: string): Promise<string> {
  const sub = tmp('aw-rfc210-rec-sub-')
  await initRepo(sub, 'a.txt', subSeed)
  const host = tmp('aw-rfc210-rec-host-')
  await initRepo(host, 'README.md', 'root\n')
  await runGit(host, ['submodule', 'add', '-q', sub, 'vendor'])
  await runGit(host, ['commit', '-q', '-m', 'add submodule'])
  const canon = join(tmp('aw-rfc210-rec-wt-'), 'canon')
  await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await runGit(canon, ['submodule', 'update', '--init', '-q'])
  return canon
}

function canonRepo(dir: string): CanonRepo {
  return { repoPath: dir, worktreePath: dir, worktreeDirName: '', baseBranch: 'main' }
}

describe('RFC-210 per-submodule three-way merge', () => {
  test('two concurrent nodes editing different lines of one submodule file MERGE (AC-5)', async () => {
    const canon = await canonWithSubmodule('l1\nl2\nl3\n')
    const canonSub = join(canon, 'vendor')

    // BOTH isos branch from the same base — that is what makes them concurrent.
    const a = await createNodeIso({
      appHome,
      taskId: 'trec',
      nodeRunId: 'rA',
      canonRepos: [canonRepo(canon)],
    })
    const b = await createNodeIso({
      appHome,
      taskId: 'trec',
      nodeRunId: 'rB',
      canonRepos: [canonRepo(canon)],
    })

    writeFileSync(join(a.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'l1-A\nl2\nl3\n')
    await commitIn(join(a.repos[0]!.isoWorktreePath, 'vendor'), 'A edits line 1')
    writeFileSync(join(b.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'l1\nl2\nl3-B\n')
    await commitIn(join(b.repos[0]!.isoWorktreePath, 'vendor'), 'B edits line 3')

    // A lands first.
    expect((await mergeBackNodeIso(a, await snapshotNodeIsoFinal(a))).clean).toBe(true)
    expect(readFileSync(join(canonSub, 'a.txt'), 'utf8')).toBe('l1-A\nl2\nl3\n')

    // B lands second. Without the per-submodule merge this OVERWRITES A.
    expect((await mergeBackNodeIso(b, await snapshotNodeIsoFinal(b))).clean).toBe(true)
    expect(readFileSync(join(canonSub, 'a.txt'), 'utf8')).toBe('l1-A\nl2\nl3-B\n')

    await discardNodeIso(a)
    await discardNodeIso(b)
  }, 180_000)

  test('the merged submodule commit keeps ours as an ancestor (superproject invariant)', async () => {
    const canon = await canonWithSubmodule('x1\nx2\nx3\n')
    const canonSub = join(canon, 'vendor')

    const a = await createNodeIso({
      appHome,
      taskId: 'tanc',
      nodeRunId: 'rA',
      canonRepos: [canonRepo(canon)],
    })
    const b = await createNodeIso({
      appHome,
      taskId: 'tanc',
      nodeRunId: 'rB',
      canonRepos: [canonRepo(canon)],
    })
    writeFileSync(join(a.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'x1-A\nx2\nx3\n')
    await commitIn(join(a.repos[0]!.isoWorktreePath, 'vendor'), 'A')
    writeFileSync(join(b.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'x1\nx2\nx3-B\n')
    await commitIn(join(b.repos[0]!.isoWorktreePath, 'vendor'), 'B')

    await mergeBackNodeIso(a, await snapshotNodeIsoFinal(a))
    const afterA = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()
    await mergeBackNodeIso(b, await snapshotNodeIsoFinal(b))
    const afterB = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()

    // `ours` (what canonical had after A) must remain reachable from the result —
    // that ancestry, not the parent count, is what lets the superproject merge.
    const isAncestor = await runGit(canonSub, ['merge-base', '--is-ancestor', afterA, afterB])
    expect(isAncestor.exitCode).toBe(0)

    await discardNodeIso(a)
    await discardNodeIso(b)
  }, 180_000)

  test('conflicting edits to the SAME line withhold the repo instead of picking a side', async () => {
    const canon = await canonWithSubmodule('same\n')
    const canonSub = join(canon, 'vendor')

    const a = await createNodeIso({
      appHome,
      taskId: 'tcon',
      nodeRunId: 'rA',
      canonRepos: [canonRepo(canon)],
    })
    const b = await createNodeIso({
      appHome,
      taskId: 'tcon',
      nodeRunId: 'rB',
      canonRepos: [canonRepo(canon)],
    })
    writeFileSync(join(a.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'A-version\n')
    await commitIn(join(a.repos[0]!.isoWorktreePath, 'vendor'), 'A')
    writeFileSync(join(b.repos[0]!.isoWorktreePath, 'vendor', 'a.txt'), 'B-version\n')
    await commitIn(join(b.repos[0]!.isoWorktreePath, 'vendor'), 'B')

    await mergeBackNodeIso(a, await snapshotNodeIsoFinal(a))
    const afterA = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()

    const res = await mergeBackNodeIso(b, await snapshotNodeIsoFinal(b))
    expect(res.clean).toBe(false)
    expect(res.conflicts[0]?.paths.some((p) => p.includes('vendor'))).toBe(true)
    // Canonical must be left exactly as A left it — a withheld conflict never
    // half-applies (RFC-130 D27).
    expect((await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(afterA)
    expect(readFileSync(join(canonSub, 'a.txt'), 'utf8')).toBe('A-version\n')

    await discardNodeIso(a)
    await discardNodeIso(b)
  }, 180_000)
})
