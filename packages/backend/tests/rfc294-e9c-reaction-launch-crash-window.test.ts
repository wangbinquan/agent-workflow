// RFC-294 W4-E9 / E9-C 前置小修的回归锁 —— **一次 Reaction 不得启动出两个任务**。
//
// 这条锁记的是 2026-09-22 复现出来的缺陷（先红后绿，红版见本次提交的父提交行为）：
//
//   `digital-employee/application/runtimeService.ts:2587-2588`
//       const receipt = await this.#execution.launch(payload.plan, payload.attempt)
//       await this.#store.markRoundRunning(payload.roundId, receipt.executionRef, now)
//
// `launch()` 的副作用（建 task 行、准备 worktree、起 agent）在**任何事务之外**，而「这一轮
// 归谁做」只靠 outbox 行 60s 的租约兜着（同文件 `:538`）；`claimOutbox` 的重领条件是
// 「`state='claimed'` 且 `claim_expires_at <= now`」（`infrastructure/runtimeStore.ts:1113-1121`）。
// daemon 只要在这两行之间死掉，重启后那行租约已过期会被重新领走，于是同一个 round 起出第二个
// 任务：第一个从此无人 inspect / cancel（round 只记得住第二个），却继续吃 Case 的时长与 token
// 预算，并且和新任务**写同一个 worktree**（同一个 round 解析出同一个 scene）。
//
// 修法落在 TaskExecution 侧，因为知识在那边：每次启动都会把 round 写进任务行
// （`services/task.ts:2441` 的 `digitalEmployeeRoundId`，索引 `idx_tasks_digital_employee_round`），
// 而数字员工那边在 `markRoundRunning` 之前手上什么都没有。
//
// **最容易写错的一点**：`interrupted` 是终态（`shared/lifecycle.ts` 的
// `TERMINAL_TASK_STATUSES` 含它），而重启后那个孤儿恰恰就是 `interrupted`——只看
// `isTerminalTaskStatus` 的去重会漏掉它、照样起第二个。所以判据必须和 `inspect` 共用同一个
// `digitalEmployeeExecutionIsLive`：两个调用点一旦漂开，这个缺陷会原样回来。

import { describe, expect, test } from 'bun:test'

import { describeEachProvider } from './helpers/eachProvider'
import { tasks, workflows } from '@/db/schema'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecution,
  digitalEmployeeExecutionIsLive,
  type DigitalEmployeeExecutionDependencies,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'

const ROUND_ID = 'round-e9c-crash'
const ORPHANED_TASK = 'task-launched-before-the-crash'

function reactionPlanJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    caseRef: { id: 'case-e9c-crash', revision: 1 },
    roundRef: ROUND_ID,
    executionNonce: 'a'.repeat(64),
    toolSlotRef: 'fixture-slot',
    connectionRef: null,
    implementationRef: null,
    implementationKind: 'agent',
    implementationJson: '{}',
    inputEnvelopeJson: '{}',
    inputSchemaId: 'fixture.input',
    outputSchemaId: 'fixture.output',
    workContractRef: { contractId: 'fixture.contract', version: 1 },
    semanticValidatorId: 'fixture.validator',
    allowedEffectKinds: [],
    roundBudgetMs: 60_000,
    maxTotalTokens: null,
  })
}

const ATTEMPT_JSON = JSON.stringify({ ordinal: 0, mode: 'initial', previousError: null })

async function seedTask(
  db: Parameters<typeof composeDatabaseDigitalEmployeeExecutionPorts>[0],
  input: {
    readonly id: string
    readonly roundRef: string | null
    readonly status: 'running' | 'interrupted' | 'done'
    readonly errorSummary: string | null
    readonly autoRecoverySuspended?: boolean
    readonly startedAt: number
  },
): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: `wf-${input.id}`,
      name: `wf-${input.id}`,
      definition: '{}',
      version: 1,
      createdAt: input.startedAt,
      updatedAt: input.startedAt,
    })
    .onConflictDoNothing()
    .run()
  await db
    .insert(tasks)
    .values({
      id: input.id,
      name: input.id,
      workflowId: `wf-${input.id}`,
      workflowSnapshot: '{}',
      repoPath: '/tmp/e9c',
      worktreePath: '/tmp/e9c',
      baseBranch: 'main',
      branch: `agent-workflow/${input.id}`,
      baseCommit: null,
      status: input.status,
      inputs: '{}',
      startedAt: input.startedAt,
      errorSummary: input.errorSummary,
      autoRecoverySuspended: input.autoRecoverySuspended ?? false,
      digitalEmployeeRoundId: input.roundRef,
      executionLineageId: input.id,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: input.id, workflowRevision: null },
      ]),
    })
    .run()
}

