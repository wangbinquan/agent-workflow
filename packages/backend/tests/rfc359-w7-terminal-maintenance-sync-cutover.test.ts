// LOCKS: RFC-359 W7 —— 终态维护的三条消费路径迁离 `dbTxSync` 之后的行为（两个引擎各跑一遍）。
//
// 为什么这份用例存在
// ---------------------------------------------------------------------------
// `sqliteTerminalMaintenance.ts`（519 行、5 处 `dbTxSync`）此前被三处生产代码消费，用的是**同步端口
// 独有**的 `assertClaimTx` / `transitionTx`（`DbTxSync` 参与者）——`services/taskDelete.ts` 的删除事务、
// `services/taskArchive.ts` 的 `deleteTreeRows`、`platform/persistence/sqlite/systemWorkspaceGc.ts` 的
// GC 终结事务。只要它们还挂在 bun:sqlite 的同步事务面上，这三条路径就天生只能在 SQLite 上跑。
// 本轮把它们改成中立原语 `databaseSessionFor(db).transaction(...)` + 中立参与者
// `terminalMaintenanceClaim.ts`，`sqliteTerminalMaintenance.ts` 随之整体退役。
//
// 这**不是纯搬运**：同步事务变成异步事务，多出事件循环让渡窗口、多出「漏 await 静默通过类型检查」
// 与「体内抛错到底回没回滚」两类新失败模式（`docs/dev-gotchas.md` 记着 RFC-359 批 2f 的可见性缝事故与
// 「摘掉 .run() 必须同时补 await」的自伤）。所以每条路径都锁两件事：
//
//   ① **写真的落库了**（漏 await 的症状永远是「写好像没生效」）；
//   ② **体内抛错时整笔回滚**——认领 revision 不前进、业务行不半删。
//
// 逐条对应：
//   T1  delete：认领链 claimed→io-complete→db-finalized→completed + 成员释放 + 父行
//       `branch_started_at` 沿父链重算（RFC-311 P1-6，同时把 `MAX()` 聚合读在两个引擎上照一遍）。
//   T2  delete：**事务内**终态复检。持有任务写锁把 `deleteTask` 卡在锁上，趁机把任务翻回 running；
//       事务必须整笔失败——行还在、认领仍停在 io-complete、revision 不变。
//   T3  archive：`archiveTaskTree` 整棵树出库（`deleteTreeRows` 的递归 CTE + 分块删除）。
//   T4  archive：`recoverInterruptedArchives` 接着一个停在 io-complete 的认领续做。
//   T5  workspace-GC：`finishClaimedWorkspacePrune` 端到端（认领 → 删目录 → 终结事务盖章）。
//   T6  workspace-GC：终结事务的原子性。墓碑（`workspace_pruning_at`）被抹掉后 CAS 命中 0 行，
//       整笔回滚——`workspace_pruned_at` 仍为空、认领仍停在 io-complete。

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  taskFeedback,
  tasks,
  workflows,
} from '@/db/schema'
import { DrizzleTerminalMaintenancePersistence } from '@/modules/task-execution/infrastructure/terminalMaintenancePersistence'
import {
  finishClaimedWorkspacePrune,
  recoverInterruptedWorkspaceGc,
} from '@/platform/persistence/sqlite/systemWorkspaceGc'
import { archiveTaskTree, recoverInterruptedArchives } from '@/services/taskArchive'
import { deleteTask } from '@/services/taskDelete'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
const NOW = 1_788_364_800_000

let appHome: string
let previousHome: string | undefined

beforeAll(() => {
  previousHome = process.env.AGENT_WORKFLOW_HOME
  appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-cutover-'))
  process.env.AGENT_WORKFLOW_HOME = appHome
})

afterAll(() => {
  if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = previousHome
  rmSync(appHome, { recursive: true, force: true })
})

const scratchDirs: string[] = []
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function id(prefix: string): string {
  return `${prefix}_${ulid()}`
}

/** `services/*` 与 `platform/persistence/sqlite/*` 的形参仍写着 legacy 的 bun:sqlite 句柄类型；
 *  本轮之后它们的事务面是中立的，两个引擎上跑的是同一段代码。 */
function legacy(db: ProviderNeutralDatabase): DbClient {
  return db as unknown as DbClient
}

function store(db: ProviderNeutralDatabase): DrizzleTerminalMaintenancePersistence {
  return new DrizzleTerminalMaintenancePersistence(db)
}

async function seedWorkflow(db: ProviderNeutralDatabase): Promise<string> {
  const workflowId = id('wf')
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  return workflowId
}

async function seedTask(
  db: ProviderNeutralDatabase,
  workflowId: string,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const taskId = (over.id as string | undefined) ?? id('task')
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: NOW - 10_000,
    finishedAt: NOW - 5_000,
    executionLineageId: taskId,
    ...over,
  })
  return taskId
}

