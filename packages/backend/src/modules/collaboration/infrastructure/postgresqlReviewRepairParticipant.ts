import { and, eq } from 'drizzle-orm'

import { docVersions, nodeRunOutputs } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  ReviewRepairInspection,
  ReviewRepairParticipant,
} from '../application/ports/reviewRepairParticipant'

type ReviewIdentity = Parameters<ReviewRepairParticipant['inspect']>[0]
type PostgresqlReviewTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]
type PostgresqlReviewDatabase = PostgresqlDatabaseClient | PostgresqlReviewTransaction

async function loadInspection(
  db: PostgresqlReviewDatabase,
  input: ReviewIdentity,
): Promise<ReviewRepairInspection | null> {
  const row = (
    await db
      .select({
        decision: docVersions.decision,
        versionIndex: docVersions.versionIndex,
        reviewIteration: docVersions.reviewIteration,
        sourceFilePath: docVersions.sourceFilePath,
      })
      .from(docVersions)
      .where(
        and(
          eq(docVersions.id, input.docVersionId),
          eq(docVersions.taskId, input.taskId),
          eq(docVersions.reviewNodeRunId, input.nodeRunId),
        ),
      )
      .limit(1)
  )[0]
  if (row === undefined) return null
  const outputs = await db
    .select({ portName: nodeRunOutputs.portName })
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, input.nodeRunId))
  return {
    ...row,
    hasApprovedDocOutput: outputs.some(({ portName }) => portName === 'approved_doc'),
    hasApprovalMetaOutput: outputs.some(({ portName }) => portName === 'approval_meta'),
  }
}

function approvedDocContent(input: ReviewIdentity, sourceFilePath: string | null): string {
  return sourceFilePath !== null && sourceFilePath.trim().length > 0
    ? sourceFilePath
    : `__rfc057_manual_repair__:doc_version=${input.docVersionId}`
}

export function createPostgresqlReviewRepairParticipant(
  db: PostgresqlDatabaseClient,
): ReviewRepairParticipant {
  return Object.freeze({
    async inspect(input: Parameters<ReviewRepairParticipant['inspect']>[0]) {
      return await loadInspection(db, input)
    },
    async completeApproved(input: Parameters<ReviewRepairParticipant['completeApproved']>[0]) {
      return await db.transaction(async (transaction) => {
        const state = await loadInspection(transaction, input)
        if (state === null || state.decision !== 'approved') return false
        const content = approvedDocContent(input, state.sourceFilePath)
        const metadata = JSON.stringify({
          decision: 'approved',
          decidedAt: input.occurredAt,
          decidedBy: 'rfc057-repair',
          reviewIteration: state.reviewIteration,
          versionIndex: state.versionIndex,
        })
        await transaction
          .insert(nodeRunOutputs)
          .values({ nodeRunId: input.nodeRunId, portName: 'approved_doc', content })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content },
          })
        await transaction
          .insert(nodeRunOutputs)
          .values({ nodeRunId: input.nodeRunId, portName: 'approval_meta', content: metadata })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content: metadata },
          })
        return true
      })
    },
    async unapprove(input: Parameters<ReviewRepairParticipant['unapprove']>[0]) {
      const changed = await db
        .update(docVersions)
        .set({ decision: 'pending', decidedAt: null, decidedBy: null })
        .where(
          and(
            eq(docVersions.id, input.docVersionId),
            eq(docVersions.taskId, input.taskId),
            eq(docVersions.reviewNodeRunId, input.nodeRunId),
            eq(docVersions.decision, 'approved'),
          ),
        )
        .returning({ id: docVersions.id })
      return changed.length === 1
    },
  })
}
