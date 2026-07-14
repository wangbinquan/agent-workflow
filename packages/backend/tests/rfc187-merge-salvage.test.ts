// RFC-187 PR-2 — §4-2 fan-out 合并逐路径救回 + human-replay 恢复契约修复。
//
// 锁三件事（workgroup-e2e-audit §4-2 + design.md §2.2 / §8 P1-9）：
//   1. buildSalvageTree：冲突 merge 的「救回树」= mergedTree 上把冲突路径回退为
//      ours 条目（ours 缺失 ⇒ 删除）；目录级冲突 fail-closed 返回 null。
//   2. mergeBackNodeIso：冲突 repo 不再整仓扣留——干净路径立刻 materialize、
//      仅冲突路径保持 canonical 原样，`salvagedPaths` 结构化上报；重放幂等
//      （第二次跑救回为空、canonical 不再变化）。
//   3. completeHumanResolvedConflict：多 repo 冲突里「干净且已落地、从无
//      resolve-iso」的 repo 不再被无条件判 unresolved 而把任务永久卡死
//      （设计门 P1-9 前置契约修复）——红→绿测试。
//
// 全部跑真实临时 git 仓（同 rfc130-iso-worktree-primitives.test.ts 模式）。

import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSalvageTree,
  commitTree,
  mergeTreeInMemory,
  runGit,
  snapshotFullState,
} from '../src/util/git'
import {
  completeHumanResolvedConflict,
  mergeBackNodeIso,
  type IsoHandle,
  type IsoRepo,
} from '../src/services/nodeIsolation'

