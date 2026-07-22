// RFC-210 实现门 A3-fix — 运行中新增的 submodule 不再绕过对象池与合并，红→绿锁。
//
// Codex 实现门（design/RFC-210-recursive-submodule-isolation/codex-impl-gate-2026-07-22.md
// critical #3）实测出的整条丢失链：
//
//  1. 拓扑只在 iso 创建时记录。节点自己 `git submodule add` 的仓，`subBases` 为空
//     时 publishSubmoduleHeads 直接 return；已有拓扑时新路径又因 `poolDirs` 缺项
//     被跳过 —— 新子仓的 commit 只存在于 iso 的 **per-worktree** module dir
//     （实测 `<host>/.git/worktrees/<iso>/modules/<path>`，`worktree remove
//     --force` 连目录带对象一起删）。
//  2. 父层 merge 照样采纳 gitlink，materializeTree 第⑥步对未初始化路径静默跳过
//     —— canonical 拿到一个空目录，节点的子仓从累积状态里蒸发。
//  3. 更阴险的二阶丢失：`git submodule status` 只枚举 **index** 里的 gitlink，
//     落进 canonical 的新子仓是 unstaged delta（实测 status 一行都不打）——下一个
//     节点的 iso 看到的是空目录，final snapshot 里没有 gitlink，merge-back 把它
//     读成「theirs 删除了子仓」，把兄弟节点的产物从 canonical 里删掉。
//
// 修法：publish 时为新路径建持久池（`<hostGitDir>/modules/...`）+ 回写对象 +
// 节点/worktree 双 ref 锚；materialize 对「gitlink 有变化但未初始化」的路径从池
// attach（临时把 submodule.<name>.url 指向池、update 完 sync 还原、index 注入即
// 时恢复）；iso 创建后按 base snapshot 对齐 gitlink 并重采拓扑；所有「本仓真实
// 拓扑」消费点改走 listEffectiveSubmodules（index gitlink ∪ 已声明且已挂载）。

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createNodeIso,
  discardNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '@/services/nodeIsolation'
import { subSlug, worktreeRefName } from '@/services/gitSubmodule'
import { runGit, snapshotFullState } from '@/util/git'

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-ns-home-'))
const created: string[] = []

// Must be set in THIS file: `bun test` shares one process locally (so a sibling
// file's setting leaks and everything looks green) while CI runs --isolate.
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-ns-gitcfg-'))

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

