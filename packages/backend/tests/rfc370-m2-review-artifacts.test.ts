import { composeCollaborationTaskRolePolicy } from '@/modules/resource-catalog/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import {
  createContentStore,
  createObjectContentTransport,
} from '@/platform/content/infrastructure/contentStore'
import { rowToDocVersion } from '@/modules/collaboration/infrastructure/review'
import { o2Ports, withO2Closure } from './helpers/o2Closure'
// RFC-370 v3 V6: review documents are `collaboration-review` publications of
// the neutral journal; the gate journal keeps receipts and stays the recovery
// authority. Cleanup is an owner release settled by maintenance, and the
// collaboration sweep releases the documents of tasks that no longer exist.
import {
  agentFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  type WorkflowDefinition,
  type WorkflowNode,
  joinMarkdownDocs,
} from '@agent-workflow/shared'

import {
  composeCrewStationReviewArtifacts,
  composeCrewStationReviewObjectSweep,
} from '@/modules/collaboration/composition/crewstationReviewArtifacts'
import {
  HOSTED_REVIEW_OWNER,
  hostedReviewPublicationKey,
} from '@/modules/collaboration/infrastructure/crewstation/reviewArtifacts'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { createCollaborationRouteOperations } from '@/modules/collaboration/infrastructure/collaborationRouteOperations'
import { DatabaseCommittedReviewArtifactReader } from '@/modules/collaboration/infrastructure/committedReviewArtifactReader'
import { composeCrewStationHumanGateRecovery } from '@/modules/collaboration/composition/crewstationHumanGateRecovery'
import { createHostedBackupReleaseHorizon } from '@/modules/system-operations/infrastructure/crewstation/backupReleaseHorizon'
import {
  createHostedObjectPublications,
  hostedPublicationId,
} from '@/modules/system-operations/infrastructure/crewstation/objectPublications'
import { describeEachProvider } from './helpers/eachProvider'
import { objectFixture } from './helpers/rfc370Objects'

test('object pin replay is idempotent for one owner lifetime and release is idempotent', async () => {
  const f = objectFixture()
  f.losePinReply()
  const bytes = Buffer.from('immutable review content')
  await expect(f.objects.put('review:lost-reply', bytes)).rejects.toThrow('pin reply lost')
  const object = await f.objects.put('review:lost-reply', bytes)
  expect(await f.objects.put('review:lost-reply', bytes)).toEqual(object)
  expect(f.pins).toEqual(['review:lost-reply'])
  await f.objects.release('review:lost-reply', object)
  await f.objects.release('review:lost-reply', object)
  expect(f.releases).toEqual(['review:lost-reply'])
})

