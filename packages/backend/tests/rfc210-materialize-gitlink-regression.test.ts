// RFC-210 T18/T19 — merge-back 不得再吞掉节点在 submodule 里的提交。
//
// 这是本 RFC 三处静默数据丢失里最严重的一处，红→绿回归锁。
//
// 病灶在 materializeTree 的步骤顺序：
//   ① read-tree <merged>        → index 里的 gitlink = 合并结果
//   ② checkout-index -f -a      → 不写 gitlink（它只处理 blob）
//   ③ reset --mixed <taskBase>  → index 里的 gitlink 被退回 base
//   ④ syncSubmodules            → 按 index（即 base）重新 checkout 子仓
// 净效果：子仓工作区回到 base，父仓 git status 一片空白——节点在子仓里的提交
// 彻底消失，不报错、不写日志（syncSubmodules 的返回值当时还被丢弃）。
//
// 这直接推翻了 RFC-130/proposal.md:62 「submodule 内已提交的改动照常随 gitlink
// 走」的断言。
//
// 修复是在 ④ 之后追加一步：按 merged tree 里的 gitlink 逐个
// `git -C <sub> checkout --detach <sha>`。**顺序是关键** —— 放在 ④ 之前会被
// submodule update 按 index 原样拉回去（实现时先写错过一版，实测才发现）。
//
// 断言选的是 gitlink 一致性 + 子仓内容，而不是「父仓 status 为空」：快照捕获的
// 往往就是脏状态，回滚忠实恢复它，超级项目对含未提交内容的子仓永远报 modified。
// 断言 status 为空等于断言"改动被丢掉了"，方向正好反了。

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

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-gl-home-'))
const created: string[] = []

// git >= 2.38 refuses the `file` transport for submodules however the URL is
// spelled. Production argv deliberately omits the allowance, so tests that drive
// the REAL code path (createNodeIso → syncSubmodules → submodule update) must
// inject it through a throwaway global config.
//
// Setting it per-command is not enough and relying on a sibling test file having
// set it is a trap: `bun test` shares one process locally (so the variable leaks
// between files and everything looks green) while CI runs with --isolate, where
// each file starts clean and these tests fail with exit 128.
let prevGitGlobal: string | undefined
let prevGitSystem: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-gitcfg-'))

beforeAll(() => {
  const cfg = join(gitCfgDir, 'gitconfig')
  writeFileSync(cfg, '[protocol "file"]\n\tallow = always\n[user]\n\tname = t\n\temail = t@e.com\n')
  prevGitGlobal = process.env.GIT_CONFIG_GLOBAL
  prevGitSystem = process.env.GIT_CONFIG_SYSTEM
  process.env.GIT_CONFIG_GLOBAL = cfg
  process.env.GIT_CONFIG_SYSTEM = '/dev/null'
})

