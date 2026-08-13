// RFC-188 — isolatedAgentRun 原语单测 + 装配单源锁。
//
// 背景：「一次隔离 agent 执行」的装配序列曾在 scheduler.ts 手抄五处
// （runOneNode §段③ / fanout shard / aggregator / workgroup runHostNode /
// replayPendingMerges），RFC-184/186/187 历次 bug 均系该层漂移。本文件锁：
//   A. mergeBackAndSettle 行为：live 干净合并（快照+persist+merged 转移）/
//      冲突走注入 resolver（解=merged；不解=park conflict-human）/ replay
//      传持久树跳过快照 / git 错误裸抛（merge-failed 停留在站点）。
//   B. createIsoUnderLock：writeSem 窗口内建 iso（互斥断言）。
//   C. markMergeFailed：try-variant 不吞原始错误、CAS 失败仅告警。
//   D. 装配单源（表级 allowlist）：scheduler.ts 里裸 createNodeIso/
//      mergeBackNodeIso/snapshotNodeIsoFinal 只允许 wrapper 路径的 1 处；
//      五个 agent 站点必须走 createIsoUnderLock/mergeBackAndSettle。
//
// 端到端 golden 由既有套件承担：rfc130-crash-replay（replay 站点）、
// rfc185-leader-fanout / rfc187-fanout-salvage-e2e（hook+并发 merge）、
// scheduler.test 等（主线）。

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createIsoUnderLock,
  markMergeFailed,
  mergeBackAndSettle,
  persistIsoBase,
} from '../src/services/isolatedAgentRun'
import { discardNodeIso, type CanonRepo, type IsoHandle } from '../src/services/nodeIsolation'
import { runGit, snapshotFullState } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function initRepo(seed: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc188-'))
  await runGit(dir, ['init', '-q', '-b', 'main'])
  await runGit(dir, ['config', 'user.email', 't@e.com'])
  await runGit(dir, ['config', 'user.name', 'T'])
  for (const [p, c] of Object.entries(seed)) writeFileSync(join(dir, p), c)
  await runGit(dir, ['add', '.'])
  await runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

/** Serial write-sem stub that also records depth so tests can assert the
 *  iso/merge work actually ran INSIDE the lock window. */
function stubWriteSem(): { run<T>(fn: () => Promise<T>): Promise<T>; maxDepth: () => number } {
  let depth = 0
  let max = 0
  let chain: Promise<unknown> = Promise.resolve()
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(async () => {
        depth++
        max = Math.max(max, depth)
        try {
          return await fn()
        } finally {
          depth--
        }
      })
      chain = next.catch(() => undefined)
      return next as Promise<T>
    },
    maxDepth: () => max,
  }
}

async function seedTaskRow(db: DbClient, worktreePath: string): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: worktreePath,
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

function canonRepos(worktreePath: string): CanonRepo[] {
  return [{ repoPath: worktreePath, worktreePath, worktreeDirName: '', baseBranch: 'main' }]
}

async function mintedRow(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'A',
    status: 'running',
    startedAt: Date.now(),
  })
  return id
}

