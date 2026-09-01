// RFC-333 — composition-owned dependencies for exact collaboration commands.
// Public callers carry only an opaque object reference; the live DB and app
// home never become part of a public command/query contract.

import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CollaborationCommandContext } from '../public/types'
import type { ReviewDecisionCommandPort } from '../application/ports/reviewDecisionCommand'
import type { QuestionDispatchCommandPort } from '../application/ports/questionDispatchCommand'
import type { ClarifyDecisionCommandPort } from '../application/ports/clarifyDecisionCommand'
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'
import type { HumanGateOperationStore } from '../application/ports/humanGateOperationStore'
import type { ClarifyQuestionSnapshotReader } from '../application/ports/clarifyQuestionSnapshotReader'
import type { HumanGateArtifactStore } from '../application/ports/humanGateArtifactStore'
import type { ManualQuestionOpenWriter } from '../application/ports/manualQuestionOpenWriter'
import type { CommittedReviewArtifactReader } from '../application/ports/committedReviewArtifactReader'
import type { ReviewNodeReviewerStore } from '../application/ports/reviewNodeReviewerStore'
import type { ReviewTaskAccessPort } from '../application/ports/reviewTaskAccess'
import type { TaskFeedbackStore } from '../application/ports/taskFeedbackStore'
import type { CollaborationTaskAccessPort } from '../application/ports/collaborationTaskAccess'
import type { ClarifyDirectiveStore } from '../application/ports/clarifyDirectiveStore'
import { FsHumanGateArtifactStore } from '../infrastructure/fsHumanGateArtifactStore'
import { SqliteClarifyQuestionSnapshotReader } from '../infrastructure/sqliteClarifyQuestionSnapshotReader'
import { SqliteHumanGateOperationPersistence } from '../infrastructure/sqliteHumanGateOperationPersistence'
import { SqliteHumanGateOperationStore } from '../infrastructure/sqliteHumanGateOperationStore'
import { SqliteManualQuestionOpenWriter } from '../infrastructure/sqliteManualQuestionOpenWriter'
import { SqliteCommittedReviewArtifactReader } from '../infrastructure/sqliteCommittedReviewArtifactReader'
import { SqliteReviewNodeReviewerStore } from '../infrastructure/sqliteReviewNodeReviewerStore'
import { createSqliteReviewTaskAccessPort } from '../infrastructure/sqliteReviewTaskAccess'
import { SqliteTaskFeedbackStore } from '../infrastructure/sqliteTaskFeedbackStore'
import { PostgresqlClarifyQuestionSnapshotReader } from '../infrastructure/postgresqlClarifyQuestionSnapshotReader'
import { PostgresqlCommittedReviewArtifactReader } from '../infrastructure/postgresqlCommittedReviewArtifactReader'
import { PostgresqlHumanGateOperationPersistence } from '../infrastructure/postgresqlHumanGateOperationPersistence'
import { PostgresqlManualQuestionOpenWriter } from '../infrastructure/postgresqlManualQuestionOpenWriter'
import { PostgresqlReviewNodeReviewerStore } from '../infrastructure/postgresqlReviewNodeReviewerStore'
import { createPostgresqlReviewTaskAccessPort } from '../infrastructure/postgresqlReviewTaskAccess'
import { PostgresqlTaskFeedbackStore } from '../infrastructure/postgresqlTaskFeedbackStore'
import { createSqliteCollaborationTaskAccessPort } from '../infrastructure/sqliteCollaborationTaskAccess'
import { createPostgresqlCollaborationTaskAccessPort } from '../infrastructure/postgresqlCollaborationTaskAccess'
import { createSqliteClarifyDirectiveStore } from '../infrastructure/sqliteClarifyDirectiveStore'
import { createPostgresqlClarifyDirectiveStore } from '../infrastructure/postgresqlClarifyDirectiveStore'

export interface CollaborationPersistence {
  readonly operations: HumanGateOperationStore
  readonly clarifyQuestions: ClarifyQuestionSnapshotReader
  readonly manualQuestions: ManualQuestionOpenWriter
  readonly committedArtifacts?: CommittedReviewArtifactReader
  readonly reviewers: ReviewNodeReviewerStore
  readonly feedback: TaskFeedbackStore
  readonly clarifyDirectives: ClarifyDirectiveStore
}

export interface CollaborationCommandDependencies {
  readonly persistence: CollaborationPersistence
  readonly taskAccess: CollaborationTaskAccessPort
  readonly artifacts?: HumanGateArtifactStore
  readonly reviewDecisions?: ReviewDecisionCommandPort
  readonly questionDispatches?: QuestionDispatchCommandPort
  readonly clarifyDecisions?: ClarifyDecisionCommandPort
  readonly taskExecutionReadModels?: TaskExecutionReadModels
  readonly reviewTaskAccess?: ReviewTaskAccessPort
}

const dependencies = new WeakMap<object, CollaborationCommandDependencies>()

