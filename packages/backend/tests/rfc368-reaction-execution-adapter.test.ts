// RFC-368 T7 —— `ReactionExecutionPortV1` 的 TaskExecution 适配器与它背后的 typed 核心。
//
// 三组锁：
//   ① 适配器：执行身份取自 admission 预分配的 id；已存在即重放、不建第二个任务；access 必须与
//      admission 日志对得上；失败详情只回 diagnostics ref；取消单列成 stopped。
//   ② 核心的 stopped 判据：**只有「用户取消」**才算。资源上限超时与空闲收割也把任务置成
//      canceled（只改写 errorSummary），它们必须仍按 failed 走重试——否则超时就不再重试，
//      那是 AC-12 禁止放宽的重试预算。
//   ③ 人审六态：`unknown`（执行行不在 / 输入不可解析）与 `not-applicable`（没配闸门）分开
//      （设计门 P2-2）；旧的 null 接口折叠行为逐字不变。

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describeEachProvider } from './helpers/eachProvider'
import { tasks, workflows } from '@/db/schema'
import { DomainError } from '@/util/errors'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import { composeReactionExecutionPortV1 } from '@/modules/task-execution/application/adapters/reaction-execution-adapter'
import type {
  DigitalEmployeeExecutionCore,
  DigitalEmployeeExecutionCoreSnapshot,
  DigitalEmployeeHumanReviewCoreSnapshot,
} from '@/modules/task-execution/application/ports/digitalEmployeeExecutionCore'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'
import {
  composeDatabaseDigitalEmployeeExecutionPorts,
  composeDigitalEmployeeExecutionCore,
  inspectDigitalEmployeeHumanReviewSnapshot,
  type DigitalEmployeeExecutionDependencies,
} from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { prepareReactionExecution } from '@/modules/digital-employee/domain/reactionExecutionRequest'
import type {
  ReactionClaimEpoch,
  ReactionDiagnosticsRef,
  ReactionExecutionAdmissionReceiptV1,
  ReactionRetryFeedbackRef,
} from '@/modules/digital-employee/composition/required-ports'

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const ROUND = 'round-adapter'

async function expectDomainCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  await promise.catch((error: unknown) => {
    caught = error
  })
  expect(caught).toBeInstanceOf(DomainError)
  expect((caught as DomainError).code).toBe(code)
}

function prepared(ordinal = 0, feedbackRef: string | null = null) {
  return prepareReactionExecution({
    employeeCase: { id: 'case-adapter', revision: 1 },
    roundRef: ROUND,
    authority: { subject: 'user-1', revision: 1 },
    attempt:
      ordinal === 0
        ? { ordinal: 0, mode: 'initial', retryFeedback: { kind: 'none' } }
        : {
            ordinal,
            mode: 'same-scene',
            retryFeedback:
              feedbackRef === null
                ? { kind: 'none' }
                : { kind: 'artifact', ref: feedbackRef as ReactionRetryFeedbackRef },
          },
    plan: { schemaVersion: 1, roundRef: ROUND },
  })
}

interface FakeCore extends DigitalEmployeeExecutionCore {
  readonly launches: Array<{ taskId: string; previousError: string | null }>
  readonly existing: Set<string>
  snapshot: DigitalEmployeeExecutionCoreSnapshot
  review: DigitalEmployeeHumanReviewCoreSnapshot
  readonly canceled: string[]
}

function fakeCore(): FakeCore {
  const core: FakeCore = {
    launches: [],
    existing: new Set(),
    snapshot: { kind: 'pending' },
    review: 'not-applicable',
    canceled: [],
    async launch(input) {
      core.launches.push({ taskId: input.taskId, previousError: input.attempt.previousError })
      core.existing.add(input.taskId)
      return { executionRef: input.taskId }
    },
    async executionExists(ref) {
      return core.existing.has(ref)
    },
    async inspect() {
      return core.snapshot
    },
    async inspectHumanReview() {
      return core.review
    },
    async cancel(ref) {
      core.canceled.push(ref)
    },
  }
  return core
}

