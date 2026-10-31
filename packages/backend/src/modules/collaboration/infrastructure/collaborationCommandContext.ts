import type { CollaborationTaskRolePolicy } from '../application/ports/collaborationTaskRolePolicy'
import type { HumanGateTaskLockPort } from '../composition/required-ports'
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'
import type { ContentStore } from '@/platform/content/contentStore'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ReviewArtifactSelection } from '../application/ports/reviewArtifactSelection'
import { createLocalReviewArtifacts } from './contentReviewArtifacts'
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
import type { CollaborationCommandContext } from '../public/types'
import {
  createCollaborationCommandContextFromPersistence,
  type CollaborationCommandDependencies,
  type ProvidedCollaborationCapabilities,
} from '../application/commandContext'

export type CollaborationCommandContextInput = Omit<
  CollaborationCommandDependencies,
  'persistence' | 'artifacts' | 'taskAccess' | 'reviewTaskAccess'
> & {
  readonly db: PersistenceDb
  readonly taskRolePolicy: CollaborationTaskRolePolicy
  readonly taskLock: HumanGateTaskLockPort
  readonly historyRestrictions: HistoryRestrictionPort
  readonly content?: ContentStore
  readonly appHome?: string
  readonly reviewArtifacts?: ReviewArtifactSelection
}

export type PostgresqlCollaborationCommandContextInput = Omit<
  CollaborationCommandContextInput,
  'db'
> & {
  readonly db: PostgresqlDatabaseClient
}

/**
 * RFC-359 AC-1（plan §5ga）—— 两个 provider 唯一的一份。旁边那个
 * `createPostgresqlCollaborationCommandContext` 的函数体与这里**逐字节相同**，
 * 只差它收的是 `PostgresqlCollaborationCommandContextInput`（= 本输入把 `db` 收窄成
 * `PostgresqlDatabaseClient`）。而 PG 客户端本来就可赋值给 `PersistenceDb`，
 * 所以这一份直接收得下 PG 的输入，品牌那份已退役。
 */
export function createCollaborationCommandContext<I extends CollaborationCommandContextInput>(
  input: I,
): CollaborationCommandContext<ProvidedCollaborationCapabilities<I>>
export function createCollaborationCommandContext(
  input: CollaborationCommandContextInput,
): CollaborationCommandContext {
  const reviewArtifacts =
    input.reviewArtifacts ??
    (input.appHome === undefined || input.content === undefined
      ? undefined
      : createLocalReviewArtifacts({
          db: input.db,
          appHome: input.appHome,
          content: input.content,
        }))
  return createCollaborationCommandContextFromPersistence({
    ...input,
    taskAccess: createCollaborationTaskAccessPort(input.db, input.taskRolePolicy),
    reviewTaskAccess: createReviewTaskAccessPort(input.db, input.taskRolePolicy),
    persistence: {
      operations: new DatabaseHumanGateOperationPersistence(
        databaseSessionFor(input.db),
        new DatabaseHumanGateOperationJournal(input.taskLock, input.historyRestrictions),
      ),
      clarifyQuestions: new DatabaseClarifyQuestionSnapshotReader(input.db),
      manualQuestions: new DatabaseManualQuestionOpenWriter(
        input.db,
        new DatabaseHumanGateOperationJournal(input.taskLock, input.historyRestrictions),
      ),
      reviewers: new DrizzleReviewNodeReviewerStore(input.db),
      feedback: new DrizzleTaskFeedbackStore(input.db),
      clarifyDirectives: createClarifyDirectiveStore(input.db),
      ...(reviewArtifacts === undefined
        ? {}
        : {
            committedArtifacts: new DatabaseCommittedReviewArtifactReader(
              input.db,
              reviewArtifacts.content,
              input.content,
            ),
          }),
    },
    ...(reviewArtifacts === undefined ? {} : { artifacts: reviewArtifacts.store }),
  })
}