async function initRepo(seed: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc187-salvage-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  for (const [p, content] of Object.entries(seed)) writeFileSync(join(dir, p), content)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}
async function head(dir: string): Promise<string> {
  return (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim()
}

/** Capture a "theirs" commit: mutate the worktree, snapshot, then restore. */
async function captureTheirs(dir: string, mutate: () => void): Promise<string> {
  mutate()
  const theirs = await snapshotFullState(dir)
  await runGit(dir, ['checkout', '--', '.'])
  await runGit(dir, ['clean', '-fd'])
  return theirs
}

function repoEntry(dir: string, worktreeDirName: string, base: string, baseHead: string): IsoRepo {
  return {
    repoPath: dir,
    canonWorktreePath: dir,
    isoWorktreePath: join(dir, '.aw-unused-iso'),
    worktreeDirName,
    baseBranch: 'main',
    baseSnapshot: base,
    taskBaseHead: baseHead,
  }
}

function handleFor(container: string, repos: IsoRepo[]): IsoHandle {
  return { taskId: 't1', nodeRunId: 'r1', containerPath: container, repos, passthrough: false }
}

describe('RFC-187 §4-2 buildSalvageTree', () => {
  test('冲突路径回退 ours、干净路径保留 merge 结果；ours 缺失路径删除', async () => {
    const repo = await initRepo({
      'conflict.txt': 'base\n',
      'clean.txt': 'base-clean\n',
      'del.txt': 'base-del\n',
    })
    const base = await snapshotFullState(repo)
    const theirs = await captureTheirs(repo, () => {
      writeFileSync(join(repo, 'conflict.txt'), 'theirs\n')
      writeFileSync(join(repo, 'clean.txt'), 'theirs-clean\n')
      writeFileSync(join(repo, 'del.txt'), 'theirs-del\n')
      writeFileSync(join(repo, 'new.txt'), 'from-theirs\n')
    })
    // ours 侧分叉：改 conflict.txt（制造内容冲突）+ 删 del.txt（modify/delete 冲突）。
    writeFileSync(join(repo, 'conflict.txt'), 'ours\n')
    rmSync(join(repo, 'del.txt'))
    const ours = await snapshotFullState(repo)
    const merge = await mergeTreeInMemory(repo, { base, ours, theirs })
    expect(merge.conflicts.sort()).toEqual(['conflict.txt', 'del.txt'])

    const salvage = await buildSalvageTree(repo, {
      mergedTree: merge.mergedTree,
      ours,
      conflicts: merge.conflicts,
    })
    expect(salvage).not.toBeNull()
    // 干净路径落进救回树；冲突路径 = ours 内容；del.txt 保持 ours 的「已删除」。
    const ls = (await runGit(repo, ['ls-tree', '-r', '--name-only', salvage!.tree])).stdout
    expect(ls).toContain('clean.txt')
    expect(ls).toContain('new.txt')
    expect(ls).not.toContain('del.txt')
    const conflictBlob = (await runGit(repo, ['show', `${salvage!.tree}:conflict.txt`])).stdout
    expect(conflictBlob).toBe('ours\n')
    expect(salvage!.landedPaths.sort()).toEqual(['clean.txt', 'new.txt'])
    rmSync(repo, { recursive: true, force: true })
  })

  test('file↔dir 冲突：merge-ort 把文件侧改名为 `d~<oid>` 报冲突——救回树把它回退掉、ours 目录保留、无干净路径可落', async () => {
    const repo = await initRepo({ 'seed.txt': 's\n' })
    const base = await snapshotFullState(repo)
    const theirs = await captureTheirs(repo, () => {
      writeFileSync(join(repo, 'd'), 'theirs-file\n')
      writeFileSync(join(repo, 'clean.txt'), 'theirs-clean\n')
    })
    // ours: d 是目录（file/directory 冲突）；clean.txt 只 theirs 改 → 干净可救。
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(repo, 'd'), { recursive: true })
    writeFileSync(join(repo, 'd', 'x.txt'), 'ours-dir\n')
    const ours = await snapshotFullState(repo)
    const merge = await mergeTreeInMemory(repo, { base, ours, theirs })
    // merge-ort 语义：directory in the way → 文件被改名为 `d~<oid>` 并报为冲突路径。
    expect(merge.conflicts).toHaveLength(1)
    expect(merge.conflicts[0]!).toMatch(/^d~/)
    const salvage = await buildSalvageTree(repo, {
      mergedTree: merge.mergedTree,
      ours,
      conflicts: merge.conflicts,
    })
    // 改名冲突文件在 ours 缺失 → 从救回树删除；干净兄弟路径照常落地。
    expect(salvage).not.toBeNull()
    expect(salvage!.landedPaths).toEqual(['clean.txt'])
    const ls = (await runGit(repo, ['ls-tree', '-r', '--name-only', salvage!.tree])).stdout
    expect(ls).toContain('d/x.txt')
    expect(ls).toContain('clean.txt')
    expect(ls).not.toMatch(/^d~/m)
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('RFC-187 §4-2 mergeBackNodeIso 逐路径救回', () => {
  test('冲突 repo：干净路径立刻落地 + salvagedPaths 上报；冲突路径保持 ours；重放幂等', async () => {
    const repo = await initRepo({ 'conflict.txt': 'base\n', 'clean.txt': 'base-clean\n' })
    const baseHead = await head(repo)
    const base = await snapshotFullState(repo)
    const theirs = await captureTheirs(repo, () => {
      writeFileSync(join(repo, 'conflict.txt'), 'theirs\n')
      writeFileSync(join(repo, 'clean.txt'), 'theirs-clean\n')
    })
    writeFileSync(join(repo, 'conflict.txt'), 'ours\n')

    const container = mkdtempSync(join(tmpdir(), 'aw-rfc187-container-'))
    const handle = handleFor(container, [repoEntry(repo, '', base, baseHead)])
    const res = await mergeBackNodeIso(handle, { '': theirs })
    expect(res.clean).toBe(false)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]!.paths).toEqual(['conflict.txt'])
    // 干净路径已经落进 canonical；冲突路径保持 ours。
    expect(res.conflicts[0]!.salvagedPaths).toEqual(['clean.txt'])
    expect(readFileSync(join(repo, 'clean.txt'), 'utf8')).toBe('theirs-clean\n')
    expect(readFileSync(join(repo, 'conflict.txt'), 'utf8')).toBe('ours\n')
    // HEAD 未动、delta UNSTAGED（materializeTree 契约不因救回而变）。
    expect(await head(repo)).toBe(baseHead)

    // 重放（pending-merge replay 语义）：同一 nodeTrees 再跑一次 —— 冲突照旧、
    // 救回集为空（没有新东西可落）、canonical 内容不再变化。
    const res2 = await mergeBackNodeIso(handle, { '': theirs })
    expect(res2.clean).toBe(false)
    expect(res2.conflicts[0]!.paths).toEqual(['conflict.txt'])
    expect(res2.conflicts[0]!.salvagedPaths).toEqual([])
    expect(readFileSync(join(repo, 'clean.txt'), 'utf8')).toBe('theirs-clean\n')
    expect(readFileSync(join(repo, 'conflict.txt'), 'utf8')).toBe('ours\n')
    rmSync(repo, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
  })
})

describe('RFC-187 human-replay 契约（设计门 P1-9 前置）', () => {
  test('多 repo：干净已落地且无 resolve-iso 的 repo 不再卡死 allResolved（红→绿）', async () => {
    // repo A：真冲突，human 已在 resolve-iso 里解完。
    const repoA = await initRepo({ 'conflict.txt': 'base\n' })
    const baseHeadA = await head(repoA)
    const baseA = await snapshotFullState(repoA)
    const theirsA = await captureTheirs(repoA, () => {
      writeFileSync(join(repoA, 'conflict.txt'), 'theirs\n')
    })
    writeFileSync(join(repoA, 'conflict.txt'), 'ours\n')
    const mergeA = await mergeTreeInMemory(repoA, {
      base: baseA,
      ours: await snapshotFullState(repoA),
      theirs: theirsA,
    })
    expect(mergeA.conflicts).toEqual(['conflict.txt'])
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc187-hr-'))
    // 按 resolveConflictWithAgent §6.2① 的方式搭 resolve-iso（parent=ours-at-conflict）。
    const oursAtConflict = await snapshotFullState(repoA)
    const cmt = await commitTree(repoA, mergeA.mergedTree, oursAtConflict, 'aw-conflict')
    const resolveIso = join(container, 'resolve-a')
    const add = await runGit(repoA, ['worktree', 'add', '--detach', resolveIso, cmt])
    expect(add.exitCode).toBe(0)
    writeFileSync(join(resolveIso, 'conflict.txt'), 'resolved\n') // human 解冲突

    // repo B：当初干净合并、已 materialize 进 canonical，从无 resolve-iso。
    const repoB = await initRepo({ 'b.txt': 'base-b\n' })
    const baseHeadB = await head(repoB)
    const baseB = await snapshotFullState(repoB)
    const theirsB = await captureTheirs(repoB, () => {
      writeFileSync(join(repoB, 'newb.txt'), 'from-b-node\n')
    })
    writeFileSync(join(repoB, 'newb.txt'), 'from-b-node\n') // 已落地状态

    const handle = handleFor(container, [
      repoEntry(repoA, 'a', baseA, baseHeadA),
      repoEntry(repoB, 'b', baseB, baseHeadB),
    ])
    const outcome = await completeHumanResolvedConflict(handle, { a: theirsA, b: theirsB })
    // 旧代码：repo B 因 resolve-iso 不存在被无条件 push 进 unresolved → 永久 park。
    expect(outcome.unresolvedRepos).toEqual([])
    expect(outcome.allResolved).toBe(true)
    expect(readFileSync(join(repoA, 'conflict.txt'), 'utf8')).toBe('resolved\n')
    expect(readFileSync(join(repoB, 'newb.txt'), 'utf8')).toBe('from-b-node\n')
    expect(existsSync(resolveIso)).toBe(false) // 解完即回收
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
  })

  test('无 resolve-iso 且探测仍冲突（iso 被手删）→ 维持 parked（行为不变）', async () => {
    const repo = await initRepo({ 'conflict.txt': 'base\n' })
    const baseHead = await head(repo)
    const base = await snapshotFullState(repo)
    const theirs = await captureTheirs(repo, () => {
      writeFileSync(join(repo, 'conflict.txt'), 'theirs\n')
    })
    writeFileSync(join(repo, 'conflict.txt'), 'ours\n')
    const container = mkdtempSync(join(tmpdir(), 'aw-rfc187-hr2-'))
    const handle = handleFor(container, [repoEntry(repo, '', base, baseHead)])
    const outcome = await completeHumanResolvedConflict(handle, { '': theirs })
    expect(outcome.allResolved).toBe(false)
    expect(outcome.unresolvedRepos).toEqual([''])
    rmSync(repo, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
  })
})
