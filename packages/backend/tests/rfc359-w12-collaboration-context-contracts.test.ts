import { createNodeRunQueries, createNodeOutputQueries } from '@/modules/task-execution/composition'
import { taskExecutionParticipants } from './helpers/taskExecutionParticipantBindings'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { withO2Closure, o2Ports } from './helpers/o2Closure'
import { readTaskFixtures } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  memorySystemAgentBindingForTest,
  runtimeManagementDistillRuntimes,
} from './helpers/memoryDistill'
import { composeNodeRunPromptOperations } from '@/modules/task-execution/composition/nodeRunPrompts'
import { createFileReviewArtifactContent } from '@/modules/collaboration/infrastructure/local/fileReviewArtifactContent'
// RFC-359 AC12: command contexts must retain the capabilities actually supplied at
// construction. Complete routes cannot accept a base or partially composed context;
// gate/artifact consumers keep their base contract. The runtime fixtures use real
// ports on the harness DB, and the static negatives do not execute domain commands.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createCollaborationCommandContext,
  type CollaborationCommandContextInput,
  type PostgresqlCollaborationCommandContextInput,
} from '@/modules/collaboration/infrastructure/collaborationCommandContext'
import {
  createCollaborationCommandContextFromPersistence,
  requireClarifyDecisionCommand,
  requireCollaborationTaskExecutionReadModels,
  requireQuestionDispatchCommand,
  requireReviewDecisionCommand,
  resolveCollaborationCommandContext,
  type CollaborationCommandDependencies,
} from '@/modules/collaboration/application/commandContext'
import type { composeCollaborationRouteOperations } from '@/modules/collaboration/composition/collaborationRouteOperations'
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
  type submitClarifyDecision,
  type submitReviewDecision,
} from '@/modules/collaboration/application/commandEntries'
import { type replaceReviewNodeReviewers } from '@/modules/collaboration/application/reviewNodeReviewerEntries'
import type { getReviewNodeReviewerConfig } from '@/modules/collaboration/application/reviewNodeReviewerEntries'
import type {
  CollaborationCommandContext,
  CollaborationRouteContext,
} from '@/modules/collaboration/public/types'
import { composeMemoryOperationsFor } from '@/modules/memory/composition'
import type {
  SelectedTaskExecutionProviderRuntime,
  TaskExecutionProviderRuntimeDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { DaemonTaskExecutionModules } from '@/bootstrap/daemonModules/taskExecution'
import { describeEachProvider } from './helpers/eachProvider'
import { DESIGNER, freshTaskId, seedTask } from './helpers/questionDispatchFixture'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'

function composeCapabilities(db: PersistenceDb, appHome: string) {
  const memory = composeMemoryOperationsFor({
    taskNodeRuns: createNodeRunQueries(db),
    taskNodeOutputs: createNodeOutputQueries(db),
    clarifyAnswers: createClarifyAnswerQueries(db, taskExecutionParticipants),
    systemAgentBinding: memorySystemAgentBindingForTest(),
    runtimeProfiles: runtimeManagementDistillRuntimes(db),
    db,
    nodeRunPrompts: composeNodeRunPromptOperations(undefined, join(appHome, 'runs')),
    reviewedArtifacts: new DatabaseCommittedReviewArtifactReader(
      db,
      createFileReviewArtifactContent(appHome),
      epoch2RuntimeTestPorts(db).content,
    ),
  })
  return {
    reviewDecisions: createReviewDecisionCommand(withO2Closure({ db, appHome })),
    questionDispatches: createQuestionDispatchCommand(db, o2Ports(db).taskLock, {
      taskExecutionParticipants,
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
    }),
    clarifyDecisions: createClarifyDecisionCommand(
      db,
      memory.distillCommands,
      o2Ports(db).taskLock,
      {
        taskExecutionParticipants,
        historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      },
    ),
    taskExecutionReadModels: createTaskExecutionReadModels(db),
  }
}

type Capabilities = ReturnType<typeof composeCapabilities>
type ReviewContext = Parameters<typeof submitReviewDecision>[0]
type QuestionContext = Parameters<typeof dispatchTaskQuestions>[0]
type ClarifyContext = Parameters<typeof submitClarifyDecision>[0]
type ReadModelsContext = Parameters<typeof getReviewNodeReviewerConfig>[0]
type SqliteRouteContext = Parameters<typeof composeCollaborationRouteOperations>[0]['context']
type PostgresqlRouteContext = Parameters<typeof composeCollaborationRouteOperations>[0]['context']
type AppRouteContext = DaemonTaskExecutionModules['collaboration']

// Checked by backend tsc, never invoked: no fabricated result or driver is needed
// to prove that the production factories and their consumers reject missing ports.
function constructionTypeContracts(
  db: PersistenceDb,
  pgDb: PostgresqlDatabaseClient,
  persistence: CollaborationCommandDependencies,
  capabilities: Capabilities,
  condition: boolean,
) {
  const base = createCollaborationCommandContext({
    ...withO2Closure({ db }),
    taskExecutionParticipants,
  })
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
    ...withO2Closure({
      db,
      reviewDecisions: capabilities.reviewDecisions,
    }),
    taskExecutionParticipants,
  })
  const question = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      questionDispatches: capabilities.questionDispatches,
    }),
    taskExecutionParticipants,
  })
  const clarify = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      clarifyDecisions: capabilities.clarifyDecisions,
    }),
    taskExecutionParticipants,
  })
  const reads = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      taskExecutionReadModels: capabilities.taskExecutionReadModels,
    }),
    taskExecutionParticipants,
  })
  const singleCapabilities: [ReviewContext, QuestionContext, ClarifyContext, ReadModelsContext] = [
    review,
    question,
    clarify,
    reads,
  ]
  // RFC-481: Task Execution's route dependencies no longer carry collaboration's context (they never read it), so the
  // reviewer-config entry is the one narrow consumer left.
  const narrowConsumers: [Parameters<typeof replaceReviewNodeReviewers>[0]] = [reads]
  const baseConsumers: [
    Parameters<typeof createManualQuestionOpen>[0],
    Parameters<typeof prepareReviewGateOpen>[0],
    Parameters<typeof prepareClarifyGateOpen>[0],
  ] = [base, base, base]
  void [singleCapabilities, narrowConsumers, baseConsumers]

  const full: CollaborationRouteContext = createCollaborationCommandContext({
    ...withO2Closure({ db, ...capabilities }),
    taskExecutionParticipants,
  })
  const completeConsumers: [
    CollaborationCommandContext,
    ReviewContext,
    QuestionContext,
    ClarifyContext,
    ReadModelsContext,
    SqliteRouteContext,
    PostgresqlRouteContext,
    AppRouteContext,
  ] = [full, full, full, full, full, full, full, full]
  void completeConsumers
  const widened: CollaborationCommandContext = full
  // @ts-expect-error An explicitly erased capability cannot be recovered by a consumer.
  const erasedReview: ReviewContext = widened
  void erasedReview

  const missingReview = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      questionDispatches: capabilities.questionDispatches,
      clarifyDecisions: capabilities.clarifyDecisions,
      taskExecutionReadModels: capabilities.taskExecutionReadModels,
    }),
    taskExecutionParticipants,
  })
  const missingQuestion = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      reviewDecisions: capabilities.reviewDecisions,
      clarifyDecisions: capabilities.clarifyDecisions,
      taskExecutionReadModels: capabilities.taskExecutionReadModels,
    }),
    taskExecutionParticipants,
  })
  const missingClarify = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      reviewDecisions: capabilities.reviewDecisions,
      questionDispatches: capabilities.questionDispatches,
      taskExecutionReadModels: capabilities.taskExecutionReadModels,
    }),
    taskExecutionParticipants,
  })
  const missingReads = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      reviewDecisions: capabilities.reviewDecisions,
      questionDispatches: capabilities.questionDispatches,
      clarifyDecisions: capabilities.clarifyDecisions,
    }),
    taskExecutionParticipants,
  })
  // @ts-expect-error The Sqlite entry must reject the missing Review capability.
  const missingReviewForSqlite: SqliteRouteContext = missingReview
  // @ts-expect-error The Postgresql entry must reject the missing Review capability.
  const missingReviewForPostgresql: PostgresqlRouteContext = missingReview
  // @ts-expect-error The App entry must reject the missing Review capability.
  const missingReviewForApp: AppRouteContext = missingReview
  void [missingReviewForSqlite, missingReviewForPostgresql, missingReviewForApp]

  // @ts-expect-error The Sqlite entry must reject the missing Question capability.
  const missingQuestionForSqlite: SqliteRouteContext = missingQuestion
  // @ts-expect-error The Postgresql entry must reject the missing Question capability.
  const missingQuestionForPostgresql: PostgresqlRouteContext = missingQuestion
  // @ts-expect-error The App entry must reject the missing Question capability.
  const missingQuestionForApp: AppRouteContext = missingQuestion
  void [missingQuestionForSqlite, missingQuestionForPostgresql, missingQuestionForApp]

  // @ts-expect-error The Sqlite entry must reject the missing Clarify capability.
  const missingClarifyForSqlite: SqliteRouteContext = missingClarify
  // @ts-expect-error The Postgresql entry must reject the missing Clarify capability.
  const missingClarifyForPostgresql: PostgresqlRouteContext = missingClarify
  // @ts-expect-error The App entry must reject the missing Clarify capability.
  const missingClarifyForApp: AppRouteContext = missingClarify
  void [missingClarifyForSqlite, missingClarifyForPostgresql, missingClarifyForApp]

  // @ts-expect-error The Sqlite entry must reject the missing Reads capability.
  const missingReadsForSqlite: SqliteRouteContext = missingReads
  // @ts-expect-error The Postgresql entry must reject the missing Reads capability.
  const missingReadsForPostgresql: PostgresqlRouteContext = missingReads
  // @ts-expect-error The App entry must reject the missing Reads capability.
  const missingReadsForApp: AppRouteContext = missingReads
  void [missingReadsForSqlite, missingReadsForPostgresql, missingReadsForApp]

  const optionalInput: CollaborationCommandContextInput = withO2Closure({ db, ...capabilities })
  const optional = createCollaborationCommandContext({
    ...withO2Closure(optionalInput),
    taskExecutionParticipants,
  })
  const conditional = createCollaborationCommandContext({
    ...withO2Closure(condition ? { db, ...capabilities } : { db }),
    taskExecutionParticipants,
  })
  const undefinedPort = createCollaborationCommandContext({
    ...withO2Closure({
      db,
      ...capabilities,
      reviewDecisions: undefined,
    }),
    taskExecutionParticipants,
  })
  // @ts-expect-error Optional fields do not promise a complete context.
  const optionalFull: CollaborationRouteContext = optional
  // @ts-expect-error A conditional input must guarantee the capability on both branches.
  const conditionalFull: CollaborationRouteContext = conditional
  // @ts-expect-error Explicit undefined is not a review decision port.
  const undefinedReview: ReviewContext = undefinedPort
  void [optionalFull, conditionalFull, undefinedReview]

  const pgFull: CollaborationRouteContext = createCollaborationCommandContext({
    ...withO2Closure({
      db: pgDb,
      ...capabilities,
    }),
    taskExecutionParticipants,
  })
  const pgOptionalInput: PostgresqlCollaborationCommandContextInput = withO2Closure({
    db: pgDb,
    ...capabilities,
  })
  const pgOptional = createCollaborationCommandContext({
    ...withO2Closure(pgOptionalInput),
    taskExecutionParticipants,
  })
  const pgConditional = createCollaborationCommandContext({
    ...withO2Closure(condition ? { db: pgDb, ...capabilities } : { db: pgDb }),
    taskExecutionParticipants,
  })
  const pgUndefined = createCollaborationCommandContext({
    ...withO2Closure({
      db: pgDb,
      ...capabilities,
      reviewDecisions: undefined,
    }),
    taskExecutionParticipants,
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

// RFC-481: the provider runtime neither takes nor hands back collaboration's command context — Task Execution's routes
// never read it (task-execution does not import collaboration). Bootstrap keeps the context it builds, and that complete
// root (`AppRouteContext` above) keeps its explicit contract.
const providerRoutesCarryNoCollaboration: 'collaboration' extends keyof ReturnType<
  TaskExecutionProviderRuntimeDependencies['routes']
>
  ? never
  : true = true
const selectedRuntimeCarriesNoCollaboration: 'collaboration' extends keyof SelectedTaskExecutionProviderRuntime
  ? never
  : true = true
void [providerRoutesCarryNoCollaboration, selectedRuntimeCarriesNoCollaboration]

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
      ...withO2Closure({
        db,
        reviewDecisions: capabilities.reviewDecisions,
      }),
      taskExecutionParticipants,
    })
    const question = createCollaborationCommandContext({
      ...withO2Closure({
        db,
        questionDispatches: capabilities.questionDispatches,
      }),
      taskExecutionParticipants,
    })
    const clarify = createCollaborationCommandContext({
      ...withO2Closure({
        db,
        clarifyDecisions: capabilities.clarifyDecisions,
      }),
      taskExecutionParticipants,
    })
    const reads = createCollaborationCommandContext({
      ...withO2Closure({
        db,
        taskExecutionReadModels: capabilities.taskExecutionReadModels,
      }),
      taskExecutionParticipants,
    })
    const full: CollaborationRouteContext = createCollaborationCommandContext({
      ...withO2Closure({
        db,
        appHome,
        ...capabilities,
      }),
      taskExecutionParticipants,
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
    const { collaborationGateOperations, taskQuestions } = tablesOf(db)
    expect(await db.select().from(collaborationGateOperations)).toEqual([])
    expect(await db.select().from(taskQuestions)).toEqual([])
  })

  test('persistence composition retains the supplied dependency instances in its frozen snapshot', () => {
    const db = harness.db
    const base = createCollaborationCommandContext({
      ...withO2Closure({ db, appHome }),
      taskExecutionParticipants,
    })
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
    input.questionDispatches = createQuestionDispatchCommand(db, o2Ports(db).taskLock, {
      taskExecutionParticipants,
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
    })
    expect(requireQuestionDispatchCommand(context)).toBe(capabilities.questionDispatches)
    expect(context).not.toBe(base)
  })

  test('the base context still writes the manual-question obligation on the same DB', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const context = createCollaborationCommandContext({
      ...withO2Closure({ db }),
      taskExecutionParticipants,
    })
    const created = await createManualQuestionOpen(context, {
      taskId,
      title: 'Investigate this edge case',
      body: 'Re-run the designer with this instruction.',
      targetNodeId: DESIGNER,
      actorUserId: 'u1',
      now: 1_700_000_000_000,
    })
    const { taskQuestions, collaborationGateOperations } = tablesOf(db)
    expect((await readTaskFixtures(db, { id: taskId }))[0]?.status).toBe('awaiting_human')
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
