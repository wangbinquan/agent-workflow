// Committed review bytes come from the target reference columns. The journal
// still controls final/staged recovery and verifies its original byte facts.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, inArray, or } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ContentRef } from '@/platform/content/contentRef'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import {
  createContentStore,
  databaseContentPolicy,
} from '@/platform/content/infrastructure/contentStore'
import { sha256Hex } from '@/util/hash'
import type { CommittedReviewArtifactReader } from '../application/ports/committedReviewArtifactReader'
import type { ReviewArtifactContentPort } from '../application/ports/reviewArtifactContent'
import { HumanGateOperationError } from '../domain/humanGateOperation'

export class DatabaseCommittedReviewArtifactReader implements CommittedReviewArtifactReader {
  constructor(
    private readonly db: PersistenceDb,
    private readonly content: ReviewArtifactContentPort,
    private readonly store: Pick<ContentStore, 'read'> = createContentStore({
      db,
      policy: databaseContentPolicy,
    }),
  ) {}

  async read(reference: string): Promise<string> {
    const { collaborationGateArtifacts, docVersions } = tablesOf(this.db)
    const { collaborationGateOperations } = tablesOf(this.db)
    const missing = () =>
      new HumanGateOperationError(
        'human-gate-artifact-missing',
        `review body not found: ${reference}`,
      )
    const readRef = async (ref: ContentRef): Promise<Uint8Array> => {
      try {
        if (
          ref.kind === 'local-file' &&
          ['review-body', 'review-body-path'].includes(ref.location.codec) &&
          typeof ref.location.value === 'string'
        ) {
          const value = await this.content.read(ref.location.value)
          if (value === null) throw missing()
          if (ref.size !== null && value.body.byteLength !== ref.size)
            throw new Error('content-ref-size-mismatch')
          if (ref.sha256 !== null && sha256Hex(value.body) !== ref.sha256)
            throw new Error('content-ref-digest-mismatch')
          return value.body
        }
        return await this.store.read(ref)
      } catch (error) {
        if (error instanceof Error && /^content-ref-(size|digest)-mismatch$/.test(error.message))
          throw new HumanGateOperationError(
            'human-gate-artifact-digest-mismatch',
            `review content does not match its journal: ${reference}`,
          )
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error instanceof Error &&
            ['content-object-missing', 'content-bytes-missing'].includes(error.message))
        )
          throw missing()
        throw error
      }
    }
    if (reference.startsWith('doc-content:')) {
      const [row] = await this.db
        .select()
        .from(docVersions)
        .where(eq(docVersions.id, reference.slice(12)))
        .limit(1)
      const ref = row && contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
      if (!ref) throw missing()
      try {
        return Buffer.from(await readRef(ref)).toString('utf8')
      } catch (error) {
        if (
          !(error instanceof HumanGateOperationError) ||
          error.code !== 'human-gate-artifact-missing'
        )
          throw error
        const legacyKey =
          ref.kind === 'local-file' &&
          ['review-body', 'review-body-path'].includes(ref.location.codec) &&
          typeof ref.location.value === 'string'
            ? ref.location.value
            : undefined
        const [artifact] = await this.db
          .select({ artifact: collaborationGateArtifacts })
          .from(collaborationGateArtifacts)
          .innerJoin(
            collaborationGateOperations,
            eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
          )
          .where(
            and(
              or(
                eq(collaborationGateArtifacts.contentRefJson, row.contentRefJson!),
                legacyKey === undefined
                  ? undefined
                  : eq(collaborationGateArtifacts.finalContentKey, legacyKey),
              ),
              inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
              inArray(collaborationGateOperations.state, ['committed', 'completed']),
            ),
          )
          .limit(1)
        const staged =
          artifact &&
          contentRefColumns.decode(
            artifact.artifact.stagedContentRefJson,
            artifact.artifact.stagedInlineBytes,
          )
        if (!staged) throw error
        const bytes = await readRef(staged)
        if (
          sha256Hex(bytes) !== artifact.artifact.sha256 ||
          bytes.length !== artifact.artifact.byteSize
        )
          throw new HumanGateOperationError(
            'human-gate-artifact-digest-mismatch',
            'staged review content does not match its journal',
          )
        return Buffer.from(bytes).toString('utf8')
      }
    }
    const [artifact] = await this.db
      .select({ artifact: collaborationGateArtifacts })
      .from(collaborationGateArtifacts)
      .innerJoin(
        collaborationGateOperations,
        eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
      )
      .where(
        and(
          eq(collaborationGateArtifacts.finalContentKey, reference),
          inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
          inArray(collaborationGateOperations.state, ['committed', 'completed']),
        ),
      )
      .limit(1)
    if (artifact) {
      const row = artifact.artifact
      const final = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
      const staged = contentRefColumns.decode(row.stagedContentRefJson, row.stagedInlineBytes)
      let bytes: Uint8Array
      try {
        if (!final) throw missing()
        bytes = await readRef(final)
      } catch (error) {
        if (
          !(error instanceof HumanGateOperationError) ||
          error.code !== 'human-gate-artifact-missing' ||
          !staged
        )
          throw error
        bytes = await readRef(staged)
      }
      if (sha256Hex(bytes) !== row.sha256 || bytes.byteLength !== row.byteSize)
        throw new HumanGateOperationError(
          'human-gate-artifact-digest-mismatch',
          `review content does not match its journal: ${reference}`,
        )
      return Buffer.from(bytes).toString('utf8')
    }
    const value = await this.content.read(reference)
    if (!value) throw missing()
    return Buffer.from(value.body).toString('utf8')
  }
}
