import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
// RFC-395 C: v2 open manifests, content publication and history-only replay fences.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eq } from 'drizzle-orm'
import { describeEachProvider } from './helpers/eachProvider'
import { workflowFixture, taskFixture, nodeRunFixture } from './helpers/model'
import { createTestDb } from './helpers/testDatabase'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  createContentStore,
  createLocalFileContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { legacyContentRef } from '@/platform/content/contentRef'
import { DatabaseHumanGateOpenParticipantInTx } from '@/modules/collaboration/infrastructure/humanGateOpenParticipant'
import { HumanGateOperationRecovery } from '@/modules/collaboration/application/recoverHumanGateOperations'
import { createNodeRunMintParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunMintParticipant'
import { createNodeRunLifecycleParticipantInTx } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import {
  createConsumedInputsParticipantInTx,
  createHumanGatePersistenceParticipantInTx,
} from '@/modules/task-execution/public/participants'
import {
  createCollaborationCommandContext,
  resolveCollaborationCommandContext,
} from '@/modules/collaboration/composition/commandContext'
import { contentRefColumns } from '@/platform/content/contentStore'
import { sha256Hex } from '@/util/hash'
import { createCommittedHumanInputQueries } from '@/modules/collaboration/infrastructure/committedHumanInputQueries'
import {
  ReviewGateOpenPreparation,
  type PreparedReviewGateOpen,
  type PrepareReviewGateOpenInput,
} from '@/modules/collaboration/application/prepareReviewGateOpen'
import { ClarifyGateOpenPreparation } from '@/modules/collaboration/application/prepareClarifyGateOpen'
import { DatabaseHumanGateOperationPersistence } from '@/modules/collaboration/infrastructure/humanGateOperationPersistence'
import {
  DatabaseHumanGateOperationJournal,
  createContentHumanGateArtifactStore,
  assertGateReplayAllowed,
  readCommittedReviewDocumentContent,
} from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { decodeReviewGateOpenManifest } from '@/modules/collaboration/domain/reviewGateOpen'
import { decodeClarifyGateOpenManifest } from '@/modules/collaboration/domain/clarifyGateOpen'
import {
  assertHumanGateManifestJson,
  type HumanGateOperationSnapshot,
} from '@/modules/collaboration/domain/humanGateOperation'
import { canonicalHumanGateRequestHash } from '@/modules/collaboration/domain/canonicalGateRequest'

import type {
  HistoryRestrictionPort,
  HistoryRestrictionRequest,
} from '@/platform/contracts/historyRestriction'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import {
  convertFixtures,
  gateRow,
  seedCollabTask,
  readFixtureRows,
} from './helpers/rfc395V2/collabFixtures'
import {
  gateOperationsRule,
  gateOperationsValidator,
} from '@/modules/collaboration/infrastructure/migration/gateOperationsRule'

// Slowest case took 3.83 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const allowed = { check: async () => ({ allowed: true as const }) }

describeEachProvider('RFC-395 C open v2', (h) => {
  async function setup() {
    const taskId = randomUUID(),
      workflowId = randomUUID()
    const definition = { $schema_version: 7, inputs: [], outputs: [], nodes: [], edges: [] }
    await workflowFixture(h.db, { id: workflowId, name: workflowId, definition, schemaVersion: 7 })
    await taskFixture(h.db, {
      id: taskId,
      workflowId,
      workflowSnapshot: definition,
      repoPath: '/tmp/gate-v2',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'test',
      status: 'running',
      inputs: '{}',
      startedAt: 1,
    })
    const journal = new DatabaseHumanGateOperationJournal(
      createHumanGatePersistenceParticipantInTx,
      allowed,
    )
    const operations = new DatabaseHumanGateOperationPersistence(h.session, journal)
    return { taskId, journal, operations }
  }
  async function prepareReview(
    f: Awaited<ReturnType<typeof setup>>,
    overrides: Partial<PrepareReviewGateOpenInput> = {},
  ) {
    const nodeRunId = overrides.reuseAwaitingNodeRun?.id ?? randomUUID()
    if (!overrides.reuseAwaitingNodeRun)
      await nodeRunFixture(h.db, {
        id: nodeRunId,
        taskId: f.taskId,
        nodeId: 'review',
        status: 'pending',
        reviewIteration: 0,
      })
    const content = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const artifacts = createContentHumanGateArtifactStore({ db: h.db, content })
    const preparation = new ReviewGateOpenPreparation(f.operations, artifacts)
    const input: PrepareReviewGateOpenInput = {
      taskId: f.taskId,
      reviewNodeId: 'review',
      containerRunId: null,
      iteration: 0,
      reviewIteration: 0,
      consumedUpstreamRunsJson: '{}',
      sourceSnapshotDigest: 'source',
      expectedTaskRevision: 0,
      idempotencyKey: randomUUID(),
      ...(!overrides.reuseAwaitingNodeRun ? { reusePendingNodeRunId: nodeRunId } : {}),
      documents: [
        {
          body: '\ufeff中文\n',
          sourceNodeId: 'author',
          sourcePortName: 'doc',
          versionIndex: 1,
          reviewIteration: 0,
        },
      ],
      now: 20,
      ...overrides,
    }
    const prepared = await preparation.prepare(input)
    if (prepared.kind !== 'prepared') throw new Error('expected-prepared')
    return { content, artifacts, preparation, input, prepared, nodeRunId }
  }
  async function consumeReview(
    f: Awaited<ReturnType<typeof setup>>,
    prepared: PreparedReviewGateOpen,
    historyRestrictions: HistoryRestrictionPort | undefined,
    rollback = false,
  ) {
    return h.session.transaction(async (tx) => {
      await createHumanGatePersistenceParticipantInTx(tx).lockTask(f.taskId)
      const participant = new DatabaseHumanGateOpenParticipantInTx(
        tx,
        f.journal,
        createNodeRunMintParticipantInTx(tx),
        createNodeRunLifecycleParticipantInTx(tx),
        createConsumedInputsParticipantInTx(),
        // @ts-expect-error The negative case deliberately omits the now-required provider.
        historyRestrictions,
      )
      const result = await participant.consumePreparedGateTx({
        prepared: prepared.prepared,
        taskRevision: 0,
        now: 30,
      })
      if (rollback) throw new Error('after-gate-consume')
      return result
    })
  }
  test('clarify preparation and replay carry target flags and reject v1 manifests', async () => {
    const f = await setup()
    const preparation = new ClarifyGateOpenPreparation(f.operations, { find: async () => null })
    const input = {
      taskId: f.taskId,
      kind: 'self' as const,
      askingNodeId: 'asking',
      askingNodeRunId: 'asking-run',
      askingShardKey: null,
      intermediaryNodeId: 'gate',
      targetConsumerNodeId: null,
      parentNodeRunId: null,
      containerRunId: null,
      loopIter: 0,
      iteration: 0,
      questionsJson: '[{"id":"q","title":"Question"}]',
      questions: [{ id: 'q', title: 'Question' }],
      truncationWarningsJson: null,
      sourceSnapshotDigest: 'source',
      expectedTaskRevision: 0,
      idempotencyKey: 'clarify-v2-replay',
      now: 20,
    }
    const first = await preparation.prepare(input)
    expect(first.manifest.schemaVersion).toBe(2)
    expect(first.manifest.round).toMatchObject({
      questionsRevision: 1,
      answersRecorded: false,
      draftsRecorded: false,
      attributionsRecorded: false,
      legacyAnswersJson: null,
    })
    expect(first.manifest.round).not.toHaveProperty('answersJson')
    const replay = await preparation.prepare(input)
    expect(replay.operation.requestHash).toBe(first.operation.requestHash)
    expect(replay.operation.id).toBe(first.operation.id)
    expect(() =>
      decodeClarifyGateOpenManifest(JSON.stringify({ ...first.manifest, schemaVersion: 1 })),
    ).toThrow()
    expect(() =>
      assertHumanGateManifestJson(JSON.stringify({ ...first.manifest, schemaVersion: 1 })),
    ).toThrow()
  })
  test('review stage/replay/finalize uses exact content bytes and stable request identity', async () => {
    const f = await setup()
    const content = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 128, externalKind: 'database-bytes' },
    })
    const artifacts = createContentHumanGateArtifactStore({ db: h.db, content })
    const preparation = new ReviewGateOpenPreparation(f.operations, artifacts)
    const input = {
      taskId: f.taskId,
      reviewNodeId: 'review',
      containerRunId: null,
      iteration: 0,
      reviewIteration: 0,
      consumedUpstreamRunsJson: '{"author":"source-run"}',
      sourceSnapshotDigest: 'source',
      expectedTaskRevision: 0,
      idempotencyKey: 'review-v2-replay',
      documents: [
        {
          body: '\ufeff中文\n',
          sourceNodeId: 'author',
          sourcePortName: 'doc',
          versionIndex: 1,
          reviewIteration: 0,
        },
      ],
      now: 20,
    }
    const first = await preparation.prepare(input)
    expect(first.manifest.schemaVersion).toBe(2)
    if (first.kind !== 'prepared') throw new Error('expected-prepared')
    expect(first.manifest.documents[0]).not.toHaveProperty('bodyPath')
    const { collaborationGateArtifacts } = tablesOf(h.db)
    const [row] = await h.db
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, first.operation.id))
    expect(row!.state).toBe('staged')
    const ref = contentRefColumns.decode(row!.contentRefJson, row!.contentInlineBytes)!
    expect(await content.read(ref)).toEqual(new TextEncoder().encode(input.documents[0]!.body))
    const replay = await preparation.prepare(input)
    expect(replay.operation.requestHash).toBe(first.operation.requestHash)
    const [artifact] = await f.operations.listArtifacts(first.operation.id)
    const receipt = await artifacts.finalizeReviewArtifact(artifact!)
    expect(JSON.parse(receipt).finalContentKey).toBe(first.manifest.documents[0]!.finalContentKey)
    expect(() =>
      decodeReviewGateOpenManifest(JSON.stringify({ ...first.manifest, schemaVersion: 1 })),
    ).toThrow()
    await expect(
      preparation.prepare({ ...input, documents: [{ ...input.documents[0]!, body: 'changed' }] }),
    ).rejects.toMatchObject({ code: 'human-gate-idempotency-conflict' })
    expect(
      canonicalHumanGateRequestHash({
        schemaVersion: 1,
        taskId: f.taskId,
        gateKind: 'review',
        operationKind: 'open',
        gateRef: first.operation.gateRef,
        actorUserId: null,
        expectedTaskRevision: 0,
        expectedGateRevision: 0,
        payload: { kind: 'open', manifestDigest: first.prepared.manifestDigest },
      }),
    ).toBe(first.operation.requestHash)
    const historicalManifest = JSON.stringify({ ...first.manifest, schemaVersion: 1 })
    const { collaborationGateOperations } = tablesOf(h.db)
    await h.db
      .update(collaborationGateOperations)
      .set({
        schemaVersion: 1,
        manifestJson: historicalManifest,
      })
      .where(eq(collaborationGateOperations.id, first.operation.id))
    await expect(preparation.prepare(input)).rejects.toMatchObject({
      code: 'human-gate-operation-manifest-invalid',
    })
    const retained = await f.operations.get(first.operation.id)
    expect(retained?.requestHash).toBe(first.operation.requestHash)
    expect(retained?.manifestJson).toBe(historicalManifest)
  })
  test('committed human-input review digests read target content without a legacy body path', async () => {
    const f = await setup()
    const nodeRunId = randomUUID(),
      docId = randomUUID(),
      operationId = randomUUID()
    await nodeRunFixture(h.db, {
      id: nodeRunId,
      taskId: f.taskId,
      nodeId: 'review',
      status: 'done',
    })
    const body = '\ufeff正文\n'
    const bytes = new TextEncoder().encode(body)
    const content = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 128, externalKind: 'database-bytes' },
    })
    await content.put(
      {
        publication: {
          owner: 'collaboration-review',
          logicalKey: docId,
          attempt: operationId,
          epoch: 1,
          scope: f.taskId,
          sha256: sha256Hex(bytes),
          size: bytes.byteLength,
        },
        source: { kind: 'bytes', bytes },
        contentVersion: 1,
        mediaType: 'text/markdown',
        references: 'shared',
      },
      async (tx, ref) => {
        const { docVersions } = tablesOf(tx)
        const columns = contentRefColumns.encode(ref)
        await tx.insert(docVersions).values({
          id: docId,
          taskId: f.taskId,
          reviewNodeId: 'review',
          reviewNodeRunId: nodeRunId,
          sourceNodeId: 'author',
          sourcePortName: 'doc',
          versionIndex: 1,
          reviewIteration: 0,
          contentRefJson: columns.json!,
          contentInlineBytes:
            columns.inlineBytes === null ? null : Buffer.from(columns.inlineBytes),
          decision: 'approved',
          decisionReason: 'accepted',
          decidedAt: 30,
        })
      },
    )
    const { collaborationGateOperations } = tablesOf(h.db)
    await h.db.insert(collaborationGateOperations).values({
      id: operationId,
      taskId: f.taskId,
      gateKind: 'review',
      operationKind: 'decide',
      gateRef: `review:${nodeRunId}`,
      idempotencyKey: operationId,
      requestHash: 'retained-hash',
      expectedTaskRevision: 0,
      expectedGateRevision: 0,
      resultGateRevision: 1,
      state: 'committed',
      receiptJson: '{}',
      committedAt: 30,
      createdAt: 30,
      updatedAt: 30,
    })
    const result = await createCommittedHumanInputQueries({ db: h.db, content }).reviewDecision(
      f.taskId,
      nodeRunId,
    )
    expect(result).toMatchObject({
      receiptId: operationId,
      decision: 'approved',
      reason: 'accepted',
      documentDigests: [sha256Hex(body)],
    })
  })
  test('journal rejects restricted replay but skips restricted recovery rows across batch pages', async () => {
    const f = await setup()
    const begin = {
      operationId: randomUUID(),
      idempotencyKey: 'restricted-replay',
      now: 10,
      request: {
        schemaVersion: 1 as const,
        taskId: f.taskId,
        gateKind: 'clarify' as const,
        operationKind: 'open' as const,
        gateRef: 'restricted-gate',
        actorUserId: null,
        expectedTaskRevision: 0,
        expectedGateRevision: 0,
        payload: { kind: 'open' as const, manifestDigest: 'digest' },
      },
    }
    const original = await f.operations.begin(begin)
    const restricted = new DatabaseHumanGateOperationJournal(
      createHumanGatePersistenceParticipantInTx,
      {
        check: async (_tx, request) =>
          request.gates[0].sourceKey !==
          encodeMigrationKey('collaboration_gate_operations', [
            { type: 'text', value: begin.operationId },
          ])
            ? { allowed: true }
            : {
                allowed: false,
                code: 'history-only',
                restrictions: [
                  {
                    runId: 'migration',
                    unitId: 'unit',
                    ordinal: 0,
                    sourcePhase: 'current',
                    sourceTable: 'collaboration_gate_operations',
                    sourceKey: 'mk1:history',
                    decisionCode: 'history-only',
                    history: {
                      taskId: f.taskId,
                      runId: null,
                      execution: 'terminal-history',
                      missingFields: ['legacy-open-replay'],
                    },
                  },
                ],
              },
      },
    )
    await expect(
      h.session.transaction((tx) => restricted.beginTx({ ...begin, tx })),
    ).rejects.toMatchObject({ code: 'history-only' })
    const admitted = await f.operations.begin({
      ...begin,
      operationId: randomUUID(),
      idempotencyKey: 'admitted-recovery',
      now: 11,
      request: { ...begin.request, gateRef: 'admitted-gate' },
    })
    const claimed = await h.session.transaction((tx) =>
      restricted.claimRecoveryBatchTx({
        tx,
        now: admitted.operation.claimExpiresAt! + 1,
        leaseMs: 100,
        limit: 1,
      }),
    )
    expect(claimed.map((row) => row.id)).toEqual([admitted.operation.id])
    expect(claimed[0]!.claimEpoch).toBe(admitted.operation.claimEpoch + 1)
    const recovery = new HumanGateOperationRecovery({
      operations: new DatabaseHumanGateOperationPersistence(h.session, restricted),
      artifacts: createContentHumanGateArtifactStore({
        db: h.db,
        content: createContentStore({
          db: h.db,
          policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
        }),
      }),
      preparedInspector: { inspectPreparedOperation: () => 'retain-for-owner-retry' },
      now: () => admitted.operation.claimExpiresAt! + 102,
      batchLimit: 1,
    })
    expect(await recovery.runOnce()).toMatchObject({
      claimed: 1,
      retained: 1,
      failed: 0,
      errors: [],
    })
    expect(await h.session.transaction((tx) => restricted.getTx(tx, begin.operationId))).toEqual(
      original.operation,
    )
  })
  test('recovery excludes v1 prepared opens but may finish an already committed v1 gate', async () => {
    const f = await setup()
    const ids = { prepared: randomUUID(), committed: randomUUID() }
    for (const state of ['prepared', 'committed'] as const) {
      await f.operations.begin({
        operationId: ids[state],
        idempotencyKey: `v1-${state}`,
        now: 10,
        request: {
          schemaVersion: 1,
          taskId: f.taskId,
          gateKind: 'clarify',
          operationKind: 'open',
          gateRef: `v1-${state}`,
          actorUserId: null,
          expectedTaskRevision: 0,
          expectedGateRevision: 0,
          payload: { kind: 'open', manifestDigest: state },
        },
      })
      const { collaborationGateOperations } = tablesOf(h.db)
      await h.db
        .update(collaborationGateOperations)
        .set({
          schemaVersion: 1,
          manifestJson: '{ "schemaVersion": 1, "kind": "clarify-open" }',
          state,
          claimExpiresAt: null,
          ...(state === 'committed'
            ? {
                resultGateRevision: 1,
                receiptJson: '{ "ok": true }',
                committedAt: 11,
              }
            : {}),
        })
        .where(eq(collaborationGateOperations.id, ids[state]))
    }
    const claimed = await h.session.transaction((tx) =>
      f.journal.claimRecoveryBatchTx({
        tx,
        now: 20,
        leaseMs: 100,
        limit: 100,
      }),
    )
    expect(claimed.some((operation) => operation.id === ids.prepared)).toBe(false)
    expect(claimed.find((operation) => operation.id === ids.committed)).toMatchObject({
      schemaVersion: 1,
      state: 'committed',
      claimEpoch: 2,
    })
  })
  test('v2 review consume parks the node, persists readable doc refs and rolls back v1 or invalid artifacts', async () => {
    const f = await setup()
    const r = await prepareReview(f)
    const { docVersions, collaborationGateArtifacts, nodeRuns } = tablesOf(h.db)
    const { collaborationGateOperations } = tablesOf(h.db)
    const [artifact] = await h.db
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, r.prepared.operation.id))
    const originalManifest = r.prepared.operation.manifestJson
    const legacyManifest = JSON.stringify({ ...r.prepared.manifest, schemaVersion: 1 })
    await h.db
      .update(collaborationGateOperations)
      .set({ schemaVersion: 1, manifestJson: legacyManifest })
      .where(eq(collaborationGateOperations.id, r.prepared.operation.id))
    await expect(
      consumeReview(
        f,
        {
          ...r.prepared,
          prepared: { ...r.prepared.prepared, manifestDigest: sha256Hex(legacyManifest) },
        },
        allowed,
      ),
    ).rejects.toMatchObject({ code: 'human-gate-operation-manifest-invalid' })
    await h.db
      .update(collaborationGateOperations)
      .set({ schemaVersion: 2, manifestJson: originalManifest })
      .where(eq(collaborationGateOperations.id, r.prepared.operation.id))
    await expect(consumeReview(f, r.prepared, undefined)).rejects.toThrow(
      'gate-history-restriction-provider-required',
    )
    for (const patch of [
      { state: 'declared' as const },
      { contentRefJson: null, contentInlineBytes: null },
      { sha256: 'f'.repeat(64) },
      { byteSize: artifact!.byteSize + 1 },
    ]) {
      await h.db
        .update(collaborationGateArtifacts)
        .set(patch)
        .where(eq(collaborationGateArtifacts.operationId, r.prepared.operation.id))
      await expect(consumeReview(f, r.prepared, allowed)).rejects.toThrow()
      expect(await h.db.select().from(docVersions).where(eq(docVersions.taskId, f.taskId))).toEqual(
        [],
      )
      expect((await f.operations.get(r.prepared.operation.id))!.state).toBe('prepared')
      expect(
        (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, r.nodeRunId)))[0]!.status,
      ).toBe('pending')
      await h.db
        .update(collaborationGateArtifacts)
        .set({
          state: artifact!.state,
          contentRefJson: artifact!.contentRefJson,
          contentInlineBytes: artifact!.contentInlineBytes,
          sha256: artifact!.sha256,
          byteSize: artifact!.byteSize,
        })
        .where(eq(collaborationGateArtifacts.operationId, r.prepared.operation.id))
    }
    await consumeReview(f, r.prepared, allowed)
    const docs = await h.db.select().from(docVersions).where(eq(docVersions.taskId, f.taskId))
    expect(docs).toHaveLength(1)
    expect(docs[0]!.id).toBe(r.prepared.manifest.documents[0]!.id)
    expect(artifact!.contentRefJson).not.toBeNull()
    expect(docs[0]!.contentRefJson).toBe(artifact!.contentRefJson!)
    expect(
      await r.content.read(
        contentRefColumns.decode(docs[0]!.contentRefJson, docs[0]!.contentInlineBytes)!,
      ),
    ).toEqual(new TextEncoder().encode(r.input.documents[0]!.body))
    expect(
      (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, r.nodeRunId)))[0]!.status,
    ).toBe('awaiting_review')
    expect((await f.operations.get(r.prepared.operation.id))!.state).toBe('committed')
    expect((await f.operations.listArtifacts(r.prepared.operation.id))[0]!.state).toBe('consumed')
    let contentReads = 0
    const context = createCollaborationCommandContext({
      db: h.db,
      taskLock: createHumanGatePersistenceParticipantInTx,
      historyRestrictions: allowed,
      content: {
        ...r.content,
        read: async (ref) => {
          contentReads++
          return r.content.read(ref)
        },
      },
      reviewArtifacts: {
        store: r.artifacts,
        content: {
          read: async () => {
            throw new Error('unexpected-legacy-content-read')
          },
        },
      },
    })
    expect(
      await resolveCollaborationCommandContext(context).persistence.committedArtifacts!.read(
        `doc-content:${docs[0]!.id}`,
      ),
    ).toBe(r.input.documents[0]!.body)
    expect(contentReads).toBe(1)
  })

  test('converted committed v1 content falls back to staged bytes for finalize and history digests', async () => {
    const f = await setup()
    const r = await prepareReview(f)
    const root = await mkdtemp(join(tmpdir(), 'rfc395-review-staged-'))
    try {
      const body = '\ufeff中文\n'
      const bytes = Buffer.from(body)
      const finalPath = 'final.md',
        stagedPath = 'staged.md'
      await writeFile(join(root, stagedPath), bytes)
      const metadata = { sha256: sha256Hex(bytes), size: bytes.byteLength }
      const final = contentRefColumns.encode(
        legacyContentRef('review-body-path', 'local-file', finalPath, metadata),
      )
      const staged = contentRefColumns.encode(
        legacyContentRef('review-body-path', 'local-file', stagedPath, metadata),
      )
      const { collaborationGateArtifacts, docVersions } = tablesOf(h.db)
      const { collaborationGateOperations } = tablesOf(h.db)
      const legacyManifest = JSON.stringify({ ...r.prepared.manifest, schemaVersion: 1 })
      await h.db
        .update(collaborationGateOperations)
        .set({
          schemaVersion: 1,
          manifestJson: legacyManifest,
          state: 'committed',
          receiptJson: '{ "legacy": true }',
          resultGateRevision: 1,
          committedAt: 21,
          claimExpiresAt: null,
        })
        .where(eq(collaborationGateOperations.id, r.prepared.operation.id))
      await h.db
        .update(collaborationGateArtifacts)
        .set({
          finalContentKey: finalPath,
          contentRefJson: final.json,
          contentInlineBytes: null,
          stagedContentRefJson: staged.json,
          stagedInlineBytes: null,
          state: 'consumed',
        })
        .where(eq(collaborationGateArtifacts.operationId, r.prepared.operation.id))
      const content = createContentStore({
        db: h.db,
        policy: { inlineMaxBytes: 0, externalKind: 'local-file' },
        transports: { 'local-file': createLocalFileContentTransport(join(root, 'content'), root) },
      })
      const artifacts = createContentHumanGateArtifactStore({ db: h.db, content })
      const [artifact] = await f.operations.listArtifacts(r.prepared.operation.id)
      await expect(artifacts.finalizeReviewArtifact(artifact!)).resolves.toBeString()
      const doc = {
        id: randomUUID(),
        taskId: f.taskId,
        reviewNodeId: 'review',
        reviewNodeRunId: r.nodeRunId,
        sourceNodeId: 'author',
        sourcePortName: 'doc',
        versionIndex: 1,
        reviewIteration: 0,
        contentRefJson: final.json!,
        contentInlineBytes: null,
        decision: 'approved' as const,
        decisionReason: 'accepted',
        decidedAt: 30,
      }
      await h.db.insert(docVersions).values(doc)
      // A document's legacy reference can omit facts that the artifact journal retained.
      const unknownFacts = contentRefColumns.encode(
        legacyContentRef('review-body-path', 'local-file', finalPath),
      )
      expect(
        await readCommittedReviewDocumentContent(h.db, content, {
          contentRefJson: unknownFacts.json!,
          contentInlineBytes: null,
        }),
      ).toEqual(bytes)
      const decisionId = randomUUID()
      await h.db.insert(collaborationGateOperations).values({
        id: decisionId,
        taskId: f.taskId,
        gateKind: 'review',
        operationKind: 'decide',
        gateRef: `review:${r.nodeRunId}`,
        idempotencyKey: decisionId,
        requestHash: 'legacy-decision',
        expectedTaskRevision: 0,
        expectedGateRevision: 1,
        resultGateRevision: 2,
        state: 'completed',
        receiptJson: '{}',
        committedAt: 30,
        completedAt: 30,
        createdAt: 30,
        updatedAt: 30,
      })
      expect(
        await createCommittedHumanInputQueries({ db: h.db, content }).reviewDecision(
          f.taskId,
          r.nodeRunId,
        ),
      ).toMatchObject({ documentDigests: [sha256Hex(body)] })
      // An existing but changed final file is an error, not a reason to use staged bytes.
      await writeFile(join(root, finalPath), 'changed')
      await expect(artifacts.finalizeReviewArtifact(artifact!)).rejects.toThrow(
        /content-ref-(size|digest)-mismatch/,
      )
      await rm(join(root, finalPath))
      const recovery = new HumanGateOperationRecovery({
        operations: f.operations,
        artifacts,
        preparedInspector: { inspectPreparedOperation: () => 'retain-for-owner-retry' },
        now: () => 40,
      })
      expect(await recovery.runOnce()).toMatchObject({ finalized: 1, failed: 0 })
      expect((await f.operations.get(r.prepared.operation.id))!.manifestJson).toBe(legacyManifest)
      expect((await f.operations.get(r.prepared.operation.id))!.state).toBe('completed')
      expect(await readCommittedReviewDocumentContent(h.db, content, doc)).toEqual(bytes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('converted hosted cleanup releases the epoch-1 identity with or without a receipt and allows reopening', async () => {
    const f = await setup()
    const content = createContentStore({
      db: h.db,
      policy: { inlineMaxBytes: 0, externalKind: 'database-bytes' },
    })
    const artifacts = createContentHumanGateArtifactStore({ db: h.db, content })
    for (const hasReceipt of [true, false]) {
      const operationId = randomUUID(),
        artifactKey = 'review-doc',
        finalPath = `legacy/${operationId}`
      const logicalKey = `${operationId}/${sha256Hex(artifactKey)}`
      const body = Buffer.from('legacy bytes')
      const begun = await f.operations.begin({
        operationId,
        idempotencyKey: operationId,
        now: 10,
        request: {
          schemaVersion: 1,
          taskId: f.taskId,
          gateKind: 'review',
          operationKind: 'open',
          gateRef: `review:${operationId}`,
          actorUserId: null,
          expectedTaskRevision: 0,
          expectedGateRevision: 0,
          payload: { kind: 'open', manifestDigest: 'legacy' },
        },
        artifacts: [
          {
            artifactKey,
            finalPath,
            stagedPath: 'legacy-stage',
            sha256: sha256Hex(body),
            byteSize: body.byteLength,
          },
        ],
      })
      const { collaborationGateOperations } = tablesOf(h.db)
      const { collaborationGateArtifacts } = tablesOf(h.db)
      await h.db
        .update(collaborationGateOperations)
        .set({ schemaVersion: 1, state: 'cleanup_pending', claimExpiresAt: null })
        .where(eq(collaborationGateOperations.id, operationId))
      // Converted publications keep a real historical attempt/epoch, not the new operation fence.
      const ref = await content.put(
        {
          publication: {
            owner: 'collaboration-review',
            logicalKey,
            attempt: 'old-hosted-attempt',
            epoch: 7,
            scope: f.taskId,
            sha256: sha256Hex(body),
            size: body.byteLength,
          },
          source: { kind: 'bytes', bytes: body },
          references: 'shared',
          contentVersion: 1,
          mediaType: 'text/markdown',
        },
        async (tx, ref) => {
          const columns = contentRefColumns.encode(ref)
          await tx
            .update(collaborationGateArtifacts)
            .set({
              state: 'cleanup_pending',
              ...(hasReceipt
                ? {
                    contentRefJson: columns.json,
                    contentInlineBytes: null,
                    receiptJson: JSON.stringify({
                      kind: 'cs-review-object-v2',
                      operationId,
                      artifactKey,
                      key: logicalKey,
                      stagedPath: 'legacy-stage',
                      finalPath,
                      object: { id: randomUUID(), sha256: sha256Hex(body), size: body.byteLength },
                    }),
                  }
                : {}),
            })
            .where(eq(collaborationGateArtifacts.operationId, operationId))
        },
      )
      expect(ref.contentId).not.toBeNull()
      const recovery = new HumanGateOperationRecovery({
        operations: f.operations,
        artifacts,
        preparedInspector: { inspectPreparedOperation: () => 'retain-for-owner-retry' },
        now: () => 20,
      })
      expect(await recovery.runOnce()).toMatchObject({ cleaned: 1, failed: 0, errors: [] })
      expect(
        (await content.publications.find({ owner: 'collaboration-review', logicalKey }))!.state,
      ).toBe('releasing')
      expect((await f.operations.get(operationId))!.state).toBe('completed')
      expect(await f.operations.listArtifacts(operationId)).toEqual([])
      const reopened = await f.operations.begin({
        operationId: randomUUID(),
        idempotencyKey: randomUUID(),
        now: 21,
        request: {
          schemaVersion: 1,
          taskId: f.taskId,
          gateKind: 'review',
          operationKind: 'open',
          gateRef: begun.operation.gateRef,
          actorUserId: null,
          expectedTaskRevision: 0,
          expectedGateRevision: 0,
          payload: { kind: 'open', manifestDigest: 'new' },
        },
      })
      expect(reopened.replayed).toBe(false)
      // Leave this admitted operation out of the next loop's due set.
      expect(reopened.operation.claimExpiresAt).toBeGreaterThan(20)
    }
  })

  test('superseding review comments releases their publications in the same transaction', async () => {
    const f = await setup()
    const r = await prepareReview(f)
    await consumeReview(f, r.prepared, allowed)
    const [artifact] = await f.operations.listArtifacts(r.prepared.operation.id)
    await f.operations.transitionArtifact({
      operationId: artifact!.operationId,
      artifactKey: artifact!.artifactKey,
      from: 'consumed',
      to: 'finalized',
      receiptJson: await r.artifacts.finalizeReviewArtifact(artifact!),
      now: 31,
    })
    await f.operations.complete({
      operationId: r.prepared.operation.id,
      expectedClaimEpoch: 1,
      now: 31,
    })
    const oldDocId = r.prepared.manifest.documents[0]!.id
    const commentId = randomUUID(),
      bytes = Buffer.from('retired comment')
    const { reviewComments, docVersions, contentBytes } = tablesOf(h.db)
    const commentRef = await r.content.put(
      {
        publication: {
          owner: 'review-comment',
          logicalKey: commentId,
          attempt: commentId,
          epoch: 1,
          scope: f.taskId,
          sha256: sha256Hex(bytes),
          size: bytes.byteLength,
        },
        source: { kind: 'bytes', bytes },
        references: 'shared',
        contentVersion: 1,
        mediaType: 'text/plain',
      },
      async (tx, ref) => {
        const columns = contentRefColumns.encode(ref)
        await tx.insert(reviewComments).values({
          id: commentId,
          docVersionId: oldDocId,
          anchorSectionPath: '',
          anchorParagraphIdx: 0,
          anchorOffsetStart: 0,
          anchorOffsetEnd: 1,
          selectedText: '',
          contextBefore: '',
          contextAfter: '',
          occurrenceIndex: 0,
          contentRefJson: columns.json!,
          contentInlineBytes: null,
        })
      },
    )
    const next = await prepareReview(f, {
      reuseAwaitingNodeRun: { id: r.nodeRunId, consumedUpstreamRunsJson: '{}' },
      expectedGateRevision: 1,
      supersedePendingDocumentIds: [oldDocId],
      now: 40,
      documents: [
        {
          body: 'next',
          sourceNodeId: 'author',
          sourcePortName: 'doc',
          versionIndex: 2,
          reviewIteration: 0,
        },
      ],
    })
    await expect(consumeReview(f, next.prepared, allowed, true)).rejects.toThrow(
      'after-gate-consume',
    )
    expect(
      await h.db.select().from(reviewComments).where(eq(reviewComments.id, commentId)),
    ).toHaveLength(1)
    expect(
      (await r.content.publications.find({ owner: 'review-comment', logicalKey: commentId }))!
        .state,
    ).toBe('ready')
    expect(
      (await h.db.select().from(docVersions).where(eq(docVersions.id, oldDocId)))[0]!.decision,
    ).toBe('pending')
    await consumeReview(f, next.prepared, allowed)
    expect(
      await h.db.select().from(reviewComments).where(eq(reviewComments.id, commentId)),
    ).toEqual([])
    expect(
      (await r.content.publications.find({ owner: 'review-comment', logicalKey: commentId }))!
        .state,
    ).toBe('releasing')
    expect(
      (await h.db.select().from(docVersions).where(eq(docVersions.id, oldDocId)))[0]!.decision,
    ).toBe('superseded')
    // Physical bytes remain for the existing history/backup holder rules.
    expect(
      await h.db
        .select()
        .from(contentBytes)
        .where(eq(contentBytes.contentId, commentRef.contentId!)),
    ).toHaveLength(1)
    expect(await r.content.read(commentRef)).toEqual(bytes)
  })

  test('composition and the task-lock persistence constructor use the injected restriction provider', async () => {
    const f = await setup()
    const r = await prepareReview(f)
    const requests: HistoryRestrictionRequest[] = []
    const historyRestrictions: HistoryRestrictionPort = {
      check: async (_tx, request) => {
        requests.push(request)
        return { allowed: true }
      },
    }
    const context = createCollaborationCommandContext({
      content: epoch2RuntimeTestPorts(h.db).content,
      db: h.db,
      taskLock: createHumanGatePersistenceParticipantInTx,
      historyRestrictions,
    })
    const composed = resolveCollaborationCommandContext(context).persistence.operations
    const direct = new DatabaseHumanGateOperationPersistence(
      h.session,
      createHumanGatePersistenceParticipantInTx,
      { historyRestrictions },
    )
    for (const operations of [composed, direct]) {
      expect(
        await operations.findByIdempotency({
          taskId: f.taskId,
          gateKind: 'review',
          operationKind: 'open',
          idempotencyKey: r.input.idempotencyKey,
        }),
      ).toMatchObject({ id: r.prepared.operation.id })
    }
    expect(requests).toHaveLength(2)
    expect(
      requests.every((request) => request.taskId === f.taskId && request.action === 'replay'),
    ).toBe(true)
    expect(() => {
      new DatabaseHumanGateOperationPersistence(
        h.session,
        // @ts-expect-error A task-lock factory must receive the active restriction provider.
        createHumanGatePersistenceParticipantInTx,
      )
    }).toThrow('gate-history-restriction-provider-required')
  })

  test('declared content is absent until publication; transition cannot manufacture staged content', async () => {
    const f = await setup()
    const op = await f.operations.begin({
      operationId: randomUUID(),
      idempotencyKey: 'declared-gate',
      now: 10,
      request: {
        schemaVersion: 1,
        taskId: f.taskId,
        gateKind: 'review',
        operationKind: 'open',
        gateRef: 'declared',
        actorUserId: null,
        expectedTaskRevision: 0,
        expectedGateRevision: 0,
        payload: { kind: 'open', manifestDigest: 'digest' },
      },
      artifacts: [
        {
          artifactKey: 'doc',
          stagedPath: 'gate-stage:doc',
          finalPath: 'doc-key',
          sha256: 'a'.repeat(64),
          byteSize: 1,
        },
      ],
    })
    const { collaborationGateArtifacts } = tablesOf(h.db)
    const [row] = await h.db
      .select()
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, op.operation.id))
    expect(row!.contentRefJson).toBeNull()
    expect(row!.stagedContentRefJson).toBeNull()
    await expect(
      f.operations.transitionArtifact({
        operationId: op.operation.id,
        artifactKey: 'doc',
        from: 'declared',
        to: 'staged',
        receiptJson: '{}',
        now: 11,
      }),
    ).rejects.toMatchObject({ code: 'human-gate-artifact-missing' })
  })
})

