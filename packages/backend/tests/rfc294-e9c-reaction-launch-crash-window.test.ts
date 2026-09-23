// RFC-294 W4-E9 / E9-C 的回归锁 —— **一次 Reaction 不得启动出两个任务**。
//
// 缺陷（2026-09-22 复现）：旧合同下数字员工的调用序列是「`launch()` 建任务 →
// `markRoundRunning()` 记下 executionRef」，两步之间没有事务，「这一轮归谁做」只靠 outbox 行
// 60s 的租约兜着。daemon 在这中间重启，租约过期后那行被重新领走，同一个 round 起出第二个任务：
// 第一个从此无人 inspect / cancel，却继续吃 Case 的时长与 token 预算，并和新任务写同一个
// worktree。当时的前置小修（`56bb82b50`）在 TaskExecution 侧按 round 反查活着的任务去重。
//
// RFC-368 T19 按新合同重建这条锁，**判据不放宽**：崩溃重放之后，同一个 round 在任务表里
// 仍然**恰好一行**。新合同的结构性解法：
//   · 执行身份在数字员工 claim 事务里经 TaskExecution 的 admission 日志**预分配**；
//   · 重放时同一个 ordinal 算出同一个 operation，admission 幂等返回同一个执行身份；
//   · TaskExecution 适配器按这个 id 发现任务已存在就直接返回，不建第二个。
// 所以不再需要按 round 推断活性（那套兜底随旧合同删除）。
//
// 这里是**端到端**的：真的数字员工派发臂 + 真 store + 真 TE admission 日志 + 真的 TE 适配器，
// `executionExists` 查真库；只有「建任务」这一步换成向 `tasks` 插一行的内核替身，
// 以便把崩溃点精确卡在两个窗口上。
//
// 另保留 `digitalEmployeeExecutionIsLive` 的四条纯判据：它仍是 inspect 报 `pending` 的唯一
// 依据，`interrupted` 是终态但「daemon 重启打断、自动恢复未停用」那一种必须算活着。

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'
import {
  REACTION_LEASE_MS,
  REACTION_ROUND,
  reactionRows,
  reactionService,
  seedReaction,
} from './helpers/rfc368ReactionFixture'
import type { ProviderNeutralDatabase } from '@/db/query'
import { tasks, workflows } from '@/db/schema'
import type { DigitalEmployeeExecutionCore } from '@/modules/task-execution/application/ports/digitalEmployeeExecutionCore'
import { composeReactionExecutionPortV1 } from '@/modules/task-execution/application/adapters/reaction-execution-adapter'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  digitalEmployeeExecutionIsLive,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'
import { DAEMON_RESTART_ERROR_SUMMARY } from '@agent-workflow/shared'

async function insertTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  await db
    .insert(workflows)
    .values({
      id: `wf-${taskId}`,
      name: `wf-${taskId}`,
      definition: '{}',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .onConflictDoNothing()
    .run()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: taskId,
      workflowId: `wf-${taskId}`,
      workflowSnapshot: '{}',
      repoPath: '/tmp/e9c',
      worktreePath: '/tmp/e9c',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      baseCommit: null,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      digitalEmployeeRoundId: REACTION_ROUND,
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
    })
    .run()
}

describe('RFC-294 E9-C —— 一次 Reaction 只起一个任务', () => {
  describe('digitalEmployeeExecutionIsLive —— inspect 报 pending 的唯一判据', () => {
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

  describeEachProvider('daemon 在派发中途崩溃，重启后重放', (harness) => {
    let clock = 10_000
    let minted = 0
    const now = () => clock
    const mint = () => `execution-${++minted}`

    /**
     * 真的 TE 适配器 + 真库的 `executionExists`；只有建任务这一步是替身。
     * `crash` 决定这一次 launch 卡在哪：`before-task` 在建任务前永不返回，
     * `after-task` 建完任务行后永不返回（回执没送到数字员工）。
     */
    function tePort(crash: 'none' | 'before-task' | 'after-task') {
      const db = harness.db
      const tasksPort = composeDatabaseDigitalEmployeeExecutionPorts(db).tasks
      const kernelLaunches: string[] = []
      const core: DigitalEmployeeExecutionCore = {
        async launch(input) {
          kernelLaunches.push(input.taskId)
          if (crash === 'before-task') await new Promise<never>(() => {})
          await insertTask(db, input.taskId)
          if (crash === 'after-task') await new Promise<never>(() => {})
          return { executionRef: input.taskId }
        },
        executionExists: async (executionRef) => (await tasksPort.get(executionRef)) !== null,
        inspect: async () => ({ kind: 'pending' }),
        inspectHumanReview: async () => 'not-applicable',
        cancel: async () => {},
      }
      const port = composeReactionExecutionPortV1({
        core,
        admissions: createReactionAdmissionStore(db),
        retryFeedback: { read: async () => null },
        diagnostics: {
          put: async () => {
            throw new Error('not used')
          },
        },
        now,
      })
      return { port, kernelLaunches }
    }

    async function taskRowsForRound(): Promise<string[]> {
      return (
        await harness.db
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.digitalEmployeeRoundId, REACTION_ROUND))
          .all()
      ).map((row) => row.id)
    }

    async function crashThenReplay(crash: 'before-task' | 'after-task') {
      clock = 10_000
      minted = 0
      await seedReaction(harness.db)
      const crashed = tePort(crash)
      void reactionService(harness.db, {
        port: crashed.port,
        now,
        mint,
        workerId: 'daemon-before-restart',
      }).dispatchOneReaction()
      await Bun.sleep(50)
      expect(crashed.kernelLaunches).toEqual(['execution-1'])

      // 重启后：派发租约过期，同一个 round 被重新选中。
      clock += REACTION_LEASE_MS + 1
      const restarted = tePort('none')
      expect(
        await reactionService(harness.db, {
          port: restarted.port,
          now,
          mint,
          workerId: 'daemon-after-restart',
        }).dispatchOneReaction(),
      ).toBe('launched')
      return restarted
    }

    test('崩在「admission 已提交、任务还没建」：重放建出的是同一个执行身份，只有一行', async () => {
      const restarted = await crashThenReplay('before-task')
      expect(restarted.kernelLaunches).toEqual(['execution-1'])
      expect(await taskRowsForRound()).toEqual(['execution-1'])
      expect((await reactionRows(harness.db)).round).toMatchObject({
        state: 'running',
        executionRef: 'execution-1',
      })
    })

    test('崩在「任务已建、回执没送到」：重放发现任务已存在，不建第二个', async () => {
      const restarted = await crashThenReplay('after-task')
      // 关键判据：内核一次都没被再调——不是「调了但去重了」，是结构上不会再建。
      expect(restarted.kernelLaunches).toEqual([])
      expect(await taskRowsForRound()).toEqual(['execution-1'])
      const rows = await reactionRows(harness.db)
      expect(rows.round).toMatchObject({ state: 'running', executionRef: 'execution-1' })
      expect(rows.admissions.map((row) => row.state)).toEqual(['launched'])
    })
  })
})