describe('RFC-210 — a submodule the node itself added', () => {
  test('survives iso discard, reaches canonical, and the NEXT node does not delete it', async () => {
    const subSrc = tmp('aw-rfc210-ns-src-')
    await initRepo(subSrc, 's.txt', 's1\n')
    const host = tmp('aw-rfc210-ns-host-')
    await initRepo(host, 'README.md', 'root\n')
    const canon = join(tmp('aw-rfc210-ns-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tns1',
      nodeRunId: 'rns1',
      canonRepos: [canonRepo(canon)],
    })
    const iso = handle.repos[0]!.isoWorktreePath
    // The node adds a brand-new submodule and commits inside it — the module
    // dir for this lives in the ISO worktree's private admin area and would be
    // deleted wholesale by discardNodeIso.
    await runGit(iso, [...ADD, subSrc, 'newsub'])
    writeFileSync(join(iso, 'newsub', 'work.txt'), 'made-by-node\n')
    const agentSha = await commitIn(join(iso, 'newsub'), 'agent work in new submodule')

    const trees = await snapshotNodeIsoFinal(handle)
    // Publish must have created a durable pool for the new path and anchored
    // the head with BOTH refs (node-scoped for the run, worktree-scoped for
    // whatever canonical adopts — the node ref dies with the iso).
    const pool = handle.repos[0]!.poolDirs['newsub']
    expect(pool).toBeDefined()
    expect((await runGit(pool!, ['cat-file', '-t', agentSha])).stdout.trim()).toBe('commit')
    const wtRef = await runGit(pool!, ['rev-parse', worktreeRefName('tns1', 'newsub')])
    expect(wtRef.stdout.trim()).toBe(agentSha)

    const res = await mergeBackNodeIso(handle, trees)
    expect(res.clean).toBe(true)
    await discardNodeIso(handle)

    // Canonical must have the submodule ATTACHED and checked out at the node's
    // commit — before the fix the gitlink was silently skipped (empty dir).
    expect(existsSync(join(canon, 'newsub', '.git'))).toBe(true)
    expect((await runGit(join(canon, 'newsub'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      agentSha,
    )
    expect(readFileSync(join(canon, 'newsub', 'work.txt'), 'utf8')).toBe('made-by-node\n')
    // The delta stays UNSTAGED (D23/D28): nothing of the attach leaks into the
    // real index.
    const staged = await runGit(canon, ['diff', '--cached', '--name-only'])
    expect(staged.stdout.trim()).toBe('')
    // The attach must restore the real url, not leak the pool path.
    const url = await runGit(canon, ['config', 'submodule.newsub.url'])
    expect(url.stdout.trim()).toBe(subSrc)

    // The node-scoped pool ref died with the iso; the worktree anchor must keep
    // the objects alive through an aggressive gc.
    await runGit(pool!, ['gc', '--prune=now', '--quiet'])
    expect((await runGit(pool!, ['cat-file', '-e', agentSha])).exitCode).toBe(0)

    // ── Second node: sees the submodule, does NOT delete it. ──
    // `git submodule status` cannot see an attached-but-unstaged submodule, so
    // before the fix the next iso read an empty dir, omitted the gitlink from
    // its final snapshot, and merge-back deleted the sibling's product.
    const handle2 = await createNodeIso({
      appHome,
      taskId: 'tns1',
      nodeRunId: 'rns2',
      canonRepos: [canonRepo(canon)],
    })
    expect(handle2.repos[0]!.subBases['newsub']).toBe(agentSha)
    const iso2 = handle2.repos[0]!.isoWorktreePath
    expect(readFileSync(join(iso2, 'newsub', 'work.txt'), 'utf8')).toBe('made-by-node\n')

    writeFileSync(join(iso2, 'README.md'), 'parent edited by node 2\n')
    const res2 = await mergeBackNodeIso(handle2, await snapshotNodeIsoFinal(handle2))
    expect(res2.clean).toBe(true)
    await discardNodeIso(handle2)

    expect(readFileSync(join(canon, 'README.md'), 'utf8')).toBe('parent edited by node 2\n')
    expect((await runGit(join(canon, 'newsub'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      agentSha,
    )
    expect(readFileSync(join(canon, 'newsub', 'work.txt'), 'utf8')).toBe('made-by-node\n')
    // And the accumulated snapshot still records the gitlink.
    const snap = await snapshotFullState(canon)
    const entry = await runGit(canon, ['ls-tree', snap, '--', 'newsub'])
    expect(entry.stdout).toContain(`160000 commit ${agentSha}`)
  }, 120_000)

  test('a submodule added NEXT TO an existing one publishes into its own new pool', async () => {
    const subA = tmp('aw-rfc210-ns2-a-')
    await initRepo(subA, 'a.txt', 'a1\n')
    const subNew = tmp('aw-rfc210-ns2-n-')
    await initRepo(subNew, 'n.txt', 'n1\n')
    const host = tmp('aw-rfc210-ns2-host-')
    await initRepo(host, 'README.md', 'root\n')
    await runGit(host, [...ADD, subA, 'existing'])
    await runGit(host, ['commit', '-q', '-m', 'add existing submodule'])
    const canon = join(tmp('aw-rfc210-ns2-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tns2',
      nodeRunId: 'rns2a',
      canonRepos: [canonRepo(canon)],
    })
    const iso = handle.repos[0]!.isoWorktreePath
    await runGit(iso, [...ADD, subNew, 'added'])
    writeFileSync(join(iso, 'added', 'n.txt'), 'node-added\n')
    const addedSha = await commitIn(join(iso, 'added'), 'work in added submodule')
    // The existing one is edited too, so both paths flow through one publish.
    writeFileSync(join(iso, 'existing', 'a.txt'), 'a2\n')
    const existingSha = await commitIn(join(iso, 'existing'), 'work in existing submodule')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)
    // Distinct pools — the new path must NOT have been squeezed into the
    // sibling's pool (that was A4) nor skipped (this fix).
    const pools = handle.repos[0]!.poolDirs
    expect(pools['added']).toBeDefined()
    expect(pools['added']).not.toBe(pools['existing'])
    await discardNodeIso(handle)

    expect((await runGit(join(canon, 'existing'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(
      existingSha,
    )
    expect((await runGit(join(canon, 'added'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(addedSha)
    expect(readFileSync(join(canon, 'added', 'n.txt'), 'utf8')).toBe('node-added\n')
  }, 120_000)

  test('a NESTED submodule added inside an existing one attaches level by level', async () => {
    const innerSrc = tmp('aw-rfc210-ns3-i-')
    await initRepo(innerSrc, 'i.txt', 'i1\n')
    const vendorSrc = tmp('aw-rfc210-ns3-v-')
    await initRepo(vendorSrc, 'v.txt', 'v1\n')
    const host = tmp('aw-rfc210-ns3-host-')
    await initRepo(host, 'README.md', 'root\n')
    await runGit(host, [...ADD, vendorSrc, 'vendor'])
    await runGit(host, ['commit', '-q', '-m', 'add vendor'])
    const canon = join(tmp('aw-rfc210-ns3-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tns3',
      nodeRunId: 'rns3',
      canonRepos: [canonRepo(canon)],
    })
    const iso = handle.repos[0]!.isoWorktreePath
    // The node adds a submodule INSIDE vendor and leaves everything
    // uncommitted at the vendor level — publish must auto-commit vendor
    // (registering inner's gitlink + .gitmodules) bottom-up.
    await runGit(join(iso, 'vendor'), [...ADD, innerSrc, 'inner'])
    writeFileSync(join(iso, 'vendor', 'inner', 'i.txt'), 'nested-node-work\n')
    const innerSha = await commitIn(join(iso, 'vendor', 'inner'), 'work in nested new submodule')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)
    expect(handle.repos[0]!.poolDirs['vendor/inner']).toBeDefined()
    await discardNodeIso(handle)

    // vendor moved to the auto-commit that records inner; inner is attached and
    // checked out inside canonical's vendor.
    expect(existsSync(join(canon, 'vendor', 'inner', '.git'))).toBe(true)
    expect(
      (await runGit(join(canon, 'vendor', 'inner'), ['rev-parse', 'HEAD'])).stdout.trim(),
    ).toBe(innerSha)
    expect(readFileSync(join(canon, 'vendor', 'inner', 'i.txt'), 'utf8')).toBe('nested-node-work\n')
    const recorded = await runGit(join(canon, 'vendor'), ['rev-parse', 'HEAD:inner'])
    expect(recorded.stdout.trim()).toBe(innerSha)
  }, 120_000)

  test('BOTH sides adding the same path is a conflict, not a silent pick', async () => {
    const srcA = tmp('aw-rfc210-ns4-a-')
    await initRepo(srcA, 'a.txt', 'from-canon\n')
    const srcB = tmp('aw-rfc210-ns4-b-')
    await initRepo(srcB, 'b.txt', 'from-node\n')
    const host = tmp('aw-rfc210-ns4-host-')
    await initRepo(host, 'README.md', 'root\n')
    const canon = join(tmp('aw-rfc210-ns4-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tns4',
      nodeRunId: 'rns4',
      canonRepos: [canonRepo(canon)],
    })
    // A concurrent sibling lands the SAME path in canonical first…
    await runGit(canon, [...ADD, srcA, 'twice'])
    const canonSha = (await runGit(join(canon, 'twice'), ['rev-parse', 'HEAD'])).stdout.trim()
    // …while this node adds its own version in the iso.
    const iso = handle.repos[0]!.isoWorktreePath
    await runGit(iso, [...ADD, srcB, 'twice'])

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    // add/add on a gitlink: neither side may win silently. Before the fix the
    // salvage path reverted the path to `ours`, dropping the node's submodule
    // without a trace.
    expect(res.clean).toBe(false)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]!.paths).toContain('twice')
    expect(res.conflicts[0]!.salvagedPaths).toEqual([])
    // Canonical keeps ITS version untouched while a human decides.
    expect((await runGit(join(canon, 'twice'), ['rev-parse', 'HEAD'])).stdout.trim()).toBe(canonSha)
    expect(readFileSync(join(canon, 'twice', 'a.txt'), 'utf8')).toBe('from-canon\n')
    // subSlug sanity: the conflicted path is representable for future anchors.
    expect(subSlug('twice')).toMatch(/^[0-9a-f]{16}$/)
  }, 120_000)
})
