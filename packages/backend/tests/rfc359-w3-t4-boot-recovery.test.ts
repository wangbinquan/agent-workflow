// RFC-359 W3-T4（P0-3 / P0-4）—— daemon 启动期的任务执行恢复四步，两个引擎各跑一遍。
//
// dual-provider-parity-audit-2026-09-04 P0-3：boot 恢复四步只在 cli/start.ts 的 SQLite 分支里，
// PostgreSQL 分支在 servePostgresqlDaemon 的永不返回 Promise 之后到不了——PG 上重启一次 daemon，
// 上一代在跑的任务 / node_run 永久停在 running，owner 永远 claimed，此后任何启动 / 继续恒 409。
// 四步现在是 composition/bootRecovery.ts 一份序列，两个 daemon 入口都调它；这里用「上一代 daemon
// 认领并跑到一半、进程已死」的真实形状在两个引擎上各验一遍，并锁两个入口的顺序。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionIntents, taskExecutionOwners, tasks, workflows } from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import {
  createDaemonLockProof,
  runTaskExecutionBootRecovery,
} from '@/modules/task-execution/composition/bootRecovery'
import {
  createRuntimeSessionLeaseOperations,
  createTaskExecutionPersistence,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  canonicalJson,
  type CanonicalContinuationRequest,
  type LineageSlot,
} from '@/modules/task-execution/domain/executionIntent'
import { describeEachProvider } from './helpers/eachProvider'

const rootPath = (taskId: string): readonly LineageSlot[] => [
  { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
]

function continuation(taskId: string): CanonicalContinuationRequest {
  return {
    taskId,
    kind: 'launch',
    source: 'rest',
    actorUserId: 'actor-1',
    expectedTaskRevision: 1,
    scope: {
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPath: rootPath(taskId),
      operationGeneration: 0,
    },
    payload: { v: 1 },
  }
}

async function seedRunningTask(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const snapshot = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-w3-t4',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/worktree',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now() - 1_000,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(rootPath(taskId)),
  })
  const runId = ulid()
  // 上一代 daemon 的子进程已随它一起死了：pid 为空 ⇒ 收割器判 no-pid，直接翻 interrupted。
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1_000,
  })
  return runId
}

/** 上一代 daemon（gen-old）认领了任务并挂上 runtime，然后整个进程被 SIGKILL。 */
async function crashPreviousDaemon(db: ProviderNeutralDatabase, taskId: string) {
  const persistence = createTaskExecutionPersistence(db)
  const previous = createProviderTaskExecutionModule({
    daemonGeneration: `gen-old-${ulid()}`,
    persistence,
  })
  const intentId = `intent_${ulid()}`
  await persistence.intents.submit({ request: continuation(taskId), intentId })
  const claimed = await previous.claimPersisted({ intentId })
  previous.claimGate.leave(claimed.permit)
  return { persistence, intentId, previousGeneration: previous.daemonGeneration }
}

const silentLog = { info: () => {}, warn: () => {} }

