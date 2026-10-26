import { createNodeOutputQueries } from '@/modules/task-execution/public/queries'
import { readClarifyAnswerProjection } from './clarifyAnswerQueries'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { ClarifyAnswerSchema, ClarifyQuestionSchema } from '@agent-workflow/shared'
import { z } from 'zod'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import type { CollaborationHumanInputQueries } from '../public/types'
import type { ContentStore } from '@/platform/content/contentStore'
import { readCommittedReviewDocumentContent } from './humanGateOperationJournal'

export function createCommittedHumanInputQueries(input: {
  readonly db: PersistenceDb
  readonly content: Pick<ContentStore, 'read'>
}): CollaborationHumanInputQueries {
  const { db } = input
  const readBody = async (row: {
    contentRefJson: string
    contentInlineBytes: Uint8Array | null
  }) => {
    return Buffer.from(await readCommittedReviewDocumentContent(db, input.content, row)).toString(
      'utf8',
    )
  }
  return {
    async clarificationRounds(taskId) {
      const { clarifyRounds } = tablesOf(db)
      const rows = await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.taskId, taskId))
        .orderBy(asc(clarifyRounds.createdAt), asc(clarifyRounds.id))
      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          taskId: row.taskId,
          askingNodeRunId: row.askingNodeRunId,
          intermediaryNodeRunId: row.intermediaryNodeRunId,
          status: row.status,
          questions: z.array(ClarifyQuestionSchema).parse(JSON.parse(row.questionsJson)),
          answers:
            row.status === 'answered' && (row.answersRecorded || row.legacyAnswersJson !== null)
              ? z
                  .array(ClarifyAnswerSchema)
                  .parse((await readClarifyAnswerProjection(db, row)).requireAnswers())
              : [],
        })),
      )
    },
    async reviewDecision(taskId, nodeRunId) {
      const { collaborationGateOperations } = tablesOf(db)
      const { docVersions } = tablesOf(db)
      const operations = await db
        .select()
        .from(collaborationGateOperations)
        .where(
          and(
            eq(collaborationGateOperations.taskId, taskId),
            eq(collaborationGateOperations.gateKind, 'review'),
            eq(collaborationGateOperations.gateRef, `review:${nodeRunId}`),
            eq(collaborationGateOperations.operationKind, 'decide'),
            isNotNull(collaborationGateOperations.receiptJson),
            inArray(collaborationGateOperations.state, [
              'committed',
              'cleanup_pending',
              'completed',
            ]),
          ),
        )
        .orderBy(engineOf(db).descNullsLast(collaborationGateOperations.resultGateRevision))
        .limit(1)
      const operation = operations[0]
      if (!operation) return null
      const rows = await db
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.taskId, taskId), eq(docVersions.reviewNodeRunId, nodeRunId)))
        .orderBy(desc(docVersions.versionIndex))
      const output = (
        await createNodeOutputQueries(db)
          .readPort(nodeRunId, 'decision_meta', true)
          .then((output) => (output === null ? [] : [output]))
      )[0]
      if (output) {
        const metadata = z
          .object({
            receiptId: z.string(),
            decision: z.enum(['approved', 'rejected', 'iterated']),
            decidedAt: z.number(),
            reason: z.string(),
            documents: z
              .array(
                z.object({ docVersionId: z.string(), contentDigest: z.string() }).passthrough(),
              )
              .min(1),
          })
          .passthrough()
          .parse(JSON.parse(output.content))
        if (metadata.receiptId !== operation.id) return null
        const digests: string[] = []
        for (const entry of metadata.documents) {
          const row = rows.find((row) => row.id === entry.docVersionId)
          if (!row || row.decision !== metadata.decision) return null
          const digest = sha256Hex(await readBody(row))
          if (digest !== entry.contentDigest) return null
          digests.push(digest)
        }
        return {
          receiptId: operation.id,
          taskId,
          nodeRunId,
          decision: metadata.decision,
          decidedAt: metadata.decidedAt,
          reason: metadata.reason,
          documentDigests: digests,
        }
      }
      const latest = rows[0]
      if (
        !latest ||
        !['approved', 'rejected', 'iterated'].includes(latest.decision) ||
        latest.decidedAt === null
      )
        return null
      const round = rows.filter(
        (row) => row.versionIndex === latest.versionIndex && row.decidedAt === latest.decidedAt,
      )
      return {
        receiptId: operation.id,
        taskId,
        nodeRunId,
        decision: latest.decision as 'approved' | 'rejected' | 'iterated',
        decidedAt: latest.decidedAt,
        reason: round
          .map((row) => row.decisionReason)
          .filter(Boolean)
          .join('\n\n'),
        documentDigests: await Promise.all(
          round.map(async (row) => sha256Hex(await readBody(row))),
        ),
      }
    },
  }
}
