// RFC-359 AC12: command contexts must retain the capabilities actually supplied at
// construction. Complete routes cannot accept a base or partially composed context;
// gate/artifact consumers keep their base contract. The runtime fixtures use real
// ports on the harness DB, and the static negatives do not execute domain commands.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { collaborationGateOperations, taskQuestions, tasks } from '@/db/schema'
import {
  createCollaborationCommandContext,
  createCollaborationCommandContextFromPersistence,
  createPostgresqlCollaborationCommandContext,
  requireClarifyDecisionCommand,
  requireCollaborationTaskExecutionReadModels,
  requireQuestionDispatchCommand,
  requireReviewDecisionCommand,
  resolveCollaborationCommandContext,
  type CollaborationCommandContextInput,
  type CollaborationCommandDependencies,
  type PostgresqlCollaborationCommandContextInput,
} from '@/modules/collaboration/composition/commandContext'
import type {
  composePostgresqlCollaborationRouteOperations,
  composeSqliteCollaborationRouteOperations,
} from '@/modules/collaboration/composition/collaborationRouteOperations'
import {
  createClarifyDecisionCommand,
  createQuestionDispatchCommand,
  createReviewDecisionCommand,
} from '@/modules/collaboration/composition/decisionCommands'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import type { createClarifyDecisionCommandContext } from '@/modules/collaboration/infrastructure/clarifyDecisionCommand'
import type { createQuestionDispatchCommandContext } from '@/modules/collaboration/infrastructure/questionDispatchCommand'
import type { createReviewDecisionCommandContext } from '@/modules/collaboration/infrastructure/reviewDecisionCommand'
import {
  createManualQuestionOpen,
  type dispatchTaskQuestions,
  type prepareClarifyGateOpen,
  type prepareReviewGateOpen,
  type replaceReviewNodeReviewers,
  type submitClarifyDecision,
  type submitReviewDecision,
} from '@/modules/collaboration/public/commands'
import type { getReviewNodeReviewerConfig } from '@/modules/collaboration/public/queries'
import type {
  CollaborationCommandContext,
  CollaborationRouteContext,
} from '@/modules/collaboration/public/types'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import type {
  SelectedSqliteTaskExecutionProviderRuntime,
  SqliteTaskExecutionProviderRuntimeDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import type { PostgresqlTaskRouteOperationsDependencies } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteOperations'
import type { SqliteTaskRouteOperationsDependencies } from '@/modules/task-execution/infrastructure/sqliteTaskRouteOperations'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { AppDeps } from '@/server'
import { describeEachProvider } from './helpers/eachProvider'
import { DESIGNER, freshTaskId, seedTask } from './helpers/questionDispatchFixture'

function composeCapabilities(db: ProviderNeutralDatabase, appHome: string) {
  const memory = composeMemoryOperationsFor({
    db,
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(db, appHome),
  })
  return {
    reviewDecisions: createReviewDecisionCommand({ db, appHome }),
    questionDispatches: createQuestionDispatchCommand(db),
    clarifyDecisions: createClarifyDecisionCommand(db, memory.distillCommands),
    taskExecutionReadModels: createTaskExecutionReadModels(db),
  }
}

type Capabilities = ReturnType<typeof composeCapabilities>
type ReviewContext = Parameters<typeof submitReviewDecision>[0]
type QuestionContext = Parameters<typeof dispatchTaskQuestions>[0]
type ClarifyContext = Parameters<typeof submitClarifyDecision>[0]
type ReadModelsContext = Parameters<typeof getReviewNodeReviewerConfig>[0]
type SqliteRouteContext = Parameters<typeof composeSqliteCollaborationRouteOperations>[0]['context']
type PostgresqlRouteContext = Parameters<
  typeof composePostgresqlCollaborationRouteOperations
>[0]['context']
type AppRouteContext = AppDeps['collaborationContext']
type ProviderRouteContext = ReturnType<
  SqliteTaskExecutionProviderRuntimeDependencies['routes']
>['collaboration']
type SelectedRouteContext = SelectedSqliteTaskExecutionProviderRuntime['collaboration']

// Checked by backend tsc, never invoked: no fabricated result or driver is needed
// to prove that the production factories and their consumers reject missing ports.
function constructionTypeContracts(
  db: ProviderNeutralDatabase,
  pgDb: PostgresqlDatabaseClient,
  persistence: CollaborationCommandDependencies,
  capabilities: Capabilities,
  condition: boolean,
) {
  const base = createCollaborationCommandContext({ db })
  // @ts-expect-error A base context cannot submit review decisions.
  const baseReview: ReviewContext = base
  // @ts-expect-error A base context cannot dispatch questions.
  const baseQuestion: QuestionContext = base
  // @ts-expect-error A base context cannot submit clarify decisions.
  const baseClarify: ClarifyContext = base
  // @ts-expect-error A base context cannot query reviewer configuration.
  const baseReadModels: ReadModelsContext = base
  void [baseReview, baseQuestion, baseClarify, baseReadModels]

  const review = createCollaborationCommandContext({
    db,
    reviewDecisions: capabilities.reviewDecisions,
  })
  const question = createCollaborationCommandContext({
    db,
    questionDispatches: capabilities.questionDispatches,
  })
  const clarify = createCollaborationCommandContext({
    db,
    clarifyDecisions: capabilities.clarifyDecisions,
  })
  const reads = createCollaborationCommandContext({
    db,
    taskExecutionReadModels: capabilities.taskExecutionReadModels,
  })
  const singleCapabilities: [ReviewContext, QuestionContext, ClarifyContext, ReadModelsContext] = [
    review,
    question,
    clarify,
    reads,
  ]
  const narrowConsumers: [
    Parameters<typeof replaceReviewNodeReviewers>[0],
    SqliteTaskRouteOperationsDependencies['collaboration'],
    PostgresqlTaskRouteOperationsDependencies['collaboration'],
  ] = [reads, reads, reads]
  const baseConsumers: [
    Parameters<typeof createManualQuestionOpen>[0],
    Parameters<typeof prepareReviewGateOpen>[0],
    Parameters<typeof prepareClarifyGateOpen>[0],
  ] = [base, base, base]
  void [singleCapabilities, narrowConsumers, baseConsumers]

  const full: CollaborationRouteContext = createCollaborationCommandContext({ db, ...capabilities })
  const completeConsumers: [
    CollaborationCommandContext,
    ReviewContext,
    QuestionContext,
    ClarifyContext,
    ReadModelsContext,
    SqliteRouteContext,
    PostgresqlRouteContext,
    AppRouteContext,
    ProviderRouteContext,
    SelectedRouteContext,
  ] = [full, full, full, full, full, full, full, full, full, full]
  void completeConsumers
  const widened: CollaborationCommandContext = full
  // @ts-expect-error An explicitly erased capability cannot be recovered by a consumer.
  const erasedReview: ReviewContext = widened
  void erasedReview

  const missingReview = createCollaborationCommandContext({
    db,
    questionDispatches: capabilities.questionDispatches,
    clarifyDecisions: capabilities.clarifyDecisions,
    taskExecutionReadModels: capabilities.taskExecutionReadModels,
  })
  const missingQuestion = createCollaborationCommandContext({
    db,
    reviewDecisions: capabilities.reviewDecisions,
    clarifyDecisions: capabilities.clarifyDecisions,
    taskExecutionReadModels: capabilities.taskExecutionReadModels,
  })
  const missingClarify = createCollaborationCommandContext({
    db,
    reviewDecisions: capabilities.reviewDecisions,
    questionDispatches: capabilities.questionDispatches,
    taskExecutionReadModels: capabilities.taskExecutionReadModels,
  })
  const missingReads = createCollaborationCommandContext({
    db,
    reviewDecisions: capabilities.reviewDecisions,
    questionDispatches: capabilities.questionDispatches,
    clarifyDecisions: capabilities.clarifyDecisions,
  })
  // @ts-expect-error The Sqlite entry must reject the missing Review capability.
  const missingReviewForSqlite: SqliteRouteContext = missingReview
  // @ts-expect-error The Postgresql entry must reject the missing Review capability.
  const missingReviewForPostgresql: PostgresqlRouteContext = missingReview
  // @ts-expect-error The App entry must reject the missing Review capability.
  const missingReviewForApp: AppRouteContext = missingReview
  // @ts-expect-error The Provider entry must reject the missing Review capability.
  const missingReviewForProvider: ProviderRouteContext = missingReview
  // @ts-expect-error The Selected entry must reject the missing Review capability.
  const missingReviewForSelected: SelectedRouteContext = missingReview
  void [
    missingReviewForSqlite,
    missingReviewForPostgresql,
    missingReviewForApp,
    missingReviewForProvider,
    missingReviewForSelected,
  ]

  // @ts-expect-error The Sqlite entry must reject the missing Question capability.
  const missingQuestionForSqlite: SqliteRouteContext = missingQuestion
  // @ts-expect-error The Postgresql entry must reject the missing Question capability.
  const missingQuestionForPostgresql: PostgresqlRouteContext = missingQuestion
  // @ts-expect-error The App entry must reject the missing Question capability.
  const missingQuestionForApp: AppRouteContext = missingQuestion
  // @ts-expect-error The Provider entry must reject the missing Question capability.
  const missingQuestionForProvider: ProviderRouteContext = missingQuestion
  // @ts-expect-error The Selected entry must reject the missing Question capability.
  const missingQuestionForSelected: SelectedRouteContext = missingQuestion
  void [
    missingQuestionForSqlite,
    missingQuestionForPostgresql,
    missingQuestionForApp,
    missingQuestionForProvider,
    missingQuestionForSelected,
  ]

  // @ts-expect-error The Sqlite entry must reject the missing Clarify capability.
  const missingClarifyForSqlite: SqliteRouteContext = missingClarify
  // @ts-expect-error The Postgresql entry must reject the missing Clarify capability.
  const missingClarifyForPostgresql: PostgresqlRouteContext = missingClarify
  // @ts-expect-error The App entry must reject the missing Clarify capability.
  const missingClarifyForApp: AppRouteContext = missingClarify
  // @ts-expect-error The Provider entry must reject the missing Clarify capability.
  const missingClarifyForProvider: ProviderRouteContext = missingClarify
  // @ts-expect-error The Selected entry must reject the missing Clarify capability.
  const missingClarifyForSelected: SelectedRouteContext = missingClarify
  void [
    missingClarifyForSqlite,
    missingClarifyForPostgresql,
    missingClarifyForApp,
    missingClarifyForProvider,
    missingClarifyForSelected,
  ]

  // @ts-expect-error The Sqlite entry must reject the missing Reads capability.
  const missingReadsForSqlite: SqliteRouteContext = missingReads
  // @ts-expect-error The Postgresql entry must reject the missing Reads capability.
  const missingReadsForPostgresql: PostgresqlRouteContext = missingReads
  // @ts-expect-error The App entry must reject the missing Reads capability.
  const missingReadsForApp: AppRouteContext = missingReads
  // @ts-expect-error The Provider entry must reject the missing Reads capability.
  const missingReadsForProvider: ProviderRouteContext = missingReads
  // @ts-expect-error The Selected entry must reject the missing Reads capability.
  const missingReadsForSelected: SelectedRouteContext = missingReads
  void [
    missingReadsForSqlite,
    missingReadsForPostgresql,
    missingReadsForApp,
    missingReadsForProvider,
    missingReadsForSelected,
  ]

  const optionalInput: CollaborationCommandContextInput = { db, ...capabilities }
  const optional = createCollaborationCommandContext(optionalInput)
  const conditional = createCollaborationCommandContext(
    condition ? { db, ...capabilities } : { db },
  )
  const undefinedPort = createCollaborationCommandContext({
    db,
    ...capabilities,
    reviewDecisions: undefined,
  })
  // @ts-expect-error Optional fields do not promise a complete context.
  const optionalFull: CollaborationRouteContext = optional
  // @ts-expect-error A conditional input must guarantee the capability on both branches.
  const conditionalFull: CollaborationRouteContext = conditional
  // @ts-expect-error Explicit undefined is not a review decision port.
  const undefinedReview: ReviewContext = undefinedPort
  void [optionalFull, conditionalFull, undefinedReview]

  const pgFull: CollaborationRouteContext = createPostgresqlCollaborationCommandContext({
    db: pgDb,
    ...capabilities,
  })
  const pgOptionalInput: PostgresqlCollaborationCommandContextInput = { db: pgDb, ...capabilities }
  const pgOptional = createPostgresqlCollaborationCommandContext(pgOptionalInput)
  const pgConditional = createPostgresqlCollaborationCommandContext(
    condition ? { db: pgDb, ...capabilities } : { db: pgDb },
  )
  const pgUndefined = createPostgresqlCollaborationCommandContext({
    db: pgDb,
    ...capabilities,
    reviewDecisions: undefined,
  })
  // @ts-expect-error The PG factory must retain the optional-input boundary.
  const pgOptionalFull: CollaborationRouteContext = pgOptional
  // @ts-expect-error The PG factory must not promote a conditional capability.
  const pgConditionalFull: CollaborationRouteContext = pgConditional
  // @ts-expect-error The PG factory must not promote an undefined port.
  const pgUndefinedReview: ReviewContext = pgUndefined
  void [pgFull, pgOptionalFull, pgConditionalFull, pgUndefinedReview]

  const persistenceFull: CollaborationRouteContext =
    createCollaborationCommandContextFromPersistence({ ...persistence, ...capabilities })
  const persistenceOptionalInput: CollaborationCommandDependencies = {
    ...persistence,
    ...capabilities,
  }
  const persistenceOptional =
    createCollaborationCommandContextFromPersistence(persistenceOptionalInput)
  const persistenceConditional = createCollaborationCommandContextFromPersistence(
    condition ? { ...persistence, ...capabilities } : persistence,
  )
  const persistenceUndefined = createCollaborationCommandContextFromPersistence({
    ...persistence,
    ...capabilities,
    reviewDecisions: undefined,
  })
  // @ts-expect-error Persistence composition must retain the optional-input boundary.
  const persistenceOptionalFull: CollaborationRouteContext = persistenceOptional
  // @ts-expect-error Persistence composition must not promote a conditional capability.
  const persistenceConditionalFull: CollaborationRouteContext = persistenceConditional
  // @ts-expect-error Persistence composition must not promote an undefined port.
  const persistenceUndefinedReview: ReviewContext = persistenceUndefined
  void [
    persistenceFull,
    persistenceOptionalFull,
    persistenceConditionalFull,
    persistenceUndefinedReview,
  ]
}
void constructionTypeContracts

function legacyBridgeTypeContracts(
  review: ReturnType<typeof createReviewDecisionCommandContext>,
  question: ReturnType<typeof createQuestionDispatchCommandContext>,
  clarify: ReturnType<typeof createClarifyDecisionCommandContext>,
) {
  const publicContexts: [ReviewContext, QuestionContext, ClarifyContext] = [
    review,
    question,
    clarify,
  ]
  void publicContexts
}
void legacyBridgeTypeContracts

describeEachProvider('RFC-359 W12 collaboration context capabilities', (harness) => {
  let appHome = ''
  beforeEach(() => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc359-context-'))
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('single and complete contexts retain the original real ports without running commands', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const capabilities = composeCapabilities(db, appHome)
    const review = createCollaborationCommandContext({
      db,
      reviewDecisions: capabilities.reviewDecisions,
    })
    const question = createCollaborationCommandContext({
      db,
      questionDispatches: capabilities.questionDispatches,
    })
    const clarify = createCollaborationCommandContext({
      db,
      clarifyDecisions: capabilities.clarifyDecisions,
    })
    const reads = createCollaborationCommandContext({
      db,
      taskExecutionReadModels: capabilities.taskExecutionReadModels,
    })
    const full: CollaborationRouteContext = createCollaborationCommandContext({
      db,
      appHome,
      ...capabilities,
    })
    const baseView: CollaborationCommandContext = full
    expect(baseView).toBe(full)
    expect(Object.isFrozen(full)).toBe(true)
    expect(Object.keys(full)).toEqual([])
    expect(requireReviewDecisionCommand(review)).toBe(capabilities.reviewDecisions)
    expect(requireQuestionDispatchCommand(question)).toBe(capabilities.questionDispatches)
    expect(requireClarifyDecisionCommand(clarify)).toBe(capabilities.clarifyDecisions)
    expect(requireCollaborationTaskExecutionReadModels(reads)).toBe(
      capabilities.taskExecutionReadModels,
    )
    expect(requireReviewDecisionCommand(full)).toBe(capabilities.reviewDecisions)
    expect(requireQuestionDispatchCommand(full)).toBe(capabilities.questionDispatches)
    expect(requireClarifyDecisionCommand(full)).toBe(capabilities.clarifyDecisions)
    expect(requireCollaborationTaskExecutionReadModels(full)).toBe(
      capabilities.taskExecutionReadModels,
    )
    expect(
      await requireCollaborationTaskExecutionReadModels(reads).statusProjection.find(taskId),
    ).toEqual({ taskId, status: 'awaiting_human', errorSummary: null })
    expect(await db.select().from(collaborationGateOperations)).toEqual([])
    expect(await db.select().from(taskQuestions)).toEqual([])
  })

  test('persistence composition retains the supplied dependency instances in its frozen snapshot', () => {
    const db = harness.db
    const base = createCollaborationCommandContext({ db, appHome })
    const original = resolveCollaborationCommandContext(base)
    const capabilities = composeCapabilities(db, appHome)
    const input = { ...original, ...capabilities }
    const context: CollaborationRouteContext =
      createCollaborationCommandContextFromPersistence(input)
    const resolved = resolveCollaborationCommandContext(context)
    expect(resolved).toBe(resolveCollaborationCommandContext(context))
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(resolved.persistence).toBe(original.persistence)
    expect(resolved.artifacts).toBe(original.artifacts)
    expect(resolved.taskAccess).toBe(original.taskAccess)
    expect(resolved.reviewTaskAccess).toBe(original.reviewTaskAccess)
    expect(requireReviewDecisionCommand(context)).toBe(capabilities.reviewDecisions)
    expect(requireQuestionDispatchCommand(context)).toBe(capabilities.questionDispatches)
    expect(requireClarifyDecisionCommand(context)).toBe(capabilities.clarifyDecisions)
    expect(requireCollaborationTaskExecutionReadModels(context)).toBe(
      capabilities.taskExecutionReadModels,
    )
    input.questionDispatches = createQuestionDispatchCommand(db)
    expect(requireQuestionDispatchCommand(context)).toBe(capabilities.questionDispatches)
    expect(context).not.toBe(base)
  })

  test('the base context still writes the manual-question obligation on the same DB', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const context = createCollaborationCommandContext({ db })
    const created = await createManualQuestionOpen(context, {
      taskId,
      title: 'Investigate this edge case',
      body: 'Re-run the designer with this instruction.',
      targetNodeId: DESIGNER,
      actorUserId: 'u1',
      now: 1_700_000_000_000,
    })
    expect((await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
      'awaiting_human',
    )
    expect(
      (await db.select().from(taskQuestions).where(eq(taskQuestions.id, created.questionId)))[0],
    ).toMatchObject({
      taskId,
      sourceKind: 'manual',
      roleKind: 'designer',
      questionTitle: 'Investigate this edge case',
      manualBody: 'Re-run the designer with this instruction.',
      stagedBy: 'u1',
      overrideTargetNodeId: DESIGNER,
    })
    expect(
      (
        await db
          .select()
          .from(collaborationGateOperations)
          .where(eq(collaborationGateOperations.id, created.operationId))
      )[0],
    ).toMatchObject({
      taskId,
      state: 'prepared',
      operationKind: 'manual-question-open',
      gateKind: 'questions',
    })
    expect(resolveCollaborationCommandContext(context).reviewDecisions).toBeUndefined()
    expect(resolveCollaborationCommandContext(context).questionDispatches).toBeUndefined()
    expect(resolveCollaborationCommandContext(context).clarifyDecisions).toBeUndefined()
    expect(resolveCollaborationCommandContext(context).taskExecutionReadModels).toBeUndefined()
  })
})
