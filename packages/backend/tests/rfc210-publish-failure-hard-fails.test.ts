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

  // 骨架默认 onThrow：keep=true 之后才调 markMergeFailed（顺序不可颠倒——先标记
  // 后置 keep 的写法在标记抛出时会漏掉 keep，正是 RFC-210 要防的丢副本）。
  const ASSEMBLY_KEEP_ON_THROW =
    /keep = true\n\s*if \(spec\.markMergeFailed === undefined\)[\s\S]{0,320}await spec\.markMergeFailed\(/

  test('EVERY task-execution site keeps the iso when merge-back throws (source-level lock)', () => {
    // The full scheduler loop is too heavy to spin here; lock the disposition
    // at the source level instead (repo policy: minimum one source-text
    // assertion when the runtime shape is impractical to integrate). Each
    // execution mode's merge-throw path MUST keep the iso — it can hold the
    // only copy of the node's product when the snapshot phase itself failed.
    // Codex review round 2 (P1): the mainline alone is not enough; the
    // workgroup hook, fanout shard and aggregator discard in `finally` too.
    const wrapperMechanics = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'wrapperMechanics.ts',
      ),
      'utf8',
    )
    const recovery = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'executionMergeRecovery.ts',
      ),
      'utf8',
    )
    const src = `${wrapperMechanics}\n${recovery}`
    const nodeMechanics = readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'task-execution',
        'composition',
        'nodeMechanics.ts',
      ),
      'utf8',
    )
    // Mainline DAG (agent 线): RFC-287 T7 起本线也迁入装配骨架。合并抛出的 keep
    // 不再是 catch 里的 `keepIso = true`，而是**骨架默认处置**（`keep = true` +
    // `spec.markMergeFailed`）——本线不覆写 onThrow，因此吃的就是那条默认。
    // 不变量（合并抛出必须保住 iso，它可能是产物唯一副本）由骨架单点保证，逐格
    // 断言在 rfc287-t1-merge-disposition-matrix；这里锁「本线确实走默认」：
    // 它声明了 markMergeFailed 钩子，且**没有**自己的 onThrow 覆写。
    // runScope 在文件里排在 runOneNode **之前**，不能拿它当右边界（会切出空串）；
    // 取到函数自身的顶格 `}` 为止。
    const agentStart = nodeMechanics.indexOf('async function runAgentSingleNode(')
    expect(agentStart).toBeGreaterThan(-1)
    const agentLine = nodeMechanics.slice(agentStart, nodeMechanics.indexOf('\n}\n', agentStart))
    const assemblySrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'schedulerAssembly.ts'),
      'utf8',
    )
    expect(agentLine).toContain('markMergeFailed: async (msg) => {')
    expect(agentLine).not.toMatch(/onThrow:/)
    expect(ASSEMBLY_KEEP_ON_THROW.test(assemblySrc)).toBe(true)
    // Fanout shard: RFC-287 T4 起同聚合线一起迁入装配骨架——keep 语义从「布尔标志
    // + finally 谓词」变成 spec 上的声明（合并抛出走 disposition.onThrow → keep:true，
    // 清理由骨架的 if (!keep) discardIso 统一执行）。本条锁的不变量（合并抛出必须
    // 保住 iso——它可能是该节点产物的唯一副本）现由 rfc287-t1-merge-disposition-matrix
    // 的行为夹具接管；此处只留「声明存在」的浅锁。
    expect(src).toMatch(/onThrow: \(err\) => \(\{\s*keep: true/)
    expect(src).toContain('keepFromOutcome: (result) => result.processUnreaped === true')
    // Fanout aggregator: RFC-287 T3 起该线已迁入装配骨架，keep 语义从「函数体里的
    // 布尔标志 + finally 谓词」变成 spec 上的**声明**：合并抛出走
    // `disposition.onThrow → keep: true`，清理由骨架的 `if (!keep) discardIso` 统一
    // 执行（释放先于清理，见 rfc287-t1-release-before-discard 的跨文件结构锁）。
    // ⚠️ 本条锁的不变量（合并抛出必须保住 iso——它可能是该节点产物的唯一副本）
    // 现由 **rfc287-t1-merge-disposition-matrix** 的行为夹具接管，那里逐格断言
    // 「聚合线：撞冲突 keep=false 判失败、抛出 keep=true + markMergeFailed」。
    // 这里只保留「声明存在」的浅锁，避免同一不变量两处各锁一半。
    expect(src).toMatch(/onThrow: \(err\) => \(\{\s*keep: true/)
    expect(src).toContain('keepFromOutcome: (result) => result.processUnreaped === true')
    // Workgroup hook: RFC-287 T6 起同样迁入装配骨架。合并抛出的 keep 从「布尔标志 +
    // finally 谓词」变成 spec 声明 `disposition.onThrow → keep: true, then: 'rethrow'`
    // （重抛给外层，merge_state 留在 pending-merge 交 entry replay）；`keepHookIso`
    // 仍在，但只承载**另一维**——processUnreaped（旧 child 可能还活着，树不能收）。
    // 逐格断言同样由 rfc287-t1-merge-disposition-matrix 接管，这里只留浅锁。
    expect(nodeMechanics).toContain('keepHookIso = true')
    expect(nodeMechanics).toMatch(/onThrow: \(\) => \(\{ keep: true, then: 'rethrow' as const \}\)/)
    // Round 5 (P2): successfully REPLAYED merges must close the iso lifecycle
    // too — without these, node pool refs leak forever and a new path's
    // worktree anchor is never handed over.
    const replayMerged = src.match(
      /pending-merge replay merged[\s\S]{0,600}?discardNodeIso\(handle, log, state\.writeSem\)/,
    )
    expect(replayMerged).not.toBeNull()
    const humanResolved = src.match(
      /human resolution merged back[\s\S]{0,600}?discardNodeIso\(handle, log, state\.writeSem\)/,
    )
    expect(humanResolved).not.toBeNull()
    // Round 5 (P1): the discard-time anchor handoff must be a CAS (expected-old
    // guard) — an unconditional write races concurrent merge-backs.
    const iso = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'nodeIsolation.ts'),
      'utf8',
    )
    expect(iso).toContain("['update-ref', wtRef, sha, expectedOld]")
    // Round 6 (P1): the handoff must be offered the task write lock at every
    // scheduler discard — outside it a known-path merge can interleave and the
    // CAS can move the anchor backward.
    // Ratchet: every single-line discard passes the lock; the one multiline
    // call (wrapper stale cleanup) is asserted by its trailing args. A NEW
    // discard site must consciously join this accounting.
    // RFC-287 T3 起改为**跨文件**扫描：装配线陆续迁入 schedulerAssembly.ts，只扫
    // scheduler.ts 会让计数一路掉到阈值以下，而「把 8 改小」正是这条锁最容易被
    // 糊弄过去的方式（T1① 已把本文件登记为「必须换成行为夹具、不许改锚了事」）。
    // 扫两个文件的并集则对「代码搬到哪」免疫：新增 discard 站点仍必须自觉入账。
    const assembly = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'schedulerAssembly.ts'),
      'utf8',
    )
    const singleLine = [
      ...(src.match(/discardNodeIso\([^\n)]*\)/g) ?? []),
      ...(nodeMechanics.match(/discardNodeIso\([^\n)]*\)/g) ?? []),
      // 骨架里的清理走注入的 discardIso（其实参在各线 spec 上写明带 writeSem）。
      ...(assembly.match(/discardIso\([^\n)]*\)/g) ?? []),
    ]
    expect(singleLine.length).toBeGreaterThanOrEqual(8)
    for (const call of singleLine) {
      // 骨架内的调用是 `spec.discardIso(handle)`——写锁由各线 spec 的实参携带，
      // 由 rfc287-t1-release-before-discard 的结构锁保证顺序，此处只查 execution
      // 侧的直调仍带锁。
      if (call.startsWith('discardNodeIso(')) expect(call).toContain('writeSem')
    }
    expect(src).toContain('state.log,\n      state.writeSem,\n    )')
    // Round 6 (P2): replay rebuilds must address the PHYSICAL iso identity.
    expect(src).toContain('nodeRunId: isoKeyOf(r.isoWorktreePath, r.id)')
    // And the iso worktree remains on disk in the unit-level flows above; the
    // existence of the discard-in-finally is exactly why the flags must flip.
    expect(existsSync(appHome)).toBe(true)
  })
})
