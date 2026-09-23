// RFC-368 测试共用的 Reaction fixture：一个案例 + 一个 planned round + 它的派发行，
// 以及一台只装了新执行合同的 `DigitalEmployeeRuntimeService`（真 store、真 TE admission 日志、
// 假执行 port）。只供 `tests/rfc368-*.test.ts` 使用。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  employeeCases,
  employeeReactionDispatch,
  employeeReactionRounds,
  reactionExecutionAdmissions,
} from '@/db/schema'
import type { ReactionArtifactPersistence } from '@/modules/digital-employee/application/ports/reactionArtifacts'
import type { RuntimeCasePersistence } from '@/modules/digital-employee/application/ports/runtimeStore'
import { DigitalEmployeeRuntimeService } from '@/modules/digital-employee/application/runtimeService'
import type {
  PreparedReactionExecutionV1,
  ReactionExecutionAdmissionReceiptV1,
  ReactionExecutionPortV1,
  ReactionExecutionSnapshotV1,
} from '@/modules/digital-employee/composition/required-ports'
import { DEFAULT_GLOBAL_EXECUTION_POLICY } from '@/modules/digital-employee/domain/model'
import { createReactionArtifactPersistence } from '@/modules/digital-employee/infrastructure/reactionArtifactStore'
import { createRuntimePersistence } from '@/modules/digital-employee/infrastructure/runtimeStore'
import { composeReactionExecutionAdmissionParticipantInTx } from '@/modules/task-execution/application/adapters/reaction-admission-adapter'
import { createReactionAdmissionStore } from '@/modules/task-execution/infrastructure/reactionExecutionAdmissions'

export const REACTION_CASE = 'case-rfc368'
export const REACTION_ROUND = 'round-rfc368'
export const REACTION_LEASE_MS = 1_000

