// RFC-333 — composition-owned dependencies for exact collaboration commands.
// Public callers carry only an opaque object reference; the live DB and app
// home never become part of a public command/query contract.

import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CollaborationCommandContext, CollaborationRouteContext } from '../public/types'
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
import { DatabaseClarifyQuestionSnapshotReader } from '../infrastructure/clarifyQuestionSnapshotReader'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { DatabaseHumanGateOperationPersistence } from '../infrastructure/humanGateOperationPersistence'
import { DatabaseManualQuestionOpenWriter } from '../infrastructure/manualQuestionOpenWriter'
import { DatabaseHumanGateOperationJournal } from '../infrastructure/humanGateOperationJournal'
import { DatabaseCommittedReviewArtifactReader } from '../infrastructure/committedReviewArtifactReader'
import { DrizzleReviewNodeReviewerStore } from '../infrastructure/reviewNodeReviewerStore'
import { createReviewTaskAccessPort } from '../infrastructure/reviewTaskAccess'
import { DrizzleTaskFeedbackStore } from '../infrastructure/taskFeedbackStore'
import { createCollaborationTaskAccessPort } from '../infrastructure/collaborationTaskAccess'
import { createClarifyDirectiveStore } from '../infrastructure/clarifyDirectiveStore'

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
  // RFC-359 W5-T19b：评审任务访问端口**不是**装配选项——两个工厂都从同一个 `db` 现造
  // （`createReviewTaskAccessPort(input.db)`），全仓从来没有第二个来源、也没有任何调用方
  // 传过它。留成 `?:` 只是让「没装配」在类型层仍然可表达，代价是两处 `is not composed`
  // 的运行期兜底（其中一处还在 `reviewNodeReviewerDependencies.ts` 里被逐字抄了一遍）。
  // 改必填后缺口无处可表达，那两句兜底随之删除。
  readonly reviewTaskAccess: ReviewTaskAccessPort
}

const dependencies = new WeakMap<object, CollaborationCommandDependencies>()

type CollaborationContextCapability =
  CollaborationRouteContext extends CollaborationCommandContext<infer C> ? C : never

type CollaborationCapabilityDependencies = Required<
  Pick<CollaborationCommandDependencies, CollaborationContextCapability>
>

// A union or optional input only guarantees a capability if every branch supplies it.
type ProvidedCollaborationCapabilities<I> = {
  [K in CollaborationContextCapability]: [I] extends [Pick<CollaborationCapabilityDependencies, K>]
    ? K
    : never
}[CollaborationContextCapability]

export type CollaborationCommandContextInput = Omit<
  CollaborationCommandDependencies,
  'persistence' | 'artifacts' | 'taskAccess' | 'reviewTaskAccess'
> & {
  readonly db: ProviderNeutralDatabase
  readonly appHome?: string
}

export type PostgresqlCollaborationCommandContextInput = Omit<
  CollaborationCommandContextInput,
  'db'
> & {
  readonly db: PostgresqlDatabaseClient
}

export function createCollaborationCommandContext<I extends CollaborationCommandContextInput>(
  input: I,
): CollaborationCommandContext<ProvidedCollaborationCapabilities<I>>
export function createCollaborationCommandContext(
  input: CollaborationCommandContextInput,
): CollaborationCommandContext {
  return createCollaborationCommandContextFromPersistence({
    ...input,
    taskAccess: createCollaborationTaskAccessPort(input.db),
    reviewTaskAccess: createReviewTaskAccessPort(input.db),
    persistence: {
      operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(input.db)),
      clarifyQuestions: new DatabaseClarifyQuestionSnapshotReader(input.db),
      manualQuestions: new DatabaseManualQuestionOpenWriter(
        input.db,
        new DatabaseHumanGateOperationJournal(),
      ),
      reviewers: new DrizzleReviewNodeReviewerStore(input.db),
      feedback: new DrizzleTaskFeedbackStore(input.db),
      clarifyDirectives: createClarifyDirectiveStore(input.db),
      ...(input.appHome === undefined
        ? {}
        : {
            committedArtifacts: new DatabaseCommittedReviewArtifactReader(input.db, input.appHome),
          }),
    },
    ...(input.appHome === undefined
      ? {}
      : { artifacts: new FsHumanGateArtifactStore(input.appHome) }),
  })
}

export function createPostgresqlCollaborationCommandContext<
  I extends PostgresqlCollaborationCommandContextInput,
>(input: I): CollaborationCommandContext<ProvidedCollaborationCapabilities<I>>
export function createPostgresqlCollaborationCommandContext(
  input: PostgresqlCollaborationCommandContextInput,
): CollaborationCommandContext {
  return createCollaborationCommandContextFromPersistence({
    ...input,
    taskAccess: createCollaborationTaskAccessPort(input.db),
    reviewTaskAccess: createReviewTaskAccessPort(input.db),
    persistence: {
      operations: new DatabaseHumanGateOperationPersistence(databaseSessionFor(input.db)),
      clarifyQuestions: new DatabaseClarifyQuestionSnapshotReader(input.db),
      manualQuestions: new DatabaseManualQuestionOpenWriter(
        input.db,
        new DatabaseHumanGateOperationJournal(),
      ),
      reviewers: new DrizzleReviewNodeReviewerStore(input.db),
      feedback: new DrizzleTaskFeedbackStore(input.db),
      clarifyDirectives: createClarifyDirectiveStore(input.db),
      ...(input.appHome === undefined
        ? {}
        : {
            committedArtifacts: new DatabaseCommittedReviewArtifactReader(input.db, input.appHome),
          }),
    },
    ...(input.appHome === undefined
      ? {}
      : { artifacts: new FsHumanGateArtifactStore(input.appHome) }),
  })
}

export function createCollaborationCommandContextFromPersistence<
  I extends CollaborationCommandDependencies,
>(input: I): CollaborationCommandContext<ProvidedCollaborationCapabilities<I>>
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
  context: CollaborationCommandContext<'reviewDecisions'>,
): ReviewDecisionCommandPort {
  const command = resolveCollaborationCommandContext(context).reviewDecisions
  if (command === undefined)
    throw new Error('collaboration review decision command is not composed')
  return command
}

export function requireQuestionDispatchCommand(
  context: CollaborationCommandContext<'questionDispatches'>,
): QuestionDispatchCommandPort {
  const command = resolveCollaborationCommandContext(context).questionDispatches
  if (command === undefined)
    throw new Error('collaboration question dispatch command is not composed')
  return command
}

export function requireClarifyDecisionCommand(
  context: CollaborationCommandContext<'clarifyDecisions'>,
): ClarifyDecisionCommandPort {
  const command = resolveCollaborationCommandContext(context).clarifyDecisions
  if (command === undefined)
    throw new Error('collaboration clarify decision command is not composed')
  return command
}

export function requireCollaborationTaskExecutionReadModels(
  context: CollaborationCommandContext<'taskExecutionReadModels'>,
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
  return resolveCollaborationCommandContext(context).reviewTaskAccess
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