describe('RFC-368 T7 —— ReactionExecutionPortV1 适配器', () => {
  describeEachProvider('执行身份来自 admission；重放不建第二个任务', (harness) => {
    async function admit(
      request: ReturnType<typeof prepared>,
      mint: string,
      expectedPreviousEpoch: number | null = null,
    ): Promise<ReactionExecutionAdmissionReceiptV1> {
      let receipt: ReactionExecutionAdmissionReceiptV1 | undefined
      await databaseSessionFor(harness.db).transaction(async (tx) => {
        const participant = composeReactionExecutionAdmissionParticipantInTx(
          createReactionAdmissionStore(tx),
          { now: () => 1_000, mintExecutionRef: () => mint },
        )
        const fence = await participant.activateClaim({
          employeeCase: { id: 'case-adapter' },
          reaction: { roundRef: ROUND },
          expectedPreviousEpoch: expectedPreviousEpoch as ReactionClaimEpoch | null,
          nextEpoch: ((expectedPreviousEpoch ?? 0) + 1) as ReactionClaimEpoch,
          authority: { subject: 'user-1', revision: 1 },
        })
        receipt = await participant.admitLaunch({
          fence,
          operation: request.request.operation,
          requestHash: request.requestHash,
        })
      })
      return receipt!
    }

    function port(core: FakeCore, feedback: Record<string, string> = {}) {
      const diagnostics: string[] = []
      return {
        diagnostics,
        port: composeReactionExecutionPortV1({
          core,
          admissions: createReactionAdmissionStore(harness.db),
          retryFeedback: { read: async (ref) => feedback[ref] ?? null },
          diagnostics: {
            async put(input) {
              diagnostics.push(
                `${input.errorCode}|${input.errorDetail}|${String(input.workspaceRoot)}`,
              )
              return `diagnostics:${'d'.repeat(64)}` as ReactionDiagnosticsRef
            },
          },
          now: () => 2_000,
        }),
      }
    }

    test('launch 用 admission 预分配的 id 当 taskId', async () => {
      const request = prepared()
      const admission = await admit(request, 'exec-preallocated')
      const core = fakeCore()
      const { port: p } = port(core)
      expect(await p.launch(request, admission)).toEqual({ executionRef: 'exec-preallocated' })
      expect(core.launches).toEqual([{ taskId: 'exec-preallocated', previousError: null }])
      expect(
        (await createReactionAdmissionStore(harness.db).find(request.request.operation))?.state,
      ).toBe('launched')
    })

    test('重放：该 id 的任务已存在 ⇒ 直接返回，不建第二个（AC-4 / AC-5）', async () => {
      const request = prepared()
      const admission = await admit(request, 'exec-replayed')
      const core = fakeCore()
      core.existing.add('exec-replayed') // 上一次 launch 已建出任务，返回前崩了
      const { port: p } = port(core)
      expect(await p.launch(request, admission)).toEqual({ executionRef: 'exec-replayed' })
      expect(core.launches).toEqual([])
    })

    test('admission 与请求不配对 ⇒ 拒绝', async () => {
      const admission = await admit(prepared(), 'exec-x')
      const { port: p } = port(fakeCore())
      await expectDomainCode(
        p.launch(prepared(1), admission),
        'employee-reaction-admission-mismatch',
      )
    })

    test('重试反馈经 reader 解引用后作为 previousError 交给核心', async () => {
      const ref = `retry-feedback:${'f'.repeat(64)}`
      const request = prepared(1, ref)
      const admission = await admit(request, 'exec-retry')
      const core = fakeCore()
      const { port: p } = port(core, { [ref]: 'e: previous failure' })
      await p.launch(request, admission)
      expect(core.launches).toEqual([
        { taskId: 'exec-retry', previousError: 'e: previous failure' },
      ])
    })

    test('access 与 admission 日志对不上 ⇒ 拒绝', async () => {
      const request = prepared()
      await admit(request, 'exec-real')
      const { port: p } = port(fakeCore())
      await expectDomainCode(
        p.inspect({ operation: request.request.operation, executionRef: 'exec-forged' }),
        'employee-reaction-access-mismatch',
      )
    })

    // RFC-368 刀 3（用户 2026-09-23 裁决）：切换前由旧路径启动、仍在跑的 round 从没 admission
    // 过——日志里查不到这一行时按 executionRef 直接放行，让它们照常结算。
    test('日志里没有这个 operation（切换前已在跑）⇒ 按 executionRef 直接查', async () => {
      const request = prepared()
      const core = fakeCore()
      core.snapshot = { kind: 'pending' }
      const { port: p } = port(core)
      expect(
        await p.inspect({ operation: request.request.operation, executionRef: 'exec-legacy' }),
      ).toEqual({ kind: 'pending' })
      expect(core.canceled).toEqual([])
    })

    test('failed 只回 diagnostics ref，正文交给 sink', async () => {
      const request = prepared()
      await admit(request, 'exec-failed')
      const core = fakeCore()
      const metering = { sourceRef: 'task:exec-failed', durationMs: 5, totalTokens: 7 }
      core.snapshot = {
        kind: 'failed',
        errorClass: 'semantic',
        errorCode: 'execution-output-missing',
        errorDetail: 'no result port',
        workspaceRoot: '/wt/task',
        metering,
      }
      const { port: p, diagnostics } = port(core)
      const snapshot = await p.inspect({
        operation: request.request.operation,
        executionRef: 'exec-failed',
      })
      expect(snapshot as unknown).toEqual({
        kind: 'failed',
        errorClass: 'semantic',
        errorCode: 'execution-output-missing',
        diagnostics: `diagnostics:${'d'.repeat(64)}`,
        metering,
      })
      expect(diagnostics).toEqual(['execution-output-missing|no result port|/wt/task'])
    })

    test('stopped 单列并带回执；cancel 返回同一回执', async () => {
      const request = prepared()
      await admit(request, 'exec-stopped')
      const core = fakeCore()
      const metering = { sourceRef: 'task:exec-stopped', durationMs: 1, totalTokens: 0 }
      core.snapshot = { kind: 'stopped', metering }
      const { port: p } = port(core)
      const access = { operation: request.request.operation, executionRef: 'exec-stopped' }
      expect((await p.inspect(access)) as unknown).toEqual({
        kind: 'stopped',
        receipt: 'stopped:exec-stopped',
        metering,
      })
      expect((await p.cancel(access)) as string).toBe('stopped:exec-stopped')
      expect(core.canceled).toEqual(['exec-stopped'])
    })

    test('人审六态原样透出（含 not-applicable 与 unknown）', async () => {
      const request = prepared()
      await admit(request, 'exec-review')
      const core = fakeCore()
      const { port: p } = port(core)
      const access = { operation: request.request.operation, executionRef: 'exec-review' }
      for (const state of [
        'not-applicable',
        'unknown',
        'planning',
        'waiting',
        'approved',
        'failed',
      ] as const) {
        core.review = state
        expect(await p.inspectHumanReview(access)).toEqual({ kind: state })
      }
    })
  })
})

