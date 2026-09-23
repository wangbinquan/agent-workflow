// RFC-368 实现门（2026-09-23，Claude 子代理，只审功能）findings 的回归锁。
//
//   P1-1  启动后第一次派发的一次性收编若瞬时失败，被拒绝的 promise 曾被永久缓存——此后每个
//         cycle 都在派发处抛，连带 inspect 跑不到，所有 round 卡死。
//   P2-1  资源上限 / 空闲收割曾先按「用户取消」取消、事后改写原因；中间几秒数字员工会把超时
//         误判成 stopped、不再重试。改成带真实原因取消，状态与原因同一次写入落下
//         （用户 2026-09-23 裁决：原因一次写对）。
//   P2-2  launch 进行中 / 崩溃重放期间终止案例，agent 曾停不掉。
//   P3-1  已终止的案例再收掉残留 round 时，terminalAt 曾被改写。
//   P3-3  epoch 冲突（claim-stale）曾被当成派发失败、消耗派发预算；design §7 规定跳过本轮。
//   P3-4  AC-3 的数字员工侧：admission 失败时派发行的 epoch 与 round 的执行身份都不推进。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'
import {
  REACTION_CASE,
  REACTION_LEASE_MS,
  REACTION_ROUND,
  reactionRows,
  reactionService,
  scriptedPort,
  seedReaction,
} from './helpers/rfc368ReactionFixture'
import { employeeCases, reactionExecutionAdmissions, tasks, workflows } from '@/db/schema'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import type {
  ReactionOperationRef,
  ReactionRequestHash,
} from '@/modules/digital-employee/composition/required-ports'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecutionCore,
  type DigitalEmployeeExecutionDependencies,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
import { taskStopProjection } from '@/modules/task-execution/domain/sourceTermination'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'

const ROOT = resolve(import.meta.dir, '..', '..', '..')