describe('RFC-294 E9-C 前置小修 —— Reaction launch 对同一个 round 幂等', () => {
  describe('digitalEmployeeExecutionIsLive —— inspect 与 launch 共用的活性判据', () => {
    test('被 daemon 重启打断、自动恢复未停用的任务算「还活着」', () => {
      expect(
        digitalEmployeeExecutionIsLive({
          status: 'interrupted',
          errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
          autoRecoverySuspended: false,
        }),
      ).toBe(true)
    })

    test('同样是 interrupted，自动恢复已停用就不算活着——没人会把它带回来', () => {
      expect(
        digitalEmployeeExecutionIsLive({
          status: 'interrupted',
          errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
          autoRecoverySuspended: true,
        }),
      ).toBe(false)
    })

    test('因别的原因 interrupted 的任务不算活着', () => {
      expect(
        digitalEmployeeExecutionIsLive({
          status: 'interrupted',
          errorSummary: 'something else entirely',
          autoRecoverySuspended: false,
        }),
      ).toBe(false)
    })

    test('running 活着；done 不活', () => {
      expect(
        digitalEmployeeExecutionIsLive({
          status: 'running',
          errorSummary: null,
          autoRecoverySuspended: false,
        }),
      ).toBe(true)
      expect(
        digitalEmployeeExecutionIsLive({
          status: 'done',
          errorSummary: null,
          autoRecoverySuspended: false,
        }),
      ).toBe(false)
    })
  })

  describeEachProvider('daemon 在 launch 与 markRoundRunning 之间重启', (harness) => {
    function participantFor(
      db: typeof harness.db,
      onKernelLaunch: () => never,
    ): ReturnType<typeof composeDigitalEmployeeExecution> {
      return composeDigitalEmployeeExecution({
        executionMetadata: composeDatabaseDigitalEmployeeExecutionPorts(db).executionMetadata,
        launch: { launch: onKernelLaunch },
      } as unknown as DigitalEmployeeExecutionDependencies)
    }

    test('这个 round 已经有一个活着的任务时，复用它，不建第二个', async () => {
      const db = harness.db
      // 崩溃前那次 launch 建出来的任务：daemon 重启把它打成 interrupted，
      // 自动恢复还会把它带回来，所以它仍在跑这一轮的活。
      await seedTask(db, {
        id: ORPHANED_TASK,
        roundRef: ROUND_ID,
        status: 'interrupted',
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        startedAt: 1_000,
      })

      const participant = participantFor(db, () => {
        throw new Error('launch kernel must not be reached')
      })
      const receipt = await participant.launch(reactionPlanJson(), ATTEMPT_JSON)

      expect(receipt.executionRef).toBe(ORPHANED_TASK)
    })

    test('同一个 round 有多个活着的任务时，取最早那个——不因排序抖动换人', async () => {
      const db = harness.db
      await seedTask(db, {
        id: ORPHANED_TASK,
        roundRef: ROUND_ID,
        status: 'interrupted',
        errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
        startedAt: 1_000,
      })
      await seedTask(db, {
        id: 'task-launched-later',
        roundRef: ROUND_ID,
        status: 'running',
        errorSummary: null,
        startedAt: 2_000,
      })

      const participant = participantFor(db, () => {
        throw new Error('launch kernel must not be reached')
      })
      expect((await participant.launch(reactionPlanJson(), ATTEMPT_JSON)).executionRef).toBe(
        ORPHANED_TASK,
      )
    })

    test('只有终结过的任务时不复用——重试必须真的再起一轮', async () => {
      const db = harness.db
      // 重试路径的形态：旧任务已经终结（`inspect` 判出失败之后才会重试）。
      await seedTask(db, {
        id: 'task-that-already-finished',
        roundRef: ROUND_ID,
        status: 'done',
        errorSummary: null,
        startedAt: 1_000,
      })

      const participant = participantFor(db, () => {
        throw new Error('launch-kernel-reached')
      })
      // 判据是「**没有返回**那个已终结的 executionRef」：短路发生时这里会拿到
      // `task-that-already-finished`；没短路就继续走真正的启动路径，而本用例的 deps 是
      // 刻意最小化的，那条路上必然抛错。所以 rejects 本身就是「没短路」的决定性证据。
      await expect(participant.launch(reactionPlanJson(), ATTEMPT_JSON)).rejects.toThrow()
      expect(
        (
          await composeDatabaseDigitalEmployeeExecutionPorts(db).executionMetadata.findByRound(
            ROUND_ID,
          )
        ).map((row) => row.taskId),
      ).toEqual(['task-that-already-finished'])
    })

    test('别的 round 的活任务不算数——反查按 round 闭合', async () => {
      const db = harness.db
      await seedTask(db, {
        id: 'task-of-another-round',
        roundRef: 'some-other-round',
        status: 'running',
        errorSummary: null,
        startedAt: 1_000,
      })

      expect(
        await composeDatabaseDigitalEmployeeExecutionPorts(db).executionMetadata.findByRound(
          ROUND_ID,
        ),
      ).toEqual([])
    })
  })
})