describeEachProvider('RFC-359 W3-T4 —— boot 恢复四步（P0-3 / P0-4）', (harness) => {
  test('上一代 daemon 崩溃后：owner 撤销并释放、任务 / node_run 翻 interrupted、意图 failed', async () => {
    const db = harness.db
    const taskId = `w3t4_${ulid()}`
    const runId = await seedRunningTask(db, taskId)
    const { persistence, intentId } = await crashPreviousDaemon(db, taskId)
    expect((await persistence.ownership.read(taskId))?.state).toBe('claimed')

    const report = await runTaskExecutionBootRecovery({
      persistence,
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
      lockProof: createDaemonLockProof({
        lockPath: '/tmp/aw.lock',
        lockPid: process.pid,
        daemonGeneration: `gen-new-${ulid()}`,
      }),
      log: silentLog,
    })
    expect(report.revokedTaskIds).toEqual([taskId])
    expect(report.reap).toEqual({ tasks: 1, runs: 1 })
    expect(report.finalization.releasedTaskIds).toEqual([taskId])
    expect(report.finalization.outcomeUnknownTaskIds).toEqual([])

    const owner = await persistence.ownership.read(taskId)
    expect(owner?.state).toBe('released')
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(task.status).toBe('interrupted')
    expect(task.errorSummary).toBe('daemon-restart')
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(run.status).toBe('interrupted')
    const intent = (
      await db.select().from(taskExecutionIntents).where(eq(taskExecutionIntents.id, intentId))
    )[0]!
    expect(intent.state).toBe('failed')
    // 孤儿收割（第二步）先把该任务的活动意图终结成 daemon-restart；finalize 的 releaseRecovered 只标
    // 尚未终结的意图，所以这里两个引擎都是 daemon-restart（rfc328 黄金锁里没有收割步才是 -recovered）。
    expect(intent.failureCode).toBe('daemon-restart')
    // P0-4 的根因随之消失：owner 已 released，此后的启动 / 继续 / 周期修复不再撞 ownerless 围栏。
    const ownerRow = (
      await db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
    )[0]!
    expect(ownerRow.recoveryCode).toBe('daemon-restart-recovered')
  })

  test('本代 daemon 自己的 owner 不被同一世代的恢复撤销（世代围栏在 prepare 一步）', async () => {
    const db = harness.db
    const taskId = `w3t4_${ulid()}`
    await seedRunningTask(db, taskId)
    const { persistence, previousGeneration } = await crashPreviousDaemon(db, taskId)
    // 真实 boot 里不存在「同世代却已 claimed」的 owner（世代按进程铸）；围栏本身只在撤销一步判，
    // 后续三步对同世代 owner 的行为是 P0-4 记录的 ownerless 围栏差异，不在这里断言。
    const preparation = await persistence.recovery.prepare({
      lockProof: createDaemonLockProof({
        lockPath: '/tmp/aw.lock',
        lockPid: process.pid,
        daemonGeneration: previousGeneration,
      }),
    })
    expect(preparation.revokedTaskIds).toEqual([])
    expect((await persistence.ownership.read(taskId))?.state).toBe('claimed')
  })

  test('没有孤儿时四步都是 no-op', async () => {
    const db = harness.db
    const persistence = createTaskExecutionPersistence(db)
    const report = await runTaskExecutionBootRecovery({
      persistence,
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
      lockProof: createDaemonLockProof({
        lockPath: '/tmp/aw.lock',
        lockPid: process.pid,
        daemonGeneration: `gen-new-${ulid()}`,
      }),
      log: silentLog,
    })
    expect(report).toMatchObject({
      revokedTaskIds: [],
      reap: { tasks: 0, runs: 0 },
      repairedRuntimeLeases: 0,
      finalization: { releasedTaskIds: [], outcomeUnknownTaskIds: [] },
    })
  })
})

test('源码锁：两个 daemon 入口都在 HTTP 之前跑同一段 boot 恢复，且在 delete 认领续做之前', () => {
  const cli = resolve(import.meta.dir, '..', 'src', 'cli')
  const start = readFileSync(resolve(cli, 'start.ts'), 'utf8')
  expect(start).toContain('await runTaskExecutionBootRecovery({')
  expect(start).not.toContain('createExclusiveDaemonLockProof(')
  expect(start.indexOf('await runTaskExecutionBootRecovery({')).toBeLessThan(
    start.indexOf('await recoverInterruptedTaskDeletes(db)'),
  )
  const daemon = readFileSync(resolve(cli, 'postgresqlDaemonApplication.ts'), 'utf8')
  const gate = daemon.indexOf('skillCatalogBoot.activateAvailabilityGate()')
  const recovery = daemon.indexOf('await runTaskExecutionBootRecovery({', gate)
  const deleteRecovery = daemon.indexOf('await recoverInterruptedTaskDeletes(input.db)', recovery)
  const httpCreate = daemon.indexOf('const app = createComposedApp', deleteRecovery)
  expect(gate).toBeGreaterThan(-1)
  expect(recovery).toBeGreaterThan(gate)
  expect(deleteRecovery).toBeGreaterThan(recovery)
  expect(httpCreate).toBeGreaterThan(deleteRecovery)
  expect(daemon).not.toContain('createExclusiveDaemonLockProof(')
})