test('restriction check carries precise run/gate keys, rejects history and propagates provider failures', async () => {
  const h = await createTestDb()
  try {
    const operation: HumanGateOperationSnapshot = {
      id: 'op',
      taskId: 'task',
      gateKind: 'clarify',
      operationKind: 'open',
      gateRef: 'clarify:gate',
      idempotencyKey: 'identity',
      requestHash: 'preserved',
      actorUserId: null,
      expectedTaskRevision: 0,
      expectedGateRevision: 0,
      resultGateRevision: null,
      state: 'prepared',
      claimEpoch: 1,
      claimExpiresAt: null,
      schemaVersion: 2,
      manifestJson: JSON.stringify({
        schemaVersion: 2,
        kind: 'clarify-open',
        node: {
          id: 'gate',
          consumedUpstreamRunsJson: '{"one":"source","many":["other","source"]}',
        },
        round: { id: 'round', askingNodeRunId: 'asking', intermediaryNodeRunId: 'gate' },
      }),
      receiptJson: null,
      failureJson: null,
      createdAt: 1,
      updatedAt: 1,
      committedAt: null,
      completedAt: null,
    }
    const requests: HistoryRestrictionRequest[] = []
    await h.session.transaction((tx) =>
      assertGateReplayAllowed(
        tx,
        {
          check: async (_tx, request) => {
            requests.push(request)
            return { allowed: true }
          },
        },
        operation,
      ),
    )
    expect(requests[0]!.nodeRunIds).toEqual(['gate', 'asking', 'source', 'other'])
    expect(requests[0]!.gates).toEqual([
      {
        sourceTable: 'collaboration_gate_operations',
        sourceKey: encodeMigrationKey('collaboration_gate_operations', [
          { type: 'text', value: 'op' },
        ]),
      },
      {
        sourceTable: 'clarify_rounds',
        sourceKey: encodeMigrationKey('clarify_rounds', [{ type: 'text', value: 'round' }]),
      },
    ])
    await h.session.transaction((tx) =>
      assertGateReplayAllowed(
        tx,
        {
          check: async (_tx, request) => {
            requests.push(request)
            return { allowed: true }
          },
        },
        {
          ...operation,
          operationKind: 'decide',
          manifestJson: JSON.stringify({
            schemaVersion: 1,
            kind: 'clarify-decision',
            request: { payload: { roundId: 'decision-round' } },
            sourceNodeRunIds: ['selected'],
            rerunNodeRunIds: ['rerun', 'selected'],
          }),
        },
      ),
    )
    expect(requests[1]!.nodeRunIds).toEqual(['selected', 'rerun'])
    expect(requests[1]!.gates[1]).toEqual({
      sourceTable: 'clarify_rounds',
      sourceKey: encodeMigrationKey('clarify_rounds', [{ type: 'text', value: 'decision-round' }]),
    })
    await expect(
      h.session.transaction((tx) =>
        assertGateReplayAllowed(
          tx,
          {
            check: async () => ({
              allowed: false,
              code: 'history-only',
              restrictions: [
                {
                  runId: 'migration',
                  unitId: 'unit',
                  ordinal: 0,
                  sourcePhase: 'current',
                  sourceTable: 'clarify_rounds',
                  sourceKey: 'mk1:history',
                  decisionCode: 'history-only',
                  history: {
                    taskId: 'task',
                    runId: null,
                    execution: 'terminal-history',
                    missingFields: ['legacy-open-replay'],
                  },
                },
              ],
            }),
          },
          operation,
        ),
      ),
    ).rejects.toMatchObject({ code: 'history-only' })
    await expect(
      h.session.transaction((tx) =>
        assertGateReplayAllowed(
          tx,
          {
            check: async () => {
              throw new Error('restriction-read-failed')
            },
          },
          operation,
        ),
      ),
    ).rejects.toThrow('restriction-read-failed')
    await expect(
      // @ts-expect-error Verify the runtime refusal for an untyped caller missing its provider.
      h.session.transaction((tx) => assertGateReplayAllowed(tx, undefined, operation)),
    ).rejects.toThrow('gate-history-restriction-provider-required')
    expect(operation.requestHash).toBe('preserved')
    expect(await h.db.select().from(tablesOf(h.db).collaborationGateOperations)).toEqual([])
  } finally {
    await h.close()
  }
})

describeV2Providers('RFC-395 C v1 drain and historical identity', (h) => {
  test('converter blocks executable in-flight opens and preserves committed v1 identity bytes', async () => {
    await h.install()
    const { task } = await seedCollabTask(h, 'task', 'running', 'executable')
    await h.write('collaboration_gate_operations', [
      gateRow('pending', 'task'),
      gateRow('committed', 'task', {
        state: 'committed',
        manifest_json: '{ "schemaVersion": 1, "kind": "clarify-open" }\n',
        request_hash: 'old-request-digest',
        idempotency_key: 'old-business-key',
        receipt_json: '{ "ok": true }\n',
        result_gate_revision: 1,
        committed_at: 2,
      }),
    ])
    const before = await readFixtureRows(h, 'collaboration_gate_operations')
    const { summary, sink } = await convertFixtures(
      h,
      [{ rules: [gateOperationsRule], validators: [gateOperationsValidator], lookups: [] }],
      { taskFacts: [task] },
    )
    expect(summary.blocks.map((block) => block.code)).toContain('v2-gate-open-in-flight')
    expect(
      sink.rows('collaboration_gate_operations').find((row) => row.id === 'committed'),
    ).toEqual(before.find((row) => row.values.id === 'committed')!.values)
  })
})