describe('RFC-368 T7 —— 核心的 stopped 判据与人审六态（真库）', () => {
  describeEachProvider('只有「用户取消」才是 stopped', (harness) => {
    async function seed(input: {
      readonly id: string
      readonly status: 'canceled' | 'running'
      readonly errorSummary: string | null
      readonly inputs?: string
    }): Promise<void> {
      await harness.db
        .insert(workflows)
        .values({
          id: `wf-${input.id}`,
          name: `wf-${input.id}`,
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
          id: input.id,
          name: input.id,
          workflowId: `wf-${input.id}`,
          workflowSnapshot: '{}',
          repoPath: '/tmp/rfc368',
          worktreePath: '/tmp/rfc368',
          baseBranch: 'main',
          branch: `agent-workflow/${input.id}`,
          baseCommit: null,
          status: input.status,
          inputs: input.inputs ?? '{}',
          startedAt: 1,
          finishedAt: input.status === 'canceled' ? 2 : null,
          errorSummary: input.errorSummary,
          executionLineageId: input.id,
          lineageSlotPathJson: JSON.stringify([
            { stableNodeKey: 'task-root', frozenOccurrenceKey: input.id, workflowRevision: null },
          ]),
        })
        .run()
    }

    function core() {
      return composeDigitalEmployeeExecutionCore({
        ...composeDatabaseDigitalEmployeeExecutionPorts(harness.db),
      } as unknown as DigitalEmployeeExecutionDependencies)
    }

    test('用户取消 ⇒ stopped（不再被当成失败白烧一次重试预算）', async () => {
      await seed({ id: 'task-user-cancel', status: 'canceled', errorSummary: 'canceled by user' })
      expect((await core().inspect('task-user-cancel')).kind).toBe('stopped')
    })

    test('资源上限取消 ⇒ 仍是 failed（超时必须继续按失败重试）', async () => {
      await seed({
        id: 'task-limit-cancel',
        status: 'canceled',
        errorSummary: 'task-time-limit-exceeded',
      })
      expect((await core().inspect('task-limit-cancel')).kind).toBe('failed')
    })

    test('executionExists 按 id 判断', async () => {
      await seed({ id: 'task-exists', status: 'running', errorSummary: null })
      expect(await core().executionExists('task-exists')).toBe(true)
      expect(await core().executionExists('task-absent')).toBe(false)
    })

    test('人审：执行行不在 ⇒ unknown；没有闸门键 ⇒ not-applicable', async () => {
      await seed({ id: 'task-no-gate', status: 'running', errorSummary: null, inputs: '{}' })
      expect(await inspectDigitalEmployeeHumanReviewSnapshot(harness.db, 'task-missing')).toBe(
        'unknown',
      )
      expect(await inspectDigitalEmployeeHumanReviewSnapshot(harness.db, 'task-no-gate')).toBe(
        'not-applicable',
      )
    })
  })
})

describe('RFC-368 T7 —— 预分配 taskId 的接线（源码层兜底，端到端在 T19 的崩溃窗口用例里）', () => {
  test('启动内核取 `internal.preallocatedTaskId`，缺席时才现铸', () => {
    const kernel = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/infrastructure/taskRouteLaunchOperations.ts',
      ),
      'utf8',
    )
    expect(kernel).toContain('const taskId = input.internal?.preallocatedTaskId ?? nextId()')
  })

  test('typed 核心把预分配 id 交给内核；不再按 round 反查去重', () => {
    const composition = readFileSync(
      resolve(
        ROOT,
        'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
      ),
      'utf8',
    )
    expect(composition).toContain('preallocatedTaskId: taskId,')
    // 执行身份在 admission 事务里预分配、重放按 id 命中；旧路径那套按 round 推断活性的
    // 兜底（E9-C 前置小修）随旧合同删除，不得回来。
    expect(composition).not.toContain('dedupeByRound')
    expect(composition).not.toContain('findByRound')
  })
})