export function createCollaborationCommandContext(
  input: Omit<CollaborationCommandDependencies, 'persistence' | 'artifacts' | 'taskAccess'> & {
    readonly db: DbClient
    readonly appHome?: string
  },
): CollaborationCommandContext {
  const operationTransactions = new SqliteHumanGateOperationStore()
  return createCollaborationCommandContextFromPersistence({
    ...input,
    taskAccess: createSqliteCollaborationTaskAccessPort(input.db),
    reviewTaskAccess: input.reviewTaskAccess ?? createSqliteReviewTaskAccessPort(input.db),
    persistence: {
      operations: new SqliteHumanGateOperationPersistence(input.db),
      clarifyQuestions: new SqliteClarifyQuestionSnapshotReader(input.db),
      manualQuestions: new SqliteManualQuestionOpenWriter(input.db, operationTransactions),
      reviewers: new SqliteReviewNodeReviewerStore(input.db),
      feedback: new SqliteTaskFeedbackStore(input.db),
      clarifyDirectives: createSqliteClarifyDirectiveStore(input.db),
      ...(input.appHome === undefined
        ? {}
        : { committedArtifacts: new SqliteCommittedReviewArtifactReader(input.db, input.appHome) }),
    },
    ...(input.appHome === undefined
      ? {}
      : { artifacts: new FsHumanGateArtifactStore(input.appHome) }),
  })
}

export function createPostgresqlCollaborationCommandContext(
  input: Omit<CollaborationCommandDependencies, 'persistence' | 'artifacts' | 'taskAccess'> & {
    readonly db: PostgresqlDatabaseClient
    readonly appHome?: string
  },
): CollaborationCommandContext {
  return createCollaborationCommandContextFromPersistence({
    ...input,
    taskAccess: createPostgresqlCollaborationTaskAccessPort(input.db),
    reviewTaskAccess: input.reviewTaskAccess ?? createPostgresqlReviewTaskAccessPort(input.db),
    persistence: {
      operations: new PostgresqlHumanGateOperationPersistence(input.db),
      clarifyQuestions: new PostgresqlClarifyQuestionSnapshotReader(input.db),
      manualQuestions: new PostgresqlManualQuestionOpenWriter(input.db),
      reviewers: new PostgresqlReviewNodeReviewerStore(input.db),
      feedback: new PostgresqlTaskFeedbackStore(input.db),
      clarifyDirectives: createPostgresqlClarifyDirectiveStore(input.db),
      ...(input.appHome === undefined
        ? {}
        : {
            committedArtifacts: new PostgresqlCommittedReviewArtifactReader(
              input.db,
              input.appHome,
            ),
          }),
    },
    ...(input.appHome === undefined
      ? {}
      : { artifacts: new FsHumanGateArtifactStore(input.appHome) }),
  })
}

export function createCollaborationCommandContextFromPersistence(
  input: CollaborationCommandDependencies,
): CollaborationCommandContext {
  const context = Object.freeze({})
  dependencies.set(context, Object.freeze({ ...input }))
  return context as CollaborationCommandContext
}

export function resolveCollaborationCommandContext(
  context: CollaborationCommandContext,
): CollaborationCommandDependencies {
  const resolved = dependencies.get(context)
  if (resolved === undefined) throw new Error('collaboration command context is not composed')
  return resolved
}

export function requireHumanGateArtifactStore(
  context: CollaborationCommandContext,
): HumanGateArtifactStore {
  const artifacts = resolveCollaborationCommandContext(context).artifacts
  if (artifacts === undefined)
    throw new Error('collaboration command context has no artifact store')
  return artifacts
}

export function requireCommittedReviewArtifactReader(
  context: CollaborationCommandContext,
): CommittedReviewArtifactReader {
  const reader = resolveCollaborationCommandContext(context).persistence.committedArtifacts
  if (reader === undefined) {
    throw new Error('collaboration command context has no committed artifact reader')
  }
  return reader
}

export function requireReviewDecisionCommand(
  context: CollaborationCommandContext,
): ReviewDecisionCommandPort {
  const command = resolveCollaborationCommandContext(context).reviewDecisions
  if (command === undefined)
    throw new Error('collaboration review decision command is not composed')
  return command
}

export function requireQuestionDispatchCommand(
  context: CollaborationCommandContext,
): QuestionDispatchCommandPort {
  const command = resolveCollaborationCommandContext(context).questionDispatches
  if (command === undefined)
    throw new Error('collaboration question dispatch command is not composed')
  return command
}

export function requireClarifyDecisionCommand(
  context: CollaborationCommandContext,
): ClarifyDecisionCommandPort {
  const command = resolveCollaborationCommandContext(context).clarifyDecisions
  if (command === undefined)
    throw new Error('collaboration clarify decision command is not composed')
  return command
}

export function requireCollaborationTaskExecutionReadModels(
  context: CollaborationCommandContext,
): TaskExecutionReadModels {
  const readModels = resolveCollaborationCommandContext(context).taskExecutionReadModels
  if (readModels === undefined) {
    throw new Error('collaboration task-execution read models are not composed')
  }
  return readModels
}

export function requireTaskFeedbackStore(context: CollaborationCommandContext): TaskFeedbackStore {
  return resolveCollaborationCommandContext(context).persistence.feedback
}

export function requireReviewTaskAccess(
  context: CollaborationCommandContext,
): ReviewTaskAccessPort {
  const taskAccess = resolveCollaborationCommandContext(context).reviewTaskAccess
  if (taskAccess === undefined) throw new Error('collaboration task access is not composed')
  return taskAccess
}

export function requireCollaborationTaskAccess(
  context: CollaborationCommandContext,
): CollaborationTaskAccessPort {
  return resolveCollaborationCommandContext(context).taskAccess
}

export function requireClarifyDirectiveStore(
  context: CollaborationCommandContext,
): ClarifyDirectiveStore {
  return resolveCollaborationCommandContext(context).persistence.clarifyDirectives
}
