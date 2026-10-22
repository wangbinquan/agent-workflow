import { and, asc, desc, eq, inArray, isNotNull } from 'drizzle-orm'
import { ClarifyAnswerSchema, ClarifyQuestionSchema } from '@agent-workflow/shared'
import { z } from 'zod'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  collaborationGateOperations,
  docVersions,
  nodeRunOutputs,
} from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import type { CollaborationHumanInputQueries } from '../public/types'
import type { CommittedReviewArtifactReader } from '../application/ports/committedReviewArtifactReader'
import { readDocVersionBody, rowToDocVersion } from './review'

export function createCommittedHumanInputQueries(input: {
  readonly db: ProviderNeutralDatabase
  readonly appHome: string
  readonly reviewReader?: CommittedReviewArtifactReader
}): CollaborationHumanInputQueries {
  const { db } = input
  return {
    async clarificationRounds(taskId) {
      const rows = await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.taskId, taskId))
        .orderBy(asc(clarifyRounds.createdAt), asc(clarifyRounds.id))
      return rows.map((row) => ({
        id: row.id,
        taskId: row.taskId,
        askingNodeRunId: row.askingNodeRunId,
        intermediaryNodeRunId: row.intermediaryNodeRunId,
        status: row.status,
        questions: z.array(ClarifyQuestionSchema).parse(JSON.parse(row.questionsJson)),
        answers:
          row.status === 'answered' && row.answersJson !== null
            ? z.array(ClarifyAnswerSchema).parse(JSON.parse(row.answersJson))
            : [],
      }))
    },
    async reviewDecision(taskId, nodeRunId) {
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
        .orderBy(desc(collaborationGateOperations.resultGateRevision))
        .limit(1)
      const operation = operations[0]
      if (!operation) return null
      const rows = await db
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.taskId, taskId), eq(docVersions.reviewNodeRunId, nodeRunId)))
        .orderBy(desc(docVersions.versionIndex))
      const output = (
        await db
          .select()
          .from(nodeRunOutputs)
          .where(
            and(
              eq(nodeRunOutputs.nodeRunId, nodeRunId),
              eq(nodeRunOutputs.portName, 'decision_meta'),
              eq(nodeRunOutputs.active, true),
            ),
          )
          .limit(1)
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
          const digest = sha256Hex(
            await readDocVersionBody(db, input.appHome, rowToDocVersion(row), input.reviewReader),
          )
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
          round.map(async (row) =>
            sha256Hex(
              await readDocVersionBody(db, input.appHome, rowToDocVersion(row), input.reviewReader),
            ),
          ),
        ),
      }
    },
  }
}