async function claimRow(
  db: ProviderNeutralDatabase,
  claimId: string,
): Promise<{ state: string; revision: number } | undefined> {
  return (
    await db
      .select({
        state: taskExecutionMaintenanceClaims.state,
        revision: taskExecutionMaintenanceClaims.revision,
      })
      .from(taskExecutionMaintenanceClaims)
      .where(eq(taskExecutionMaintenanceClaims.id, claimId))
      .limit(1)
  )[0]
}

async function taskExists(db: ProviderNeutralDatabase, taskId: string): Promise<boolean> {
  return (
    (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1)).length ===
    1
  )
}

function makeScratchDir(name: string): string {
  const dir = join(appHome, `${name}-${ulid()}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'out.md'), 'x')
  scratchDirs.push(dir)
  return dir
}

/** 让出若干个事件循环任务，给被测的异步事务面留出真实的推进窗口。 */
async function settle(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setTimeout(resolve, 1))
}

// ---------------------------------------------------------------------------
// T1 / T2 —— services/taskDelete.ts
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 任务删除迁离 dbTxSync', (harness) => {
  test('T1 认领链走完 + 行删除落库 + 父行 branch_started_at 沿父链重算', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const parentId = await seedTask(db, workflowId, {
      startedAt: NOW - 30_000,
      branchStartedAt: NOW - 1_000,
    })
    const childId = await seedTask(db, workflowId, {
      parentTaskId: parentId,
      startedAt: NOW - 1_000,
      branchStartedAt: NOW - 1_000,
    })
    await db.insert(taskFeedback).values({
      id: id('fb'),
      taskId: childId,
      bodyMd: 'feedback that must not outlive its task',
      createdAt: NOW,
    })

    const result = await deleteTask(legacy(db), childId)
    expect(result).toEqual({ taskId: childId, cleanup: 'done' })

    // ① 写真的落库了。
    expect(await taskExists(db, childId)).toBe(false)
    expect(
      await db
        .select({ id: taskFeedback.id })
        .from(taskFeedback)
        .where(eq(taskFeedback.taskId, childId)),
    ).toEqual([])
    // 唯一的子树没了 ⇒ 父行的物化列退回它自己的 started_at（此前会永久停在被删子树的时间戳上）。
    const parent = (
      await db
        .select({ branchStartedAt: tasks.branchStartedAt })
        .from(tasks)
        .where(eq(tasks.id, parentId))
        .limit(1)
    )[0]
    expect(parent?.branchStartedAt).toBe(NOW - 30_000)

    // ② 认领链：claimed(1) → io-complete(2) → db-finalized(3) → completed(4)，成员已释放。
    const claims = await db
      .select({
        state: taskExecutionMaintenanceClaims.state,
        operation: taskExecutionMaintenanceClaims.operation,
        revision: taskExecutionMaintenanceClaims.revision,
      })
      .from(taskExecutionMaintenanceClaims)
    expect(claims).toEqual([{ state: 'completed', operation: 'delete', revision: 4 }])
    const members = await db
      .select({ releasedAt: taskExecutionMaintenanceMembers.releasedAt })
      .from(taskExecutionMaintenanceMembers)
    expect(members).toEqual([{ releasedAt: expect.any(Number) }])
  })

  test('T2 事务内终态复检失败 ⇒ 整笔回滚：行还在、认领停在 io-complete 且 revision 不变', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const taskId = await seedTask(db, workflowId)

    // 卡住每任务写锁：`deleteTask` 会先铸认领 + 推进到 io-complete，然后阻塞在这把锁上。
    const release = await getTaskWriteSem(taskId).acquire()
    const pending = deleteTask(legacy(db), taskId)
    // 认领推进到 io-complete 之后，紧接着就是 acquire()——等到这一步再动任务行。
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await db
        .select({ state: taskExecutionMaintenanceClaims.state })
        .from(taskExecutionMaintenanceClaims)
      if (rows[0]?.state === 'io-complete') break
      await settle(1)
    }
    await settle(2)
    // 并发的续跑把任务翻回非终态：删除事务里的复检必须看到它。
    await db.update(tasks).set({ status: 'running', finishedAt: null }).where(eq(tasks.id, taskId))
    release()

    await expect(pending).rejects.toThrow(/is running; cancel it first/)

    expect(await taskExists(db, taskId)).toBe(true)
    const claims = await db
      .select({
        id: taskExecutionMaintenanceClaims.id,
        state: taskExecutionMaintenanceClaims.state,
        revision: taskExecutionMaintenanceClaims.revision,
      })
      .from(taskExecutionMaintenanceClaims)
    expect(claims).toHaveLength(1)
    expect(claims[0]?.state).toBe('io-complete')
    expect(claims[0]?.revision).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// T3 / T4 —— services/taskArchive.ts
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— 任务归档出库迁离 dbTxSync', (harness) => {
  test('T3 整棵树出库：manifest 落盘、两行都删掉、认领 completed', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const rootId = await seedTask(db, workflowId)
    const childId = await seedTask(db, workflowId, { parentTaskId: rootId })
    const archiveDir = makeScratchDir('archive')

    const archived = await archiveTaskTree(legacy(db), rootId, {
      archiveDir,
      runsDir: join(archiveDir, 'runs'),
      logsDir: join(archiveDir, 'logs'),
      now: NOW,
    })
    expect([...archived.taskIds].sort()).toEqual([childId, rootId].sort())
    expect(existsSync(join(archiveDir, rootId, 'manifest.json'))).toBe(true)

    expect(await taskExists(db, rootId)).toBe(false)
    expect(await taskExists(db, childId)).toBe(false)
    expect(
      await db
        .select({
          state: taskExecutionMaintenanceClaims.state,
          operation: taskExecutionMaintenanceClaims.operation,
        })
        .from(taskExecutionMaintenanceClaims),
    ).toEqual([{ state: 'completed', operation: 'archive' }])
  })

  test('T4 停在 io-complete 的归档认领被启动恢复续做：库里的行才被删掉', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const rootId = await seedTask(db, workflowId)
    const archiveDir = makeScratchDir('archive-resume')
    // 崩在 rename 之后、删库之前：正式目录已在，库里的行还在。
    mkdirSync(join(archiveDir, rootId), { recursive: true })
    writeFileSync(join(archiveDir, rootId, 'manifest.json'), '{}')

    const members = await store(db).snapshotTree(rootId)
    const claim = await store(db).claim({
      rootTaskId: rootId,
      operation: 'archive',
      members,
      cleanupPlanJson: JSON.stringify({
        v: 2,
        rootTaskId: rootId,
        archiveRoot: archiveDir,
        runsRoot: join(archiveDir, 'runs'),
        logsRoot: join(archiveDir, 'logs'),
      }),
      now: NOW,
    })
    const ioComplete = await store(db).transition({ claim, to: 'io-complete', now: NOW + 1 })
    expect(ioComplete.revision).toBe(2)

    const recovered = await recoverInterruptedArchives(legacy(db), { archiveDir, now: NOW + 2 })
    expect(recovered.claimedRoots.has(rootId)).toBe(true)

    expect(await taskExists(db, rootId)).toBe(false)
    expect((await claimRow(db, claim.claimId))?.state).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// T5 / T6 —— platform/persistence/sqlite/systemWorkspaceGc.ts
// ---------------------------------------------------------------------------

describeEachProvider('RFC-359 W7 —— workspace GC 终结事务迁离 dbTxSync', (harness) => {
  test('T5 认领 → 删目录 → 终结：workspace_pruned_at 盖章且认领 completed', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const dir = makeScratchDir('scratch-prune')
    const taskId = await seedTask(db, workflowId, {
      spaceKind: 'scratch',
      worktreePath: dir,
      repoPath: dir,
      workspacePruningAt: NOW,
    })

    expect(await finishClaimedWorkspacePrune(legacy(db), taskId, NOW + 1)).toEqual({
      kind: 'removed',
    })
    expect(existsSync(dir)).toBe(false)
    const row = (
      await db
        .select({ prunedAt: tasks.workspacePrunedAt })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    expect(row?.prunedAt).toBe(NOW + 1)
    expect(
      await db
        .select({
          state: taskExecutionMaintenanceClaims.state,
          operation: taskExecutionMaintenanceClaims.operation,
        })
        .from(taskExecutionMaintenanceClaims),
    ).toEqual([{ state: 'completed', operation: 'workspace-gc' }])
  })

  test('T6 终结事务的原子性：墓碑被抹掉 ⇒ CAS 命中 0 行，pruned_at 仍为空、认领不前进', async () => {
    const db = harness.db
    const workflowId = await seedWorkflow(db)
    const dir = makeScratchDir('scratch-lost-tombstone')
    const taskId = await seedTask(db, workflowId, {
      spaceKind: 'scratch',
      worktreePath: dir,
      repoPath: dir,
      workspacePruningAt: NOW,
    })
    const members = await store(db).snapshotMembers([taskId])
    const claim = await store(db).claim({
      rootTaskId: taskId,
      operation: 'workspace-gc',
      members,
      cleanupPlanJson: JSON.stringify({ v: 1, kind: 'workspace-prune', taskId }),
      now: NOW,
    })
    const ioComplete = await store(db).transition({ claim, to: 'io-complete', now: NOW + 1 })
    expect(ioComplete.revision).toBe(2)
    // 并发的 lifecycle 修复抹掉了墓碑：终结事务的 CAS 必须落空。
    await db.update(tasks).set({ workspacePruningAt: null }).where(eq(tasks.id, taskId))

    expect(await recoverInterruptedWorkspaceGc(legacy(db), NOW + 2)).toEqual({
      completed: [],
      failed: [taskId],
      skipped: 0,
    })

    const row = (
      await db
        .select({ prunedAt: tasks.workspacePrunedAt })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
    )[0]
    expect(row?.prunedAt).toBeNull()
    expect(await claimRow(db, claim.claimId)).toEqual({ state: 'io-complete', revision: 2 })
  })
})