describeEachProvider('RFC-370 CS review journal content', (harness) => {
  const setup = (objects = objectFixture()) => {
    const journal = createHostedObjectPublications({
      db: harness.db,
      fence: {
        current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
        assertHeld: async () => undefined,
      },
      objects: objects.objects,
      // A released pending upload is settled at once in these single-writer cases.
      abandonAfterMs: 0,
    })
    const settle = () =>
      journal.maintenance({ horizon: createHostedBackupReleaseHorizon({ db: harness.db }) }).run()
    return {
      f: objects,
      journal,
      settle,
      selection: () =>
        composeCrewStationReviewArtifacts({
          db: harness.db,
          objects: objects.objects,
          publications: journal.publications,
        }),
    }
  }

  test('a converted legacy receipt finalizes after stagedPath becomes a gate-stage key', async () => {
    const { selection } = setup()
    const body = 'legacy committed review'
    const plan = selection().store.planReviewArtifact({
      operationId: 'legacy-review-op',
      artifactKey: 'doc',
      finalPath: 'runs/task/review/legacy.md',
      body,
    })
    const staged = await selection().store.stageReviewArtifact(plan, body)
    const artifact = {
      ...plan,
      stagedPath: `gate-stage:${plan.operationId}:${plan.artifactKey}`,
      artifactKind: 'review-doc' as const,
      state: 'consumed' as const,
      receiptJson: JSON.stringify({
        ...JSON.parse(staged),
        stagedPath: 'runs/.human-gate-staging/legacy-review-op/doc.md',
      }),
      updatedAt: 1,
    }
    await selection().store.finalizeReviewArtifact(artifact)
    const corrupt = JSON.parse(staged)
    corrupt.object.sha256 = 'f'.repeat(64)
    await expect(
      selection().store.finalizeReviewArtifact({
        ...artifact,
        receiptJson: JSON.stringify(corrupt),
      }),
    ).rejects.toMatchObject({ code: 'human-gate-artifact-digest-mismatch' })
  })

  test('cold cleanup releases a lost pin receipt from the durable declaration without the original body', async () => {
    const { f, settle, selection } = setup()
    const plan = selection().store.planReviewArtifact({
      operationId: 'lost-review-pin',
      artifactKey: 'doc',
      finalPath: 'runs/task/review/v1.md',
      body: 'retained original review',
    })
    f.losePinReply()
    await expect(
      selection().store.stageReviewArtifact(plan, 'retained original review'),
    ).rejects.toThrow('pin reply lost')
    const artifact = {
      ...plan,
      artifactKind: 'review-doc' as const,
      state: 'declared' as const,
      receiptJson: null,
      updatedAt: 0,
    }
    await selection().store.cleanupReviewArtifact(artifact)
    await selection().store.cleanupReviewArtifact(artifact)
    expect(await settle()).toMatchObject({ released: 1 })
    expect(f.pins).toHaveLength(1)
    expect(f.releases).toEqual(f.pins)
  })

  test('cleanup without uploaded bytes invents no content, and an unknown outcome stays retryable', async () => {
    const unavailable = objectFixture()
    const { f, settle, selection } = setup({
      ...unavailable,
      objects: {
        ...unavailable.objects,
        resolve: async () => {
          throw new Error('unknown remote outcome')
        },
      },
    })
    const plan = selection().store.planReviewArtifact({
      operationId: 'unstarted-review-pin',
      artifactKey: 'doc',
      finalPath: 'runs/task/review/v1.md',
      body: 'not uploaded',
    })
    // The declaration precedes the put: an interrupted upload left only its facts.
    const key = hostedReviewPublicationKey(plan)
    const { contentPublications } = tablesOf(harness.db)
    await insertOne(harness.db, contentPublications, {
      id: hostedPublicationId(HOSTED_REVIEW_OWNER, key),
      owner: HOSTED_REVIEW_OWNER,
      logicalKey: key,
      scope: 'task',
      attempt: 'attempt',
      state: 'pending',
      sha256: plan.sha256,
      size: plan.byteSize,
      epoch: 1,
      createdAt: 0,
      updatedAt: 0,
    })
    await selection().store.cleanupReviewArtifact({
      ...plan,
      artifactKind: 'review-doc' as const,
      state: 'declared' as const,
      receiptJson: null,
      updatedAt: 0,
    })
    expect(await settle()).toMatchObject({ failures: 1, released: 0 })
    expect(f.pins).toEqual([])
    expect(f.releases).toEqual([])
  })

  test('dispatch, cold reader, comments and recovery use pinned objects without an app-home file', async () => {
    const db = harness.db
    const f = objectFixture()
    const id = ulid()
    const appHome = `/unavailable/rfc370-review-${id}`
    const bodies = ['# First\n\nreview body', '# Second\n\n审阅正文']
    const { docVersions, collaborationGateArtifacts } = tablesOf(db)
    await agentFixture(db, {
      id,
      name: id,
      description: '',
      bodyMd: '',
      permission: '{}',
      skills: '[]',
      outputs: '["docs"]',
      frontmatterExtra: '{"outputKinds":{"docs":"list<markdown>"}}',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      edges: [],
      nodes: [
        {
          id: 'source',
          kind: 'agent-single',
          agentId: id,
          agentName: id,
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'review',
          kind: 'review',
          inputSource: { nodeId: 'source', portName: 'docs' },
        } as unknown as WorkflowNode,
      ],
    }
    await workflowFixture(db, {
      id,
      name: id,
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    await taskFixture(db, {
      id,
      name: id,
      workflowId: id,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: 'cs-workspace:repo',
      worktreePath: 'cs-workspace:repo',
      baseBranch: 'main',
      branch: `task/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: id,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
      ]),
    })
    await nodeRunFixture(db, {
      id,
      taskId: id,
      nodeId: 'source',
      status: 'done',
      iteration: 0,
      startedAt: 1,
      finishedAt: 2,
    })
    await nodeRunOutputFixture(db, {
      nodeRunId: id,
      portName: 'docs',
      content: joinMarkdownDocs(bodies),
    })
    const { journal } = setup(f)
    const first = composeCrewStationReviewArtifacts({
      db,
      objects: f.objects,
      publications: journal.publications,
    })
    let failFinalization = true
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{
        upstreamAgents: o2Ports(db).upstreamAgents,
        ...{
          reviewArtifacts: {
            ...first,
            store: {
              ...first.store,
              async finalizeReviewArtifact(artifact) {
                if (failFinalization) throw new Error('simulated restart after gate commit')
                return first.store.finalizeReviewArtifact(artifact)
              },
            },
          },
        },
      },
    })
    expect(
      (
        await mechanics.dispatchReviewNode({
          taskId: id,
          appHome,
          definition,
          node: definition.nodes[1]!,
          iteration: 0,
          scopeRoot: 'cs-workspace:repo',
        })
      ).kind,
    ).toBe('awaiting_review')
    const docs = await db.select().from(docVersions).where(eq(docVersions.taskId, id))
    expect(docs).toHaveLength(2)
    const second = composeCrewStationReviewArtifacts({
      db,
      objects: f.objects,
      publications: journal.publications,
    })
    const reader = new DatabaseCommittedReviewArtifactReader(
      db,
      second.content,
      createContentStore({
        db,
        policy: { inlineMaxBytes: 0, externalKind: 'object' },
        transports: { object: createObjectContentTransport(f.objects) },
      }),
    )
    expect(
      await Promise.all(
        docs
          .sort((a, b) => a.itemIndex! - b.itemIndex!)
          .map((doc) => reader.read(rowToDocVersion(doc).bodyPath)),
      ),
    ).toEqual(bodies)
    const routes = createCollaborationRouteOperations(
      withO2Closure({
        db,
        reviewReader: reader,
        clarifyDraftEvents: { publish: async () => undefined },
      }),
    )
    const detail = await routes.reviews.versionDetail({
      appHome,
      nodeRunId: docs[0]!.reviewNodeRunId,
      versionId: docs[0]!.id,
    })
    expect(detail?.body).toBe(bodies[0])
    await routes.reviews.addComment({
      appHome,
      nodeRunId: docs[0]!.reviewNodeRunId,
      docVersionId: docs[0]!.id,
      commentText: 'object-backed comment',
      author: 'reviewer',
      authorRole: 'owner',
      anchorRequest: {},
    })
    const rounds = await routes.reviews.listRounds({ appHome, nodeRunId: docs[0]!.reviewNodeRunId })
    expect(rounds[0]!.members[0]!.commentCount).toBe(1)
    failFinalization = false
    let authorityHeld = false
    const recovery = composeCrewStationHumanGateRecovery(
      withO2Closure({
        db,
        fence: {
          current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
          assertHeld: async () => {
            if (!authorityHeld) throw new Error('gate recovery lease lost')
          },
        },
        artifacts: second.store,
        now: () => Date.now() + 60_000,
      }),
    )
    await expect(recovery.runOnce()).rejects.toThrow('gate recovery lease lost')
    authorityHeld = true
    expect((await recovery.runOnce()).finalized).toBe(1)
    const gateArtifacts = await db.select().from(collaborationGateArtifacts)
    expect(gateArtifacts.every((artifact) => artifact.state === 'finalized')).toBe(true)
    f.tamper('body')
    await expect(reader.read(rowToDocVersion(docs[0]!).bodyPath)).rejects.toMatchObject({
      code: 'human-gate-artifact-digest-mismatch',
    })
  })

  test('uncommitted content stays hidden; cleanup releases only its own object pin', async () => {
    const { f, settle, selection: compose } = setup()
    const selection = compose()
    const plan = selection.store.planReviewArtifact({
      operationId: 'pending-review',
      artifactKey: 'doc',
      finalPath: 'runs/task/review/v1.md',
      body: 'private until commit',
    })
    const receiptJson = await selection.store.stageReviewArtifact(plan, 'private until commit')
    expect(await selection.content.read(plan.finalPath)).toBeNull()
    const artifact = {
      ...plan,
      artifactKind: 'review-doc' as const,
      state: 'staged' as const,
      receiptJson,
      updatedAt: 0,
    }
    await selection.store.cleanupReviewArtifact(artifact)
    expect(f.releases).toEqual([])
    await settle()
    expect(f.releases).toEqual(f.pins)
    await expect(
      selection.store.cleanupReviewArtifact({ ...artifact, state: 'consumed' }),
    ).rejects.toThrow('committed-artifact-cleanup-refused')
    const { collaborationGateOperations } = tablesOf(harness.db)
    expect(await harness.db.select().from(collaborationGateOperations)).toHaveLength(0)
    await expect(selection.store.stageReviewArtifact(plan, 'changed')).rejects.toThrow(
      'changed after planning',
    )
  })

  test('the collaboration sweep releases review documents of tasks without gate operations', async () => {
    const { journal, selection } = setup()
    const live = ulid()
    const { collaborationGateOperations } = tablesOf(harness.db)
    const { contentPublications } = tablesOf(harness.db)
    await workflowFixture(harness.db, {
      id: live,
      name: live,
      description: '',
      definition: '{}',
      version: 1,
    })
    await taskFixture(harness.db, {
      id: live,
      name: live,
      workflowId: live,
      workflowSnapshot: '{}',
      repoPath: 'cs-workspace:repo',
      worktreePath: 'cs-workspace:repo',
      baseBranch: 'main',
      branch: `task/${live}`,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: 1,
    })
    await insertOne(harness.db, collaborationGateOperations, {
      id: `op-${live}`,
      taskId: live,
      gateKind: 'review',
      operationKind: 'open',
      gateRef: 'review',
      idempotencyKey: 'open',
      requestHash: 'd'.repeat(64),
      expectedTaskRevision: 0,
      expectedGateRevision: 0,
      // A completed open carries its committed receipt (0212 CHECK).
      state: 'completed',
      resultGateRevision: 1,
      receiptJson: '{}',
      createdAt: 1,
      updatedAt: 1,
      committedAt: 1,
      completedAt: 1,
    })
    for (const [operationId, taskId] of [
      [`op-${live}`, live],
      ['op-gone', 'deleted-task'],
    ] as const) {
      const plan = selection().store.planReviewArtifact({
        operationId,
        artifactKey: 'doc',
        finalPath: `runs/${taskId}/review/v1.md`,
        body: `review of ${taskId}`,
      })
      await selection().store.stageReviewArtifact(plan, `review of ${taskId}`)
    }
    const sweep = composeCrewStationReviewObjectSweep({
      db: harness.db,
      publications: journal.publications,
      graceMs: -1,
    })
    expect(await sweep.sweep({ now: Date.now() })).toBe(1)
    const states = new Map(
      (
        await harness.db
          .select()
          .from(contentPublications)
          .where(eq(contentPublications.owner, HOSTED_REVIEW_OWNER))
      ).map((row) => [row.scope, row.state] as const),
    )
    expect(states.get(live)).toBe('ready')
    expect(states.get('deleted-task')).toBe('releasing')
  })
})