afterAll(() => {
  if (prevGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = prevGitGlobal
  if (prevGitSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
  else process.env.GIT_CONFIG_SYSTEM = prevGitSystem
  rmSync(gitCfgDir, { recursive: true, force: true })
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

/** Canonical worktree owning a submodule, wired like production (linked worktree). */
async function canonWithSubmodule(): Promise<string> {
  const sub = tmp('aw-rfc210-gl-sub-')
  await initRepo(sub, 'a.txt', 'v1\n')
  const host = tmp('aw-rfc210-gl-host-')
  await initRepo(host, 'README.md', 'root\n')
  await runGit(host, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor'])
  await runGit(host, ['commit', '-q', '-m', 'add submodule'])
  const canon = join(tmp('aw-rfc210-gl-wt-'), 'canon')
  await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
  await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])
  return canon
}

function canonRepo(dir: string): CanonRepo {
  return { repoPath: dir, worktreePath: dir, worktreeDirName: '', baseBranch: 'main' }
}

describe('RFC-210 merge-back preserves submodule commits', () => {
  test('a node commit inside the submodule reaches canonical (was silently dropped)', async () => {
    const canon = await canonWithSubmodule()
    const canonSub = join(canon, 'vendor')
    const baseSubHead = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()
    const canonHeadBefore = (await runGit(canon, ['rev-parse', 'HEAD'])).stdout.trim()

    const handle = await createNodeIso({
      appHome,
      taskId: 'tgl',
      nodeRunId: 'rgl',
      canonRepos: [canonRepo(canon)],
    })
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'vendor')

    writeFileSync(join(isoSub, 'a.txt'), 'edited-by-node\n')
    const nodeSubSha = await commitIn(isoSub, 'node edits submodule')
    expect(nodeSubSha).not.toBe(baseSubHead)

    const nodeTrees = await snapshotNodeIsoFinal(handle)
    const res = await mergeBackNodeIso(handle, nodeTrees)
    expect(res.clean).toBe(true)

    // THE regression: before the fix both of these still showed the BASE state.
    expect((await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(nodeSubSha)
    expect(readFileSync(join(canonSub, 'a.txt'), 'utf8')).toBe('edited-by-node\n')

    // RFC-130 D23/D28: merge-back lands UNSTAGED with canonical HEAD unmoved.
    // For a submodule that means the INDEX deliberately stays on the base gitlink
    // while the working tree sits on the merged one — that gap IS the unstaged
    // change. (Asserting the index also moved would be asserting the delta got
    // staged, i.e. the opposite of the design. The rollback path in §6 is where
    // index and working tree are expected to agree; merge-back is not that path.)
    const idx = (await runGit(canon, ['ls-files', '-s', 'vendor'])).stdout.trim()
    expect(idx.split(/\s+/)[1]).toBe(baseSubHead)
    expect((await runGit(canon, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(canonHeadBefore)
    const unstaged = (await runGit(canon, ['diff', '--name-only'])).stdout.trim()
    expect(unstaged).toContain('vendor')
    expect((await runGit(canon, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('')

    await discardNodeIso(handle)
  }, 120_000)

  test('parent-repo edits still merge back alongside the submodule bump', async () => {
    const canon = await canonWithSubmodule()
    const handle = await createNodeIso({
      appHome,
      taskId: 'tglmix',
      nodeRunId: 'rglmix',
      canonRepos: [canonRepo(canon)],
    })
    const iso = handle.repos[0]!.isoWorktreePath
    writeFileSync(join(iso, 'README.md'), 'touched by node\n')
    writeFileSync(join(iso, 'fresh.txt'), 'new file\n')
    writeFileSync(join(iso, 'vendor', 'a.txt'), 'sub edited\n')
    const nodeSubSha = await commitIn(join(iso, 'vendor'), 'sub bump')

    const nodeTrees = await snapshotNodeIsoFinal(handle)
    expect((await mergeBackNodeIso(handle, nodeTrees)).clean).toBe(true)

    expect(readFileSync(join(canon, 'README.md'), 'utf8')).toBe('touched by node\n')
    expect(readFileSync(join(canon, 'fresh.txt'), 'utf8')).toBe('new file\n')
    expect((await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      nodeSubSha,
    )
    await discardNodeIso(handle)
  }, 120_000)

  test('UNCOMMITTED submodule edits are auto-committed through instead of rejected (D22 retired)', async () => {
    const canon = await canonWithSubmodule()
    const canonSub = join(canon, 'vendor')
    const baseSubHead = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()

    const handle = await createNodeIso({
      appHome,
      taskId: 'td22',
      nodeRunId: 'rd22',
      canonRepos: [canonRepo(canon)],
    })
    const isoSub = join(handle.repos[0]!.isoWorktreePath, 'vendor')

    // The node edits inside the submodule and does NOT commit — the exact case
    // RFC-130 D22 used to reject with `submodule-dirty-content`, because a
    // gitlink-only snapshot could not carry the edits. It can now: the platform
    // commits them itself and publishes the object.
    writeFileSync(join(isoSub, 'a.txt'), 'left uncommitted\n')
    writeFileSync(join(isoSub, 'extra.txt'), 'untracked too\n')

    const nodeTrees = await snapshotNodeIsoFinal(handle) // used to throw here
    expect((await mergeBackNodeIso(handle, nodeTrees)).clean).toBe(true)

    const landed = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()
    expect(landed).not.toBe(baseSubHead) // gitlink advanced past the auto-commit
    expect(readFileSync(join(canonSub, 'a.txt'), 'utf8')).toBe('left uncommitted\n')
    // Untracked files ride along too — `add -A` stages them before committing.
    expect(readFileSync(join(canonSub, 'extra.txt'), 'utf8')).toBe('untracked too\n')

    await discardNodeIso(handle)
  }, 120_000)

  test('a repo whose submodule the node never touched is left exactly as it was', async () => {
    const canon = await canonWithSubmodule()
    const canonSub = join(canon, 'vendor')
    const before = (await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()

    const handle = await createNodeIso({
      appHome,
      taskId: 'tglnoop',
      nodeRunId: 'rglnoop',
      canonRepos: [canonRepo(canon)],
    })
    writeFileSync(join(handle.repos[0]!.isoWorktreePath, 'README.md'), 'only parent\n')
    const nodeTrees = await snapshotNodeIsoFinal(handle)
    expect((await mergeBackNodeIso(handle, nodeTrees)).clean).toBe(true)

    expect((await runGit(canonSub, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before)
    expect(readFileSync(join(canon, 'README.md'), 'utf8')).toBe('only parent\n')
    await discardNodeIso(handle)
  }, 120_000)
})

process.on('exit', () => {
  for (const d of created) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})