describe('RFC-368 实现门 findings', () => {
  describeEachProvider('数字员工侧', (harness) => {
    let clock = 10_000
    let minted = 0
    const now = () => clock
    const mint = () => `execution-${++minted}`
    function reset(): void {
      clock = 10_000
      minted = 0
    }

    test('P1-1：收编第一次瞬时失败，下一次派发会重试收编并正常派发', async () => {
      reset()
      await seedReaction(harness.db)
      let adoptCalls = 0
      const port = scriptedPort()
      const service = reactionService(harness.db, {
        port,
        now,
        mint,
        wrapStore: (store) => ({
          ...store,
          async adoptLegacyReactionLaunches(input) {
            adoptCalls += 1
            if (adoptCalls === 1) throw new Error('SQLITE_BUSY: database is locked')
            return await store.adoptLegacyReactionLaunches(input)
          },
        }),
      })
      await expect(service.dispatchOneReaction()).rejects.toThrow('SQLITE_BUSY')
      expect(await service.dispatchOneReaction()).toBe('launched')
      expect(adoptCalls).toBe(2)
      // 成功之后不再重复收编。
      await service.dispatchOneReaction()
      expect(adoptCalls).toBe(2)
    })

    test('P2-2：派发中（planned、已有执行身份）终止案例 ⇒ 取消已预分配的执行', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      port.launchBehavior = () => new Promise<void>(() => {}) // launch 进行中
      const service = reactionService(harness.db, { port, now, mint })
      void service.dispatchOneReaction()
      await Bun.sleep(50)
      expect((await reactionRows(harness.db)).round).toMatchObject({
        state: 'planned',
        executionRef: 'execution-1',
      })
      await service.terminate(REACTION_CASE, 'user-terminated')
      expect(port.canceled).toEqual([`reaction:${REACTION_ROUND}:0|execution-1`])
    })

    test('P2-2：launch 返回时案例已终止 ⇒ 立刻取消刚建出的执行', async () => {
      reset()
      await seedReaction(harness.db)
      const port = scriptedPort()
      port.launchBehavior = async () => {
        // launch 期间用户终止了案例（terminate 那时看到的任务还没建出来，停不掉）。
        await harness.db
          .update(employeeCases)
          .set({ state: 'terminal', terminalKind: 'user-terminated' })
          .where(eq(employeeCases.id, REACTION_CASE))
          .run()
      }
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'launched',
      )
      expect(port.canceled).toEqual([`reaction:${REACTION_ROUND}:0|execution-1`])
    })

    test('P2-2 + P3-1：崩溃重放命中已终止案例 ⇒ 先停掉已建的执行再收掉 round，terminalAt 不改写', async () => {
      reset()
      await seedReaction(harness.db)
      const crashed = scriptedPort()
      crashed.launchBehavior = () => new Promise<void>(() => {})
      void reactionService(harness.db, { port: crashed, now, mint }).dispatchOneReaction()
      await Bun.sleep(50)
      await harness.db
        .update(employeeCases)
        .set({ state: 'terminal', terminalKind: 'user-terminated', terminalAt: 12_345 })
        .where(eq(employeeCases.id, REACTION_CASE))
        .run()
      clock += REACTION_LEASE_MS + 1
      const port = scriptedPort()
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'settled',
      )
      expect(port.launches).toEqual([])
      expect(port.canceled).toEqual([`reaction:${REACTION_ROUND}:0|execution-1`])
      const rows = await reactionRows(harness.db)
      expect(rows.round.state).toBe('obsolete')
      expect(rows.employeeCase).toMatchObject({
        state: 'terminal',
        terminalKind: 'user-terminated',
        terminalAt: 12_345,
      })
    })

    test('P3-3：epoch 冲突 ⇒ 跳过本轮，不当成派发失败', async () => {
      reset()
      await seedReaction(harness.db)
      // TE 日志上这一轮的 epoch 已被推进到 5（数字员工侧仍以为是 0）。
      await harness.db
        .insert(reactionExecutionAdmissions)
        .values({
          operationRef: `reaction:${REACTION_ROUND}:9`,
          caseId: REACTION_CASE,
          roundRef: REACTION_ROUND,
          claimEpoch: 5,
          fenceRevision: 5,
          requestHash: 'f'.repeat(64),
          authoritySubject: 'system',
          authorityRevision: 1,
          executionRef: 'execution-elsewhere',
          state: 'admitted',
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
      const port = scriptedPort()
      expect(await reactionService(harness.db, { port, now, mint }).dispatchOneReaction()).toBe(
        'idle',
      )
      expect(port.launches).toEqual([])
      const rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'planned', executionRef: null })
      expect(rows.dispatch.lastDispatchError).toBeNull()
      expect(rows.employeeCase.state).toBe('active')
    })

    test('P3-4（AC-3 数字员工侧）：admission 失败 ⇒ 派发 epoch 与 round 的执行身份都不推进', async () => {
      reset()
      await seedReaction(harness.db)
      const store = createRuntimePersistence(harness.db, {
        reactionAdmission: (tx) => {
          const real = composeReactionExecutionAdmissionParticipantInTx(
            createReactionAdmissionStore(tx),
            { now, mintExecutionRef: mint },
          )
          return {
            ...real,
            async admitLaunch() {
              throw new Error('admission-probe')
            },
          }
        },
      })
      const claimed = await store.claimReactionDispatch({
        workerId: 'worker-a',
        now: clock,
        leaseMs: REACTION_LEASE_MS,
      })
      expect(claimed).not.toBeNull()
      await expect(
        store.admitReactionDispatch({
          roundId: REACTION_ROUND,
          workerId: 'worker-a',
          operation: `reaction:${REACTION_ROUND}:0` as ReactionOperationRef,
          requestHash: 'a'.repeat(64) as ReactionRequestHash,
          authority: { subject: 'system', revision: 1 },
          now: clock,
        }),
      ).rejects.toThrow('admission-probe')
      const rows = await reactionRows(harness.db)
      expect(rows.dispatch.claimEpoch).toBe(0)
      expect(rows.dispatch.operationRef).toBeNull()
      expect(rows.round.executionRef).toBeNull()
      expect(rows.admissions).toEqual([])
    })
  })

  describeEachProvider('P2-1：收割带真实原因取消', (harness) => {
    async function seedRunningTask(id: string): Promise<void> {
      await harness.db
        .insert(workflows)
        .values({
          id: `wf-${id}`,
          name: `wf-${id}`,
          definition: '{}',
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        })
        .onConflictDoNothing()
        .run()
      await harness.db
        .insert(tasks)
        .values({
          id,
          name: id,
          workflowId: `wf-${id}`,
          workflowSnapshot: '{}',
          repoPath: '/tmp/rfc368-reap',
          worktreePath: '/tmp/rfc368-reap',
          baseBranch: 'main',
          branch: `agent-workflow/${id}`,
          baseCommit: null,
          status: 'running',
          inputs: '{}',
          startedAt: 1,
          executionLineageId: id,
          lineageSlotPathJson: JSON.stringify([
            { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
          ]),
        })
        .run()
    }

    test('状态与原因同一次写入落下；数字员工据此判 failed（按失败重试），不是 stopped', async () => {
      await seedRunningTask('task-reaped')
      await composeTaskCancellation(harness.db).cancel('task-reaped', {
        kind: 'resource-reaped',
        summary: 'task-time-limit-exceeded',
        message: 'task ran 61000ms, exceeding configured limit 60000ms',
      })
      const [row] = await harness.db
        .select({
          status: tasks.status,
          errorSummary: tasks.errorSummary,
          errorMessage: tasks.errorMessage,
        })
        .from(tasks)
        .where(eq(tasks.id, 'task-reaped'))
        .all()
      expect(row).toEqual({
        status: 'canceled',
        errorSummary: 'task-time-limit-exceeded',
        errorMessage: 'task ran 61000ms, exceeding configured limit 60000ms',
      })
      const core = composeDigitalEmployeeExecutionCore({
        ...composeDatabaseDigitalEmployeeExecutionPorts(harness.db),
      } as unknown as DigitalEmployeeExecutionDependencies)
      expect((await core.inspect('task-reaped')).kind).toBe('failed')
    })
  })

  test('P2-1：原因投影；两个收割方都带原因取消，三个根都以 resource-reaped 接线', () => {
    expect(
      taskStopProjection({ kind: 'resource-reaped', summary: 'task-idle-timeout', message: 'm' }),
    ).toEqual({ code: 'resource-reaped', summary: 'task-idle-timeout' })
    const read = (path: string) => readFileSync(resolve(ROOT, 'packages/backend', path), 'utf8')
    expect(read('src/services/limits.ts')).toContain('await operations.cancelTask(t.id, reason)')
    expect(read('src/modules/task-execution/application/taskIdleTimeoutReaper.ts')).toContain(
      'await operations.cancelTask(taskId, reason)',
    )
    expect(read('src/modules/system-operations/composition/resourceLimits.ts')).toContain(
      "kind: 'resource-reaped'",
    )
    expect(read('src/cli/start.ts')).toContain("kind: 'resource-reaped'")
    expect(
      read('src/cli/postgresqlDaemonApplication.ts').match(/kind: 'resource-reaped'/g),
    ).toHaveLength(2)
  })
})
