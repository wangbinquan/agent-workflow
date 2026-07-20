// RFC-210 后续修正 — 对象池是「每子仓一个」而不是「每仓一个」，红→绿回归锁。
//
// 病灶：`captureSubmoduleTopology` 逐个子仓解析出各自的池、也逐个挂了
// alternates，却只把**第一个**记进 `IsoRepo.poolDir`（当时的注释写的是
// "First pool wins as the handle-level record"）。而下游全部按「这个仓只有一个
// 池」用它：publishSubmoduleHeads 往它推对象、merge-back 在它里面跑 merge-tree
// 和 update-ref、dropNodePoolRefs 从它删 ref。
//
// 每个 submodule 拥有各自独立的 module dir，也就各自独立的 ODB。于是第二个及
// 以后的子仓，对象被推进了**别人的**池，而 canonical 侧要 checkout 时看的是
// 自己的池 ⟹ `fatal: unable to read tree` ⟹ merge-back 抛 materialize-failed，
// 节点产出全部搁浅。
//
// 触发条件低到不能再低：**仓里有两个 submodule 就够了**，以及任何嵌套——也就是
// 本 RFC 的招牌场景 AC-4。而既有 rfc210-* 测试全部只用一个根层 `vendor`，所以
// 一条都红不了。
//
// 这里锁两个形状：平级两个子仓（且节点动的是排序靠后的那个，确保它不是被当作
// "第一个池"的那一个），以及一层嵌套。

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

const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc210-mp-home-'))
const created: string[] = []

// Must be set in THIS file: `bun test` shares one process locally (so a sibling
// file's setting leaks and everything looks green) while CI runs --isolate.
let prevGitGlobal: string | undefined
const gitCfgDir = mkdtempSync(join(tmpdir(), 'aw-rfc210-mp-gitcfg-'))

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

describe('RFC-210 — two sibling submodules', () => {
  test('a node commit in the SECOND submodule survives merge-back', async () => {
    const subA = tmp('aw-rfc210-mp-a-')
    await initRepo(subA, 'a.txt', 'a1\n')
    const subZ = tmp('aw-rfc210-mp-z-')
    await initRepo(subZ, 'z.txt', 'z1\n')
    const host = tmp('aw-rfc210-mp-host-')
    await initRepo(host, 'README.md', 'root\n')
    // `aaa` is added first, so it is the one the old code recorded as THE pool.
    await runGit(host, [...ADD, subA, 'aaa'])
    await runGit(host, [...ADD, subZ, 'zzz'])
    await runGit(host, ['commit', '-q', '-m', 'add two submodules'])
    const canon = join(tmp('aw-rfc210-mp-wt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '-q'])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tmp2',
      nodeRunId: 'rmp2',
      canonRepos: [canonRepo(canon)],
    })
    // Both submodules must have resolved a pool, and they must be DIFFERENT
    // ones — that is the whole point.
    const pools = handle.repos[0]!.poolDirs
    expect(Object.keys(pools).sort()).toEqual(['aaa', 'zzz'])
    expect(pools['aaa']).not.toBe(pools['zzz'])

    // The node touches only `zzz` — the one that was NOT the recorded pool.
    const isoZ = join(handle.repos[0]!.isoWorktreePath, 'zzz')
    writeFileSync(join(isoZ, 'z.txt'), 'edited-by-node\n')
    const nodeSha = await commitIn(isoZ, 'node edits second submodule')

    // Before the fix this threw:
    //   materialize-failed: submodule 'zzz' cannot be moved to <sha>:
    //   fatal: unable to read tree (<sha>)
    // because zzz's objects had been published into aaa's pool.
    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)

    const canonZ = join(canon, 'zzz')
    expect((await runGit(canonZ, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(nodeSha)
    expect(readFileSync(join(canonZ, 'z.txt'), 'utf8')).toBe('edited-by-node\n')
    // The untouched sibling stays put.
    expect(readFileSync(join(canon, 'aaa', 'a.txt'), 'utf8')).toBe('a1\n')
  })
})

describe('RFC-210 — nested submodule (AC-4)', () => {
  test('a node commit in vendor/inner survives merge-back', async () => {
    const inner = tmp('aw-rfc210-mp-inner-')
    await initRepo(inner, 'i.txt', 'i1\n')
    const outer = tmp('aw-rfc210-mp-outer-')
    await initRepo(outer, 'o.txt', 'o1\n')
    await runGit(outer, [...ADD, inner, 'inner'])
    await runGit(outer, ['commit', '-q', '-m', 'outer gains inner'])
    const host = tmp('aw-rfc210-mp-nhost-')
    await initRepo(host, 'README.md', 'root\n')
    await runGit(host, [...ADD, outer, 'vendor'])
    await runGit(host, ['commit', '-q', '-m', 'add nested submodule'])

    const canon = join(tmp('aw-rfc210-mp-nwt-'), 'canon')
    await runGit(host, ['worktree', 'add', '-q', '--detach', canon, 'HEAD'])
    await runGit(canon, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive',
      '-q',
    ])

    const handle = await createNodeIso({
      appHome,
      taskId: 'tmpn',
      nodeRunId: 'rmpn',
      canonRepos: [canonRepo(canon)],
    })
    const isoInner = join(handle.repos[0]!.isoWorktreePath, 'vendor', 'inner')
    writeFileSync(join(isoInner, 'i.txt'), 'edited-by-node\n')
    const innerSha = await commitIn(isoInner, 'node edits nested submodule')
    // The outer submodule must record the new inner gitlink, otherwise nothing
    // above it can see the change.
    const isoOuter = join(handle.repos[0]!.isoWorktreePath, 'vendor')
    await commitIn(isoOuter, 'outer records inner')

    const res = await mergeBackNodeIso(handle, await snapshotNodeIsoFinal(handle))
    expect(res.clean).toBe(true)

    const canonInner = join(canon, 'vendor', 'inner')
    expect((await runGit(canonInner, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(innerSha)
    expect(readFileSync(join(canonInner, 'i.txt'), 'utf8')).toBe('edited-by-node\n')
  })
})
