import { contentRefColumns } from '@/platform/content/contentStore'
import {
  createContentStore,
  databaseContentPolicy,
  contentReadTransport,
  contentRefOf,
  hostedObjectOf,
  hostedContentColumnsInTx,
} from '@/platform/content/infrastructure/contentStore'
// RFC-370 v3 V6 — hosted review documents. Each staged document is one
// `collaboration-review` publication (key = operation/artifact, scope = task
// id); the gate journal keeps the receipt and stays the only publication and
// recovery authority. Cleanup of an unconsumed document is an owner release;
// whether its upload ever completed is settled by object maintenance.
import { reviewTask } from '@/platform/content/locations/review'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { HostedObjectPublications } from '@/modules/system-operations/public/participants'
import type {
  CrewStationStreamObjectStorage,
  HostedStoredObject,
} from '@/platform/crewstation/objectStorage'
import { sha256Hex } from '@/util/hash'
import type { HumanGateArtifactSnapshot } from '../../application/ports/humanGateOperationStore'
import type { ReviewArtifactSelection } from '../../application/ports/reviewArtifactSelection'
import { planReviewArtifact } from '../../application/reviewArtifactPlan'
import { HumanGateOperationError } from '../../domain/humanGateOperation'

export const HOSTED_REVIEW_OWNER = 'collaboration-review'

const Receipt = z
  .object({
    kind: z.literal('cs-review-object-v2'),
    operationId: z.string(),
    artifactKey: z.string(),
    stagedPath: z.string(),
    finalPath: z.string(),
    key: z.string(),
    object: z.object({
      id: z.guid({ error: 'Invalid uuid' }).meta({ format: 'uuid' }),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      size: z.number().int().nonnegative(),
    }),
  })
  .strict()

/** The publication key of one declared review document. */
export const hostedReviewPublicationKey = (artifact: {
  operationId: string
  artifactKey: string
}) => `${artifact.operationId}/${sha256Hex(artifact.artifactKey)}`
const keyFor = hostedReviewPublicationKey
const taskOf = reviewTask

function receiptFor(artifact: HumanGateArtifactSnapshot) {
  const receipt = Receipt.parse(JSON.parse(artifact.receiptJson ?? 'null'))
  if (
    receipt.operationId !== artifact.operationId ||
    receipt.artifactKey !== artifact.artifactKey ||
    receipt.finalPath !== artifact.finalPath ||
    receipt.key !== keyFor(artifact) ||
    receipt.object.sha256 !== artifact.sha256 ||
    receipt.object.size !== artifact.byteSize
  )
    throw new HumanGateOperationError(
      'human-gate-artifact-digest-mismatch',
      'review object receipt does not match its journal',
    )
  return receipt
}

