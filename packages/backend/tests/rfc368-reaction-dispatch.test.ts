// RFC-368 T8 / T11 / T13 —— 数字员工的 Reaction 派发臂（取代 outbox 的 `execution-launch`）。
//
// 锁四件事：
//   ① record-before-act：admission 与派发 epoch 同事务登记，执行身份在事务里就写到 round 上，
//      `launch` 拿的是同一个 id（design §4.1）。
//   ② 崩溃重放：admission 已提交、`launch` 没回来时进程死掉——租约过期后另一个 worker 重选这个
//      round，拿到**同一个执行身份**，admission 日志仍只有一行。这是 E9-C 那条缺陷
//      （一次 Reaction 起两个任务）在新合同下的结构性解法。
//   ③ 派发级预算：`launch` 本身失败时按 `dispatchRetrySchedule` 退避重派，耗尽后走终结分支，
//      两个用户可见字面值按 design §4.2 固定（`reaction-dispatch-failed` / `reaction-dispatch: `）——
//      不会无限重试（设计门 P1-7）。
//   ④ 案例已终止：不建任务，round 收成 obsolete，案例的 terminalKind 不被覆写。
// 另锁 T13：round 结算与 admission 收口同事务，不留 admitted/launched 残行。

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import { describeEachProvider } from './helpers/eachProvider'
import {
  employeeCases,
  employeeReactionDispatch,
  employeeReactionRounds,
  reactionExecutionAdmissions,
} from '@/db/schema'
import { DigitalEmployeeRuntimeService } from '@/modules/digital-employee/application/runtimeService'
import type {
  PreparedReactionExecutionV1,
  ReactionExecutionAdmissionReceiptV1,
  ReactionExecutionPortV1,
} from '@/modules/digital-employee/composition/required-ports'
import { DEFAULT_GLOBAL_EXECUTION_POLICY } from '@/modules/digital-employee/domain/model'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'

const CASE = 'case-dispatch'
const ROUND = 'round-dispatch'
const LEASE_MS = 1_000

function planJson(): string {
  return JSON.stringify({
    schemaVersion: 1,
    roundRef: ROUND,
    executionNonce: 'a'.repeat(64),
    caseRef: { id: CASE, revision: 1 },
    employeeTypeRef: null,
    inputContextRefs: [],
    triggeringEventRef: 'event-1',
    workItemRef: 'fixture-work',
    toolSlotRef: 'fixture-slot',
    workContractRef: { contractId: 'fixture.contract', version: 1 },
    toolRegistrationRef: null,
    connectionRef: null,
    implementationRef: null,
    implementationKind: 'agent',
    implementationJson: '{}',
    inputSchemaId: 'fixture.input',
    outputSchemaId: 'fixture.output',
    semanticValidatorId: 'fixture.validator',
    executionPolicyRevision: 1,
    roundBudgetMs: 60_000,
    maxTotalTokens: null,
    externalWaitDeadlineMs: 60_000,
    allowedEffectKinds: [],
    workspacePolicy: {
      mode: 'none',
      businessChangeOnOk: 'optional',
      writablePrefixes: [],
      platformWritePrefixes: [],
    },
    inputEnvelopeJson: '{}',
  })
}

interface Launch {
  readonly operation: string
  readonly execution: string
}

