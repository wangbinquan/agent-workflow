// RFC-395 C-F2 follow-up: doc-content fallback accepts legacy metadata gaps,
// preserves committed-operation eligibility and maps missing object content.
import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { legacyContentRef, type ContentRef } from '@/platform/content/contentRef'
import { contentRefColumns, type ContentStore } from '@/platform/content/contentStore'
import {
  contentRowColumns,
  createContentStore,
  databaseContentPolicy,
} from '@/platform/content/infrastructure/contentStore'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider } from './helpers/eachProvider'
import { workflowFixture, taskFixture, nodeRunFixture } from './helpers/model'

const body = Buffer.from('\ufeff中文\r\n')
const metadata = { sha256: sha256Hex(body), size: body.byteLength }

describeEachProvider('RFC-395 committed review fallback follow-up', (h) => {
  async function seed(input: {
    document: ContentRef
    final: ContentRef
    staged: ContentRef
    finalKey: string
    operationState?: 'committed' | 'completed' | 'prepared'
    artifactState?: 'consumed' | 'finalized' | 'staged'
  }) {
    const taskId = randomUUID(),
      runId = randomUUID(),
      operationId = randomUUID(),
      docId = randomUUID()
    const definition = { $schema_version: 7, nodes: [], edges: [], inputs: [], outputs: [] }
    await workflowFixture(h.db, { id: taskId, name: taskId, definition, schemaVersion: 7 })
    await taskFixture(h.db, {
      id: taskId,
      workflowId: taskId,
      workflowSnapshot: definition,
      status: 'running',
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'main',
      inputs: {},
      startedAt: 1,
    })
    await nodeRunFixture(h.db, { id: runId, taskId, nodeId: 'review', status: 'awaiting_review' })
    const { collaborationGateOperations } = tablesOf(h.db)
    const { collaborationGateArtifacts, docVersions } = tablesOf(h.db)
    await h.db.insert(collaborationGateOperations).values({
      id: operationId,
      taskId,
      gateKind: 'review',
      operationKind: 'open',
      gateRef: `review:${runId}`,
      idempotencyKey: operationId,
      requestHash: 'legacy-review',
      expectedTaskRevision: 0,
      expectedGateRevision: 0,
      state: input.operationState ?? 'committed',
      ...((input.operationState ?? 'committed') === 'prepared'
        ? {}
        : {
            receiptJson: JSON.stringify({
              kind: 'review',
              version: 1,
              taskId,
              reviewNodeRunId: runId,
              docVersionIds: [docId],
            }),
            resultGateRevision: 1,
            committedAt: 1,
            ...(input.operationState === 'completed' ? { completedAt: 1 } : {}),
          }),
      createdAt: 1,
      updatedAt: 1,
    })
    const staged = contentRefColumns.encode(input.staged)
    await h.db.insert(collaborationGateArtifacts).values({
      operationId,
      artifactKey: 'doc',
      artifactKind: 'review-doc',
      finalContentKey: input.finalKey,
      ...contentRowColumns(input.final),
      stagedContentRefJson: staged.json,
      stagedInlineBytes: staged.inlineBytes === null ? null : Buffer.from(staged.inlineBytes),
      sha256: metadata.sha256,
      byteSize: metadata.size,
      state: input.artifactState ?? 'consumed',
      updatedAt: 1,
    })
    await h.db.insert(docVersions).values({
      id: docId,
      taskId,
      reviewNodeId: 'review',
      reviewNodeRunId: runId,
      sourceNodeId: 'writer',
      sourcePortName: 'doc',
      versionIndex: 1,
      reviewIteration: 0,
      ...contentRowColumns(input.document),
    })
    return { docId, operationId }
  }

  for (const codec of ['review-body', 'review-body-path']) {
    for (const state of ['consumed', 'finalized'] as const) {
      test(`${codec}/${state}: old document without metadata finds staged journal bytes by final key`, async () => {
        const finalKey = `${randomUUID()}/final.md`,
          stagedKey = `${finalKey}.staged`
        const final = legacyContentRef(codec, 'local-file', finalKey, metadata)
        const document = legacyContentRef(codec, 'local-file', finalKey)
        expect(contentRefColumns.encode(final).json).not.toBe(
          contentRefColumns.encode(document).json,
        )
        const { docId } = await seed({
          document,
          final,
          staged: legacyContentRef(codec, 'local-file', stagedKey, metadata),
          finalKey,
          artifactState: state,
          operationState: state === 'finalized' ? 'completed' : 'committed',
        })
        let stagedBody: Uint8Array | null = body
        let finalBody: Uint8Array | null = null
        const reads: string[] = []
        const reader = new DatabaseCommittedReviewArtifactReader(h.db, {
          async read(path) {
            reads.push(path)
            const bytes = path === stagedKey ? stagedBody : finalBody
            return bytes === null ? null : { body: bytes, label: path }
          },
        })
        expect(await reader.read(`doc-content:${docId}`)).toBe(body.toString('utf8'))
        expect(reads).toEqual([finalKey, stagedKey])
        stagedBody = Buffer.from('wrong bytes')
        await expect(reader.read(`doc-content:${docId}`)).rejects.toMatchObject({
          code: 'human-gate-artifact-digest-mismatch',
        })
        stagedBody = null
        await expect(reader.read(`doc-content:${docId}`)).rejects.toMatchObject({
          code: 'human-gate-artifact-missing',
        })
        stagedBody = body
        finalBody = Buffer.from('corrupt final')
        reads.length = 0
        await expect(reader.read(finalKey)).rejects.toMatchObject({
          code: 'human-gate-artifact-digest-mismatch',
        })
        expect(reads).toEqual([finalKey])
      })
    }
  }

  test('uncommitted operations and unconsumed artifacts cannot supply doc-content fallback', async () => {
    for (const excluded of [
      { operationState: 'prepared' as const },
      { artifactState: 'staged' as const },
    ]) {
      const finalKey = `${randomUUID()}/final.md`
      const ref = legacyContentRef('review-body', 'local-file', finalKey, metadata)
      const { docId } = await seed({
        ...excluded,
        document: ref,
        final: ref,
        staged: legacyContentRef('review-body', 'local-file', `${finalKey}.staged`, metadata),
        finalKey,
      })
      const reads: string[] = []
      const reader = new DatabaseCommittedReviewArtifactReader(h.db, {
        async read(path) {
          reads.push(path)
          return path === finalKey ? null : { body, label: path }
        },
      })
      await expect(reader.read(`doc-content:${docId}`)).rejects.toMatchObject({
        code: 'human-gate-artifact-missing',
      })
      expect(reads).toEqual([finalKey])
    }
  })

  test('missing object catalog maps to missing and uses the staged bytes through the profile store', async () => {
    const finalKey = `object-final:${randomUUID()}`
    const final = legacyContentRef('hosted-object-id', 'object', randomUUID(), {
      ...metadata,
      contentId: randomUUID(),
      contentVersion: 1,
    })
    const staged = {
      ...legacyContentRef('inline', 'local-file', null, metadata),
      kind: 'inline' as const,
      bytes: body,
    }
    const { docId, operationId } = await seed({ document: final, final, staged, finalKey })
    const store = createContentStore({ db: h.db, policy: databaseContentPolicy })
    await expect(store.read(final)).rejects.toThrow('content-object-missing')
    const reads: ContentRef[] = []
    const reader = new DatabaseCommittedReviewArtifactReader(
      h.db,
      {
        read: async () => {
          throw new Error('unexpected legacy read')
        },
      },
      {
        read: async (ref) => {
          reads.push(ref)
          return store.read(ref)
        },
      },
    )
    expect(await reader.read(`doc-content:${docId}`)).toBe(body.toString('utf8'))
    expect(reads.map((ref) => ref.kind)).toEqual(['object', 'inline'])
    expect(await reader.read(finalKey)).toBe(body.toString('utf8'))
    await h.db
      .delete(tablesOf(h.db).collaborationGateArtifacts)
      .where(eq(tablesOf(h.db).collaborationGateArtifacts.operationId, operationId))
    await expect(reader.read(`doc-content:${docId}`)).rejects.toMatchObject({
      code: 'human-gate-artifact-missing',
    })
  })

  test('profile digest failures and unrelated transport failures never read staged content', async () => {
    const finalKey = `profile-final:${randomUUID()}`
    const final = legacyContentRef('hosted-object-id', 'object', randomUUID(), metadata)
    const { docId } = await seed({
      document: final,
      final,
      staged: legacyContentRef('hosted-object-id', 'object', 'staged', metadata),
      finalKey,
    })
    for (const message of [
      'content-ref-digest-mismatch',
      'content-ref-size-mismatch',
      'transport-unavailable',
    ]) {
      const reads: ContentRef[] = []
      const failure = new Error(message)
      const content: Pick<ContentStore, 'read'> = {
        read: async (ref) => {
          reads.push(ref)
          throw failure
        },
      }
      const reader = new DatabaseCommittedReviewArtifactReader(
        h.db,
        { read: async () => null },
        content,
      )
      const outcome = reader.read(`doc-content:${docId}`)
      if (message.startsWith('content-ref-'))
        await expect(outcome).rejects.toMatchObject({ code: 'human-gate-artifact-digest-mismatch' })
      else await expect(outcome).rejects.toBe(failure)
      expect(reads).toHaveLength(1)
    }
  })
})