describe('RFC-188 A/B — createIsoUnderLock + mergeBackAndSettle（live 干净合并）', () => {
  test('iso 在锁窗口内创建；产物经 settle 落 canonical、merge_state=merged', async () => {
    const repo = await initRepo({ 'seed.txt': 's\n' })
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskRow(db, repo)
    const runId = await mintedRow(db, taskId)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc188-home-'))
    const writeSem = stubWriteSem()

    const iso: IsoHandle = await createIsoUnderLock({
      writeSem,
      appHome,
      taskId,
      db,
      isoKeyRunId: runId,
      canonRepos: canonRepos(repo),
    })
    expect(writeSem.maxDepth()).toBeGreaterThanOrEqual(1)
    await persistIsoBase(db, runId, 1, iso)
    writeFileSync(join(iso.repos[0]!.isoWorktreePath, 'out.txt'), 'from-agent\n')

    const settle = await mergeBackAndSettle({
      db,
      writeSem,
      handle: iso,
      nodeRunId: runId,
      repoCount: 1,
      via: 'live',
      conflictResolver: () => {
        throw new Error('clean merge must not consult the resolver')
      },
    })
    expect(settle.kind).toBe('merged')
    expect(readFileSync(join(repo, 'out.txt'), 'utf8')).toBe('from-agent\n')
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(row?.mergeState).toBe('merged')
    // node tree 已持久化（isolating→pending-merge→merged 全链 CAS 走通）。
    expect(row?.isoNodeTree).toBeTruthy()
    await discardNodeIso(iso)
    rmSync(repo, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  test('冲突：resolver 判不解 → park conflict-human + detail 透传；判解 → merged', async () => {
    const repo = await initRepo({ 'f.txt': 'base\n' })
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskRow(db, repo)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc188-home2-'))
    const writeSem = stubWriteSem()

    for (const resolved of [false, true]) {
      const runId = await mintedRow(db, taskId)
      const iso = await createIsoUnderLock({
        writeSem,
        appHome,
        taskId,
        db,
        isoKeyRunId: runId,
        canonRepos: canonRepos(repo),
      })
      await persistIsoBase(db, runId, 1, iso)
      // iso 与 canonical 同文件分叉 → 真冲突。
      writeFileSync(join(iso.repos[0]!.isoWorktreePath, 'f.txt'), `iso-${resolved}\n`)
      writeFileSync(join(repo, 'f.txt'), `canon-${resolved}\n`)

      let sawConflicts = 0
      const settle = await mergeBackAndSettle({
        db,
        writeSem,
        handle: iso,
        nodeRunId: runId,
        repoCount: 1,
        via: 'live',
        conflictResolver: async (conflicts) => {
          sawConflicts = conflicts.length
          return { allResolved: resolved, detail: resolved ? '' : 'f.txt unresolved' }
        },
      })
      expect(sawConflicts).toBe(1)
      const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
      if (resolved) {
        expect(settle.kind).toBe('merged')
        expect(row?.mergeState).toBe('merged')
      } else {
        expect(settle.kind).toBe('conflict-human')
        expect(settle.detail).toContain('f.txt')
        expect(row?.mergeState).toBe('conflict-human')
      }
      await discardNodeIso(iso)
      // 复原 canonical，供下一轮。
      await runGit(repo, ['checkout', '--', '.'])
    }
    rmSync(repo, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })

  test('replay：传持久 nodeTrees 跳过快照（iso 工作树可以已消失），merged via=replay', async () => {
    const repo = await initRepo({ 'seed.txt': 's\n' })
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskRow(db, repo)
    const runId = await mintedRow(db, taskId)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc188-home3-'))
    const writeSem = stubWriteSem()

    const iso = await createIsoUnderLock({
      writeSem,
      appHome,
      taskId,
      db,
      isoKeyRunId: runId,
      canonRepos: canonRepos(repo),
    })
    await persistIsoBase(db, runId, 1, iso)
    writeFileSync(join(iso.repos[0]!.isoWorktreePath, 'crash.txt'), 'survived\n')
    // 模拟 runner 成功后崩溃：pin 树、置 pending-merge、丢 iso 工作树。
    const nodeTree = await snapshotFullState(iso.repos[0]!.isoWorktreePath)
    await db
      .update(nodeRuns)
      .set({ mergeState: 'pending-merge', isoNodeTree: nodeTree })
      .where(eq(nodeRuns.id, runId))
    await discardNodeIso(iso)

    const settle = await mergeBackAndSettle({
      db,
      writeSem,
      handle: iso, // rebuildIsoHandle 等价物：repos 元数据仍在
      nodeRunId: runId,
      repoCount: 1,
      nodeTrees: { '': nodeTree },
      via: 'replay',
      conflictResolver: () => {
        throw new Error('clean replay must not consult the resolver')
      },
    })
    expect(settle.kind).toBe('merged')
    expect(readFileSync(join(repo, 'crash.txt'), 'utf8')).toBe('survived\n')
    rmSync(repo, { recursive: true, force: true })
    rmSync(appHome, { recursive: true, force: true })
  })
})

describe('RFC-188 C — markMergeFailed try-variant', () => {
  test('pending-merge → merge-failed 落地；非法起点仅告警不抛（原始错误不被掩盖）', async () => {
    const repo = await initRepo({ 'seed.txt': 's\n' })
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskRow(db, repo)
    const runId = await mintedRow(db, taskId)
    await db.update(nodeRuns).set({ mergeState: 'pending-merge' }).where(eq(nodeRuns.id, runId))
    await markMergeFailed(db, runId, 'boom')
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(row?.mergeState).toBe('merge-failed')
    // 二次调用（已 merge-failed，非法转移）不得抛——RFC-144 §5。
    await markMergeFailed(db, runId, 'boom-again')
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('RFC-188 D — 装配单源锁（表级 allowlist）', () => {
  const src = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const count = (needle: string): number => src.split(needle).length - 1

  test('scheduler.ts 零裸 iso 创建；裸 merge 原语只剩 wrapper 路径各 1 处', () => {
    // wrapper 新建也必须经过 createIsoUnderLock，否则与顶层 sibling 并发
    // `git worktree add` 会竞争同一 `.git/worktrees` 注册表。wrapper merge
    // 生命周期仍在 RFC-188 agent-site 范围外；任何第 2 处裸 merge = 手抄装配。
    expect(count('createNodeIso(')).toBe(0)
    expect(count('mergeBackNodeIso(')).toBe(1)
    expect(count('snapshotNodeIsoFinal(')).toBe(1)
  })

  test('装配站点走共享锁：createIsoUnderLock×7 + mergeBackAndSettle×7 + markMergeFailed×6', () => {
    // 9 = workgroup hook / 主线首建 / 主线 fresh-session 重建 / shard /
    // aggregator / wrapper-private canonical / RFC-243 call 节点派生（D 步，
    // 子任务 canonical 的诞生点——与 agent 站点同一把 writeSem 短窗纪律）
    // + RFC-253 脚本节点的首建与 fresh-retry 重建两处（脚本改文件与 agent
    // 改文件在隔离/合回上没有任何理由不同档，故复用同一批原语）。
    // RFC-287 T5c：脚本线迁入骨架后，它的「首建 + fresh-retry 重建」两处收进了
    // 一个 `createScriptIso` 闭包（骨架的 iso.create 与 retryPolicy 的换树各调它
    // 一次），故计数 9→8。锁的不变量没变：每一处物化仍走同一把写锁短窗原语。
    // RFC-287 T7：agent 线同理再收一处 —— 迁移前「主线首建」与「fresh-session 重建」
    // 是两处各自手写的 `createIsoUnderLock(...)`，迁入骨架后只剩 `iso.create` 一个
    // 闭包（初次物化与 retryPolicy 换树都调它），故 8→7。**这不是覆盖变少**：物化
    // 站点本身合并了，两条调用路径仍都经过它（D17 的换树/留树判据在 keepIf 上）。
    expect(count('createIsoUnderLock(')).toBe(7)
    // 7 = hook / 主线 §段③ / shard / aggregator / replayPendingMerges /
    // RFC-243 call 节点 M 步（live 与 adoption-rebuild 共用同一调用点）
    // + RFC-253 脚本节点成功后的合回。
    expect(count('mergeBackAndSettle(')).toBe(7)
    // 6 = 主线（T7 后是 spec 的 markMergeFailed 钩子体内那一次调用）/ shard /
    // aggregator + RFC-243 call 的 adoption base 缺失与
    // merge 异常两处（hook 有意不打——留 pending-merge 走重放；wrapper 不在此列）
    // + **RFC-287 T5a 新增的脚本线**：漂移 A 修复前脚本线的 merge 是裸调用、没有
    // catch，所以压根没有这处标记；收敛到与其余四线同处置后才有（C1 的直接产物）。
    expect(count('markMergeFailed(')).toBe(6)
  })
})