export function reactionPlanJson(input: { readonly maxTotalTokens?: number | null } = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    roundRef: REACTION_ROUND,
    executionNonce: 'a'.repeat(64),
    caseRef: { id: REACTION_CASE, revision: 1 },
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
    maxTotalTokens: input.maxTotalTokens ?? null,
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

export async function seedReaction(
  db: ProviderNeutralDatabase,
  input: {
    readonly caseState?: 'active' | 'terminal'
    readonly terminalKind?: string | null
    readonly nextAttemptAt?: number
    readonly maxTotalTokens?: number | null
    /** 切换前由旧路径建出的 round 没有派发行。 */
    readonly withDispatch?: boolean
    readonly roundState?: 'planned' | 'running'
    readonly executionRef?: string | null
    readonly attemptOrdinal?: number
  } = {},
): Promise<void> {
  await db
    .insert(employeeCases)
    .values({
      id: REACTION_CASE,
      name: REACTION_CASE,
      employeeId: 'employee-1',
      employeeRevision: 1,
      typeId: 'fixture',
      typeRevision: 1,
      primaryContextId: 'context-1',
      executionPolicyRevision: 1,
      state: input.caseState ?? 'active',
      terminalKind: input.terminalKind ?? null,
      activeRoundId: REACTION_ROUND,
      currentWorkItemRef: 'fixture-work',
      ownerUserId: null,
      maxTotalTokens: input.maxTotalTokens ?? null,
      revision: 3,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  await db
    .insert(employeeReactionRounds)
    .values({
      id: REACTION_ROUND,
      caseId: REACTION_CASE,
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
      planJson: reactionPlanJson({ maxTotalTokens: input.maxTotalTokens ?? null }),
      state: input.roundState ?? 'planned',
      executionRef: input.executionRef ?? null,
      outputJson: null,
      attemptOrdinal: input.attemptOrdinal ?? 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
  if (input.withDispatch === false) return
  await db
    .insert(employeeReactionDispatch)
    .values({
      roundRef: REACTION_ROUND,
      caseId: REACTION_CASE,
      nextAttemptAt: input.nextAttemptAt ?? 0,
      createdAt: 1,
      updatedAt: 1,
    })
    .run()
}

export interface RecordedLaunch {
  readonly operation: string
  readonly execution: string
  readonly prepared: PreparedReactionExecutionV1
}

export interface ScriptedPort extends ReactionExecutionPortV1 {
  readonly launches: RecordedLaunch[]
  readonly canceled: string[]
  snapshot: ReactionExecutionSnapshotV1
  launchBehavior: (
    prepared: PreparedReactionExecutionV1,
    admission: ReactionExecutionAdmissionReceiptV1,
  ) => Promise<void>
  cancelBehavior: () => Promise<void>
}

export function scriptedPort(): ScriptedPort {
  const port: ScriptedPort = {
    launches: [],
    canceled: [],
    snapshot: { kind: 'pending' },
    launchBehavior: async () => {},
    cancelBehavior: async () => {},
    async launch(prepared, admission) {
      port.launches.push({
        operation: prepared.request.operation,
        execution: admission.execution,
        prepared,
      })
      await port.launchBehavior(prepared, admission)
      return { executionRef: admission.execution }
    },
    inspect: async () => port.snapshot,
    inspectHumanReview: async () => ({ kind: 'not-applicable' }),
    async cancel(access) {
      port.canceled.push(`${access.operation}|${access.executionRef}`)
      await port.cancelBehavior()
      return `stopped:${access.executionRef}` as never
    },
  }
  return port
}

export function reactionService(
  db: ProviderNeutralDatabase,
  input: {
    readonly port: ReactionExecutionPortV1
    readonly now: () => number
    readonly mint: () => string
    readonly workerId?: string
    readonly handoffOnExhausted?: boolean
    readonly artifacts?: ReactionArtifactPersistence
    /** 包一层 store（注入故障用）。 */
    readonly wrapStore?: (store: RuntimeCasePersistence) => RuntimeCasePersistence
  },
): DigitalEmployeeRuntimeService {
  const policy = {
    revision: 1,
    // sameScene 1 × freshScene 0 ⇒ retryAttemptCap = 2：round 级 ordinal 0 失败重试、ordinal 1
    // 失败结算；派发级第一次失败重派、第二次终结。
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
    store: (input.wrapStore ?? ((store) => store))(
      createRuntimePersistence(db, {
        reactionAdmission: (tx) =>
          composeReactionExecutionAdmissionParticipantInTx(createReactionAdmissionStore(tx), {
            now: input.now,
            mintExecutionRef: input.mint,
          }),
      }),
    ),
    authoringStore: {
      getExecutionPolicyRevision: async () => policy,
      getCurrentExecutionPolicy: async () => policy,
    },
    eventCenter: {},
    platformWorkItems: {},
    inputUploads: {},
    inputArtifacts: {},
    runtimeCodecs: [],
    currentTypeRefs: [],
    executionContracts: {},
    now: input.now,
    workerId: input.workerId ?? 'worker-a',
    reactionExecution: {
      port: input.port,
      artifacts: input.artifacts ?? createReactionArtifactPersistence(db),
      dispatchLeaseMs: REACTION_LEASE_MS,
    },
  } as unknown as ConstructorParameters<typeof DigitalEmployeeRuntimeService>[0])
}

export async function reactionRows(db: ProviderNeutralDatabase) {
  const round = (
    await db
      .select()
      .from(employeeReactionRounds)
      .where(eq(employeeReactionRounds.id, REACTION_ROUND))
      .all()
  )[0]!
  const dispatch = (
    await db
      .select()
      .from(employeeReactionDispatch)
      .where(eq(employeeReactionDispatch.roundRef, REACTION_ROUND))
      .all()
  )[0]!
  const employeeCase = (
    await db.select().from(employeeCases).where(eq(employeeCases.id, REACTION_CASE)).all()
  )[0]!
  const admissions = await db.select().from(reactionExecutionAdmissions).all()
  return { round, dispatch, employeeCase, admissions }
}