describe('RFC-368 T8 —— Reaction 派发臂', () => {
  describeEachProvider('dispatchOneReaction', (harness) => {
    let clock = 10_000
    let minted = 0

    async function seed(input: {
      readonly caseState?: 'active' | 'terminal'
      readonly terminalKind?: string | null
      readonly nextAttemptAt?: number
    }): Promise<void> {
      await harness.db
        .insert(employeeCases)
        .values({
          id: CASE,
          name: CASE,
          employeeId: 'employee-1',
          employeeRevision: 1,
          typeId: 'fixture',
          typeRevision: 1,
          primaryContextId: 'context-1',
          executionPolicyRevision: 1,
          state: input.caseState ?? 'active',
          terminalKind: input.terminalKind ?? null,
          activeRoundId: ROUND,
          currentWorkItemRef: 'fixture-work',
          ownerUserId: null,
          revision: 3,
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
      await harness.db
        .insert(employeeReactionRounds)
        .values({
          id: ROUND,
          caseId: CASE,
          caseRevision: 2,
          inboxId: null,
          employeeId: 'employee-1',
          employeeRevision: 1,
          ruleId: 'fixture-rule',
          workItemRef: 'fixture-work',
          workContractId: 'fixture.contract',
          workContractVersion: 1,
          toolId: 'fixture-tool',
          toolRevision: 1,
          executionPolicyRevision: 1,
          inputContextRefsJson: '[]',
          planJson: planJson(),
          state: 'planned',
          executionRef: null,
          outputJson: null,
          attemptOrdinal: 0,
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
      await harness.db
        .insert(employeeReactionDispatch)
        .values({
          roundRef: ROUND,
          caseId: CASE,
          nextAttemptAt: input.nextAttemptAt ?? 0,
          createdAt: 1,
          updatedAt: 1,
        })
        .run()
    }

    function service(input: {
      readonly port: ReactionExecutionPortV1
      readonly workerId?: string
      readonly handoffOnExhausted?: boolean
    }): DigitalEmployeeRuntimeService {
      const policy = {
        revision: 1,
        // sameScene 1 × freshScene 0 ⇒ retryAttemptCap = 2：第一次派发失败重派，第二次终结。
        content: {
          ...DEFAULT_GLOBAL_EXECUTION_POLICY,
          sameSceneAttempts: 1,
          freshSceneAttempts: 0,
          initialBackoffMs: 100,
          maxBackoffMs: 1_000,
          handoffOnExhausted: input.handoffOnExhausted ?? true,
        },
        contentDigest: 'digest',
        publishedAt: 1,
        publishedBy: null,
      }
      return new DigitalEmployeeRuntimeService({
        store: createRuntimePersistence(harness.db, {
          reactionAdmission: (tx) =>
            composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), {
              now: () => clock,
              mintExecutionRef: () => `execution-${++minted}`,
            }),
        }),
        authoringStore: {
          getExecutionPolicyRevision: async () => policy,
          getCurrentExecutionPolicy: async () => policy,
        },
        eventCenter: {},
        execution: {},
        platformWorkItems: {},
        inputUploads: {},
        inputArtifacts: {},
        runtimeCodecs: [],
        currentTypeRefs: [],
        executionContracts: {},
        now: () => clock,
        workerId: input.workerId ?? 'worker-a',
        reactionExecution: { port: input.port, dispatchLeaseMs: LEASE_MS },
      } as unknown as ConstructorParameters<typeof DigitalEmployeeRuntimeService>[0])
    }

    function recordingPort(
      launches: Launch[],
      behavior: (
        prepared: PreparedReactionExecutionV1,
        admission: ReactionExecutionAdmissionReceiptV1,
      ) => Promise<void> = async () => {},
    ): ReactionExecutionPortV1 {
      return {
        async launch(prepared, admission) {
          launches.push({ operation: prepared.request.operation, execution: admission.execution })
          await behavior(prepared, admission)
          return { executionRef: admission.execution }
        },
        inspect: async () => ({ kind: 'pending' }),
        inspectHumanReview: async () => ({ kind: 'not-applicable' }),
        cancel: async () => {
          throw new Error('not used')
        },
      }
    }

    async function round() {
      return (
        await harness.db
          .select()
          .from(employeeReactionRounds)
          .where(eq(employeeReactionRounds.id, ROUND))
          .all()
      )[0]!
    }
    async function dispatchRow() {
      return (
        await harness.db
          .select()
          .from(employeeReactionDispatch)
          .where(eq(employeeReactionDispatch.roundRef, ROUND))
          .all()
      )[0]!
    }
    async function caseRow() {
      return (
        await harness.db.select().from(employeeCases).where(eq(employeeCases.id, CASE)).all()
      )[0]!
    }

    test('① 同事务登记 admission 并把执行身份写到 round；launch 用的是同一个 id', async () => {
      clock = 10_000
      minted = 0
      await seed({})
      const launches: Launch[] = []
      expect(await service({ port: recordingPort(launches) }).dispatchOneReaction()).toBe(
        'launched',
      )
      expect(launches).toEqual([{ operation: `reaction:${ROUND}:0`, execution: 'execution-1' }])
      expect(await round()).toMatchObject({ state: 'running', executionRef: 'execution-1' })
      expect(await dispatchRow()).toMatchObject({
        claimEpoch: 1,
        dispatchAttempts: 1,
        operationRef: `reaction:${ROUND}:0`,
      })
      const admissions = await harness.db.select().from(reactionExecutionAdmissions).all()
      expect(admissions.map((row) => [row.operationRef, row.executionRef])).toEqual([
        [`reaction:${ROUND}:0`, 'execution-1'],
      ])
    })

    test('② 崩溃重放：admission 已提交、launch 没回来——租约过期后重选，同一个执行身份', async () => {
      clock = 10_000
      minted = 0
      await seed({})
      const launches: Launch[] = []
      // worker-a 的 launch 永不返回：模拟 admission 提交之后、launch 回执之前进程死掉。
      void service({
        port: recordingPort(launches, () => new Promise<void>(() => {})),
        workerId: 'worker-a',
      }).dispatchOneReaction()
      await Bun.sleep(50)
      expect(launches).toHaveLength(1)
      expect((await round()).state).toBe('planned')

      // 租约还在：别的 worker 领不到。
      const other = service({ port: recordingPort(launches), workerId: 'worker-b' })
      expect(await other.dispatchOneReaction()).toBe('idle')

      clock += LEASE_MS + 1
      expect(await other.dispatchOneReaction()).toBe('launched')
      expect(launches).toEqual([
        { operation: `reaction:${ROUND}:0`, execution: 'execution-1' },
        { operation: `reaction:${ROUND}:0`, execution: 'execution-1' },
      ])
      expect(await round()).toMatchObject({ state: 'running', executionRef: 'execution-1' })
      expect(await harness.db.select().from(reactionExecutionAdmissions).all()).toHaveLength(1)
      expect(await dispatchRow()).toMatchObject({ claimEpoch: 2, dispatchAttempts: 2 })
    })

    test('③ launch 失败按派发级退避重派；耗尽后结算 failed、案例 blocked，字面值固定', async () => {
      clock = 10_000
      minted = 0
      await seed({})
      const launches: Launch[] = []
      const failing = service({
        port: recordingPort(launches, async () => {
          throw new Error('exact agent unavailable')
        }),
      })
      expect(await failing.dispatchOneReaction()).toBe('retried')
      expect(await round()).toMatchObject({ state: 'planned', executionRef: null })
      expect(await dispatchRow()).toMatchObject({
        dispatchAttempts: 1,
        dispatchClaimedBy: null,
        dispatchLeaseExpiresAt: null,
        operationRef: null,
        nextAttemptAt: clock + 100,
        lastDispatchError: 'exact agent unavailable',
      })
      // 退避未到：不重派。
      expect(await failing.dispatchOneReaction()).toBe('idle')

      clock += 100
      expect(await failing.dispatchOneReaction()).toBe('settled')
      // 两次派发同一个 ordinal ⇒ 同一个 operation、同一个执行身份（admission 幂等）。
      expect(launches.map((launch) => launch.execution)).toEqual(['execution-1', 'execution-1'])
      const settled = await round()
      expect(settled.state).toBe('failed')
      expect(JSON.parse(settled.outputJson!)).toEqual({
        kind: 'reaction-dispatch-failed',
        errorCode: 'internal-error',
        detail: 'exact agent unavailable',
      })
      expect(await caseRow()).toMatchObject({
        state: 'blocked',
        blockReason: 'reaction-dispatch: exact agent unavailable',
        activeRoundId: null,
      })
      // T13：结算与收口同事务。
      const admissions = await harness.db.select().from(reactionExecutionAdmissions).all()
      expect(admissions.map((row) => row.state)).toEqual(['closed'])
    })

    test('③′ handoffOnExhausted=false ⇒ 耗尽后案例直接终止', async () => {
      clock = 10_000
      minted = 0
      await seed({})
      const failing = service({
        port: recordingPort([], async () => {
          throw new Error('boom')
        }),
        handoffOnExhausted: false,
      })
      await failing.dispatchOneReaction()
      clock += 100
      expect(await failing.dispatchOneReaction()).toBe('settled')
      expect(await caseRow()).toMatchObject({
        state: 'terminal',
        terminalKind: 'platform-dispatch-failed',
      })
    })

    test('④ 案例已终止：不建任务，round 收成 obsolete，terminalKind 原样保留', async () => {
      clock = 10_000
      minted = 0
      await seed({ caseState: 'terminal', terminalKind: 'user-canceled' })
      const launches: Launch[] = []
      expect(await service({ port: recordingPort(launches) }).dispatchOneReaction()).toBe('settled')
      expect(launches).toEqual([])
      expect((await round()).state).toBe('obsolete')
      expect(await caseRow()).toMatchObject({
        state: 'terminal',
        terminalKind: 'user-canceled',
        activeRoundId: null,
      })
    })

    test('未到期不派发；没装配新合同时整条臂是空操作', async () => {
      clock = 10_000
      minted = 0
      await seed({ nextAttemptAt: clock + 1 })
      const launches: Launch[] = []
      expect(await service({ port: recordingPort(launches) }).dispatchOneReaction()).toBe('idle')
      const legacy = new DigitalEmployeeRuntimeService({
        store: createRuntimePersistence(harness.db),
        runtimeCodecs: [],
        currentTypeRefs: [],
      } as unknown as ConstructorParameters<typeof DigitalEmployeeRuntimeService>[0])
      clock += 1
      expect(await legacy.dispatchOneReaction()).toBe('idle')
      expect(launches).toEqual([])
      expect((await dispatchRow()).dispatchAttempts).toBe(0)
    })

    test('T13：round 正常结算时 admission 同事务收口', async () => {
      clock = 10_000
      minted = 0
      await seed({})
      await service({ port: recordingPort([]) }).dispatchOneReaction()
      await createRuntimePersistence(harness.db, {
        reactionAdmission: (tx) =>
          composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), {
            now: () => clock,
          }),
      }).settleRound({ roundId: ROUND, state: 'completed', outputJson: '{}', now: clock })
      const admissions = await harness.db.select().from(reactionExecutionAdmissions).all()
      expect(admissions.map((row) => row.state)).toEqual(['closed'])
    })
  })
})