export function createHostedReviewArtifacts(input: {
  readonly db: PersistenceDb
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly publications: HostedObjectPublications
}): ReviewArtifactSelection & {
  archiveFiles(
    taskId: string,
  ): Promise<readonly { reference: string; object: HostedStoredObject }[]>
} {
  const content = createContentStore({
    db: input.db,
    policy: databaseContentPolicy,
    transports: {
      object: contentReadTransport(
        async (ref) =>
          new Uint8Array(
            await new Response(await input.objects.open(hostedObjectOf(ref))).arrayBuffer(),
          ),
      ),
    },
  })
  const read = async (artifact: HumanGateArtifactSnapshot) => {
    const receipt = receiptFor(artifact)
    const stream = await input.objects.open(receipt.object)
    return {
      body: new Uint8Array(await new Response(stream).arrayBuffer()),
      label: `cs-object:${receipt.object.id}`,
    }
  }
  return {
    async archiveFiles(taskId) {
      const { collaborationGateOperations } = tablesOf(input.db)
      const { collaborationGateArtifacts } = tablesOf(input.db)
      const rows = await input.db
        .select({ artifact: collaborationGateArtifacts })
        .from(collaborationGateArtifacts)
        .innerJoin(
          collaborationGateOperations,
          eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
        )
        .where(
          and(
            eq(collaborationGateOperations.taskId, taskId),
            inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
            inArray(collaborationGateOperations.state, ['committed', 'completed']),
          ),
        )
      return rows.map(({ artifact }) => {
        const object = hostedObjectOf(contentRefOf(artifact))
        if (!artifact.finalContentKey.startsWith(`runs/${taskId}/`))
          throw new Error('hosted-review-archive-owner-mismatch')
        return { reference: artifact.finalContentKey, object }
      })
    },
    store: {
      planReviewArtifact(plan) {
        return {
          ...planReviewArtifact(plan),
          stagedPath: `gate-stage:${plan.operationId}:${plan.artifactKey}`,
        }
      },
      async stageReviewArtifact(plan, body) {
        const bytes = Buffer.from(body, 'utf8')
        if (sha256Hex(bytes) !== plan.sha256 || bytes.byteLength !== plan.byteSize)
          throw new HumanGateOperationError(
            'human-gate-artifact-digest-mismatch',
            'review body changed after planning',
          )
        const key = keyFor(plan)
        const [object] = await input.publications.publish(
          [{ owner: HOSTED_REVIEW_OWNER, key, scope: taskOf(plan.finalPath), bytes }],
          {
            async commit(tx, [object]) {
              const { collaborationGateArtifacts } = tablesOf(tx)
              const columns = await hostedContentColumnsInTx(tx, object!)
              await tx
                .update(collaborationGateArtifacts)
                .set({
                  ...columns,
                  stagedContentRefJson: columns.contentRefJson,
                  stagedInlineBytes: columns.contentInlineBytes,
                })
                .where(
                  and(
                    eq(collaborationGateArtifacts.operationId, plan.operationId),
                    eq(collaborationGateArtifacts.artifactKey, plan.artifactKey),
                  ),
                )
            },
          },
        )
        return JSON.stringify({
          kind: 'cs-review-object-v2',
          operationId: plan.operationId,
          artifactKey: plan.artifactKey,
          stagedPath: plan.stagedPath,
          finalPath: plan.finalPath,
          key,
          object: { id: object!.id, sha256: object!.sha256, size: object!.size },
        })
      },
      async finalizeReviewArtifact(artifact) {
        // Drain and verify the persisted bytes before acknowledging recovery.
        await read(artifact)
        return JSON.stringify(receiptFor(artifact))
      },
      async cleanupReviewArtifact(artifact) {
        if (artifact.state === 'consumed' || artifact.state === 'finalized')
          throw new Error('hosted-review-committed-artifact-cleanup-refused')
        // Without a receipt the upload may or may not have completed; the
        // journal's release covers both and maintenance settles the pin.
        await input.publications.release({ owner: HOSTED_REVIEW_OWNER, keys: [keyFor(artifact)] })
      },
    },
    content: {
      async read(reference) {
        if (reference.startsWith('doc-content:')) {
          const { docVersions } = tablesOf(input.db)
          const [row] = await input.db
            .select()
            .from(docVersions)
            .where(eq(docVersions.id, reference.slice(12)))
            .limit(1)
          return row ? { body: await content.read(contentRefOf(row)), label: reference } : null
        }
        const { collaborationGateOperations } = tablesOf(input.db)
        const { collaborationGateArtifacts } = tablesOf(input.db)
        const rows = await input.db
          .select({ artifact: collaborationGateArtifacts })
          .from(collaborationGateArtifacts)
          .innerJoin(
            collaborationGateOperations,
            eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
          )
          .where(
            and(
              or(
                eq(collaborationGateArtifacts.finalContentKey, reference),
                eq(
                  sql<string>`'gate-stage:' || ${collaborationGateArtifacts.operationId} || ':' || ${collaborationGateArtifacts.artifactKey}`,
                  reference,
                ),
              ),
              inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
              inArray(collaborationGateOperations.state, ['committed', 'completed']),
            ),
          )
          .limit(2)
        if (rows.length > 1) throw new Error('hosted-review-artifact-reference-ambiguous')
        const artifact = rows[0]?.artifact
        if (!artifact) return null
        const ref =
          reference === artifact.finalContentKey
            ? contentRefOf(artifact)
            : contentRefColumns.decode(artifact.stagedContentRefJson, artifact.stagedInlineBytes)
        return ref ? { body: await content.read(ref), label: reference } : null
      },
    },
  }
}
