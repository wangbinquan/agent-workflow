import { deleteWorkflow } from './helpers/resourceCatalogDeletion'
// RFC-199 B1 regression locks.
// Workflow saves and deletes are full-snapshot, actor-aware CAS operations:
// two edits from one base cannot share a successor revision, retries reconcile
// by canonical bytes, and legacy physical storage heals exactly once.

import { buildAgentHostSnapshot } from '@/services/agentLaunch'
// RFC-395 II-a: exercise the surviving production builders and constant leaf.
import { buildWorkgroupHostSnapshot } from '@/modules/task-execution/infrastructure/workgroupRuntimeConfig'
import { TASK_DEFINITION_HOSTS } from '@/modules/task-execution/public/queries'
import {
  agentFixture,
  patchTaskFixture,
  patchWorkflowFixture,
  readTaskFixtures,
  readWorkflowFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  serializeWorkflowDefinitionStorageV1,
  WorkflowDefinitionSchema,
  WORKFLOW_SCHEMA_VERSION,
  type SaveWorkflowReceipt,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowDraftSnapshot,
  type WorkflowsWsMessage,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { getTask } from '../src/services/task'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createWorkflow,
  getWorkflow,
  migrateDefinitionToLatest,
  updateWorkflow,
  workflowDraftSnapshotOf,
  workflowSnapshotHashOf,
  type WorkflowWritePrincipal,
} from '../src/services/workflow'
import { DomainError } from '../src/util/errors'
import { describeEachProvider } from './helpers/eachProvider'
import {
  resetBroadcastersForTests,
  WORKFLOWS_CHANNEL,
  workflowsBroadcaster,
} from '../src/ws/broadcaster'

const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}

const SYSTEM: WorkflowWritePrincipal = { kind: 'system', reason: 'rfc199-test' }

function actorPrincipal(id: string, role: 'admin' | 'user' = 'user'): WorkflowWritePrincipal {
  return {
    kind: 'actor',
    actor: buildActor({
      source: 'session',
      user: {
        id,
        username: id,
        displayName: id,
        role,
        status: 'active',
      },
    }),
  }
}

function snapshot(
  workflow: WorkflowDetail,
  patch: Partial<WorkflowDraftSnapshot> = {},
): WorkflowDraftSnapshot {
  return { ...workflowDraftSnapshotOf(workflow), ...patch }
}

function save(
  db: PersistenceDb,
  workflow: WorkflowDetail,
  next: WorkflowDraftSnapshot,
  opts: {
    expectedVersion?: number
    principal?: WorkflowWritePrincipal
    clientMutationId?: string
  } = {},
): Promise<SaveWorkflowReceipt> {
  return updateWorkflow(
    db,
    workflow.id,
    {
      expectedVersion: opts.expectedVersion ?? workflow.version,
      clientMutationId: opts.clientMutationId ?? ulid(),
      snapshot: next,
    },
    opts.principal ?? SYSTEM,
  )
}

function codeOf(reason: unknown): string | undefined {
  return reason instanceof DomainError ? reason.code : undefined
}

describeEachProvider('RFC-199 workflow revision fencing', (harness) => {
  describe('canonical storage', () => {
    test('create stores canonical latest definition and returns a derived detail hash', async () => {
      const db = harness.db
      const legacy: WorkflowDefinition = {
        $schema_version: 1,
        inputs: [],
        nodes: [],
        edges: [],
      }
      const workflow = await createWorkflow(db, {
        name: 'canonical-create',
        description: '',
        definition: legacy,
      })

      const raw = (
        await readWorkflowFixtures(db, { id: workflow.id }).then((rows) =>
          rows.map((row) => ({ definition: row.definition })),
        )
      )[0]
      expect(raw?.definition).toBe(
        serializeWorkflowDefinitionStorageV1(migrateDefinitionToLatest(legacy)),
      )
      expect(workflow.snapshotHash).toBe(workflowSnapshotHashOf(workflowDraftSnapshotOf(workflow)))
      expect(workflow.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('revision writes', () => {
    test('two writers from the same base produce one owned receipt and one conflict', async () => {
      const db = harness.db
      const workflow = await createWorkflow(db, {
        name: 'revision-race',
        description: '',
        definition: EMPTY_DEFINITION,
      })

      const results = await Promise.allSettled([
        save(db, workflow, snapshot(workflow, { description: 'writer-a' })),
        save(db, workflow, snapshot(workflow, { description: 'writer-b' })),
      ])
      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<SaveWorkflowReceipt> =>
          result.status === 'fulfilled',
      )
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      )

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      const winner = fulfilled[0]
      if (winner === undefined) throw new Error('missing winning writer')
      expect(winner.value.outcome).toBe('committed')
      expect(winner.value.revision.version).toBe(2)
      expect(['writer-a', 'writer-b']).toContain(winner.value.snapshot.description)
      expect(codeOf(rejected[0]?.reason)).toBe('resource-operation-stale')
      const current = await getWorkflow(db, workflow.id)
      expect(current?.version).toBe(2)
      expect(current?.description).toBe(winner.value.snapshot.description)
    })

    test('logical no-op and stale exact retry do not bump or broadcast', async () => {
      resetBroadcastersForTests()
      const db = harness.db
      const workflow = await createWorkflow(db, {
        name: 'retry-reconcile',
        description: '',
        definition: EMPTY_DEFINITION,
      })
      const frames: WorkflowsWsMessage[] = []
      const unsubscribe = workflowsBroadcaster.subscribe(WORKFLOWS_CHANNEL, (frame) =>
        frames.push(frame),
      )

      const noOp = await save(db, workflow, snapshot(workflow))
      expect(noOp.outcome).toBe('already-current')
      expect(noOp.revision.version).toBe(1)
      expect(frames).toHaveLength(0)

      const submitted = snapshot(workflow, { description: 'committed-once' })
      const committed = await save(db, workflow, submitted)
      expect(committed.outcome).toBe('committed')
      expect(committed.revision.version).toBe(2)
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({
        type: 'workflow.updated',
        clientMutationId: committed.clientMutationId,
        version: 2,
        snapshotHash: committed.revision.snapshotHash,
      })

      const retry = await save(db, workflow, submitted, { expectedVersion: 1 })
      expect(retry.outcome).toBe('already-current')
      expect(retry.revision).toEqual(committed.revision)
      expect(frames).toHaveLength(1)
      unsubscribe()
    })

    test('same logical snapshot heals legacy/noncanonical storage exactly once', async () => {
      resetBroadcastersForTests()
      const db = harness.db
      const id = ulid()
      const legacy: WorkflowDefinition = {
        $schema_version: 1,
        inputs: [],
        nodes: [],
        edges: [],
      }
      await workflowFixture(db, {
        id,
        name: 'legacy-heal',
        description: '',
        definition: JSON.stringify(legacy, null, 2),
        version: 1,
      })
      const visible = await getWorkflow(db, id)
      if (visible === null) throw new Error('legacy workflow missing')

      const frames: WorkflowsWsMessage[] = []
      const unsubscribe = workflowsBroadcaster.subscribe(WORKFLOWS_CHANNEL, (frame) =>
        frames.push(frame),
      )
      const healed = await save(db, visible, snapshot(visible))
      expect(healed.outcome).toBe('committed')
      expect(healed.revision.version).toBe(2)
      const raw = (
        await readWorkflowFixtures(db, { id }).then((rows) =>
          rows.map((row) => ({ definition: row.definition })),
        )
      )[0]
      expect(raw?.definition).toBe(
        serializeWorkflowDefinitionStorageV1(migrateDefinitionToLatest(legacy)),
      )

      const afterHeal = await getWorkflow(db, id)
      if (afterHeal === null) throw new Error('healed workflow missing')
      const noOp = await save(db, afterHeal, snapshot(afterHeal))
      expect(noOp.outcome).toBe('already-current')
      expect(noOp.revision.version).toBe(2)
      expect(frames.filter((frame) => frame.type === 'workflow.updated')).toHaveLength(1)
      unsubscribe()
    })

    test('stale different bytes return current revision and preserve the winner', async () => {
      const db = harness.db
      const workflow = await createWorkflow(db, {
        name: 'stale-conflict',
        description: '',
        definition: EMPTY_DEFINITION,
      })
      const winner = await save(db, workflow, snapshot(workflow, { description: 'winner' }))

      try {
        await save(db, workflow, snapshot(workflow, { description: 'loser' }), {
          expectedVersion: 1,
        })
        throw new Error('expected conflict')
      } catch (error) {
        expect(codeOf(error)).toBe('resource-operation-stale')
        // RFC-285 B5：details 增 resource 字段（staleConflictError 统一形态）。
        expect((error as DomainError).details).toEqual({
          resource: 'workflow',
          current: winner.revision,
        })
      }
      expect((await getWorkflow(db, workflow.id))?.description).toBe('winner')
    })
  })

  test('current visibility precedes builtin/owner and current owner is rechecked', async () => {
    const db = harness.db
    const alice = actorPrincipal('alice')
    const bob = actorPrincipal('bob')
    const workflow = await createWorkflow(
      db,
      { name: 'acl-fence', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: 'alice' },
    )
    await patchWorkflowFixture(db, { id: workflow.id }, { visibility: 'private' })

    await expect(
      save(db, workflow, snapshot(workflow, { description: 'hidden' }), { principal: bob }),
    ).rejects.toMatchObject({ code: 'workflow-not-found', status: 404 })

    await patchWorkflowFixture(
      db,
      { id: workflow.id },
      { visibility: 'public', ownerUserId: 'bob' },
    )
    await expect(
      save(db, workflow, snapshot(workflow, { description: 'stale-owner' }), {
        principal: alice,
      }),
      // RFC-324 把 `forbidden` 拆成可分辨的两个码：这里是**内容写**被拒，
      // 前任 owner 对这份 public 工作流只剩只读 —— `resource-read-only`。
    ).rejects.toMatchObject({ code: 'resource-read-only', status: 403 })

    await patchWorkflowFixture(db, { id: workflow.id }, { builtin: true })
    await expect(
      save(db, workflow, snapshot(workflow, { description: 'system-write' }), {
        principal: SYSTEM,
      }),
    ).rejects.toMatchObject({ code: 'builtin-readonly', status: 403 })
    expect((await getWorkflow(db, workflow.id))?.version).toBe(1)
  })

  test('changed legacy name is gated while an unchanged legacy name may heal/save', async () => {
    const db = harness.db
    const workflow = await createWorkflow(db, {
      name: 'Legacy Name With Spaces',
      description: '',
      definition: EMPTY_DEFINITION,
    })
    const sameName = await save(db, workflow, snapshot(workflow, { description: 'allowed' }))
    expect(sameName.outcome).toBe('committed')

    const current = await getWorkflow(db, workflow.id)
    if (current === null) throw new Error('workflow missing')
    // RFC-264 RE-JUDGEMENT: 'Another Bad Name' is legal under the current
    // shared rule, so the illegal fixture becomes a reserved `_` prefix. The
    // invariant is unchanged — a CHANGED name is gated and the gate leaves the
    // version untouched.
    await expect(save(db, current, snapshot(current, { name: '_reserved' }))).rejects.toMatchObject(
      { code: 'workflow-name-invalid', status: 422 },
    )
    expect((await getWorkflow(db, workflow.id))?.version).toBe(2)
  })

  test('new-reference preflight failure leaves editable bytes and version untouched', async () => {
    const db = harness.db
    const alice = actorPrincipal('alice')
    const workflow = await createWorkflow(
      db,
      { name: 'reference-preflight', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: 'alice' },
    )
    const secretAgentId = ulid()
    await agentFixture(db, {
      id: secretAgentId,
      name: 'secret-agent',
      ownerUserId: 'carol',
      visibility: 'private',
    })
    const nextDefinition: WorkflowDefinition = {
      ...EMPTY_DEFINITION,
      nodes: [
        {
          id: 'worker',
          kind: 'agent-single',
          agentId: secretAgentId,
          agentName: 'secret-agent',
        },
      ],
    }

    await expect(
      save(
        db,
        workflow,
        snapshot(workflow, { description: 'must-not-land', definition: nextDefinition }),
        { principal: alice },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs', status: 422 })
    const after = await getWorkflow(db, workflow.id)
    expect(after?.version).toBe(1)
    expect(after?.description).toBe('')
    expect(after?.definition.nodes).toEqual([])
  })

  test('delete repeats current visibility, owner-transfer, and builtin gates in its transaction', async () => {
    const db = harness.db
    const alice = actorPrincipal('alice')
    const bob = actorPrincipal('bob')
    const workflow = await createWorkflow(
      db,
      { name: 'delete-acl', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: 'alice' },
    )
    const fence = () => ({ expectedVersion: 1, clientMutationId: ulid() })

    await patchWorkflowFixture(db, { id: workflow.id }, { visibility: 'private' })
    await expect(deleteWorkflow(db, workflow.id, fence(), bob)).rejects.toMatchObject({
      code: 'workflow-not-found',
      status: 404,
    })

    await patchWorkflowFixture(db, { id: workflow.id }, { visibility: 'public' })
    await expect(deleteWorkflow(db, workflow.id, fence(), bob)).rejects.toMatchObject({
      // 删除是**治理写**：RFC-324 的可编辑档也不覆盖它，只有 owner（与 bypass）能删。
      code: 'resource-govern-owner-only',
      status: 403,
    })

    // Simulate an owner transfer after an earlier route/detail read: the old
    // owner remains visible but must fail the service's current-row owner gate.
    await patchWorkflowFixture(db, { id: workflow.id }, { ownerUserId: 'bob' })
    await expect(deleteWorkflow(db, workflow.id, fence(), alice)).rejects.toMatchObject({
      code: 'resource-govern-owner-only',
      status: 403,
    })

    await patchWorkflowFixture(db, { id: workflow.id }, { builtin: true })
    await expect(deleteWorkflow(db, workflow.id, fence(), SYSTEM)).rejects.toMatchObject({
      code: 'builtin-readonly',
      status: 403,
    })
    expect((await getWorkflow(db, workflow.id))?.version).toBe(1)
  })

  test('delete is version-fenced, reference-checked, and broadcasts the winning fence', async () => {
    resetBroadcastersForTests()
    const db = harness.db
    const alice = actorPrincipal('alice')
    const { users } = tablesOf(db)
    await insertOne(db, users, {
      id: 'carol',
      username: 'carol',
      email: 'carol@example.com',
      displayName: 'Carol',
      passwordHash: null,
      role: 'user',
      status: 'active',
      forcePasswordChange: false,
      createdBy: null,
      createdAt: 0,
      updatedAt: 0,
      lastLoginAt: null,
      schemaVersion: 1,
    })
    const workflow = await createWorkflow(
      db,
      {
        name: 'delete-fence',
        description: '',
        definition: EMPTY_DEFINITION,
      },
      { ownerUserId: 'alice' },
    )
    const committed = await save(db, workflow, snapshot(workflow, { description: 'v2' }))
    const frames: WorkflowsWsMessage[] = []
    const unsubscribe = workflowsBroadcaster.subscribe(WORKFLOWS_CHANNEL, (frame) =>
      frames.push(frame),
    )

    await expect(
      deleteWorkflow(db, workflow.id, { expectedVersion: 1, clientMutationId: ulid() }, alice),
    ).rejects.toMatchObject({ code: 'resource-operation-stale', status: 409 })
    expect(await getWorkflow(db, workflow.id)).not.toBeNull()

    await taskFixture(db, {
      id: ulid(),
      name: 'delete-blocker',
      workflowId: workflow.id,
      workflowSnapshot: serializeWorkflowDefinitionStorageV1(EMPTY_DEFINITION),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/delete-blocker',
      // RFC-285 B2：非终态引用才阻删（旧版 done 也阻——中档统一后 done 放行）。
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: 'carol',
    })
    try {
      await deleteWorkflow(
        db,
        workflow.id,
        { expectedVersion: committed.revision.version, clientMutationId: ulid() },
        alice,
      )
      throw new Error('expected workflow-in-use')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'workflow-in-use',
        status: 409,
        details: { referenceCount: 1 },
      })
      expect((error as DomainError).details).not.toHaveProperty('tasks')
    }
    expect(frames).toHaveLength(0)

    // RFC-285 B2 红→绿对：把引用翻成终态（不删行！）后删除成功——同时实证
    // tasks.workflow_id 软链化（0151）：带终态引用直删不再撞 FK，引用悬空由
    // 展示层容忍（E2）。
    await patchTaskFixture(db, { workflowId: workflow.id }, { status: 'done' })
    const mutationId = ulid()
    await deleteWorkflow(
      db,
      workflow.id,
      { expectedVersion: committed.revision.version, clientMutationId: mutationId },
      alice,
    )
    expect(await getWorkflow(db, workflow.id)).toBeNull()
    // 软链实证：终态任务行存活、workflow_id 悬空指向已删 workflow。
    const dangling = await readTaskFixtures(db, { workflowId: workflow.id })
    expect(dangling.length).toBe(1)
    expect(dangling[0]!.status).toBe('done')
    // 实现门路 1 P3-1 补穿透：详情读面（getTask 即 GET /api/tasks/:id 的
    // 服务源）对悬空引用不炸——leftJoin 让 workflowName 落 null，前端按
    // nullable 分支渲染（并非「无活取」，plan 实施记录已更正表述）。
    const detail = await getTask(db, dangling[0]!.id)
    expect(detail).not.toBeNull()
    expect(detail!.workflowName ?? null).toBeNull()
    expect(frames).toEqual([
      {
        type: 'workflow.deleted',
        workflowId: workflow.id,
        clientMutationId: mutationId,
        deletedVersion: committed.revision.version,
      },
    ])
    unsubscribe()
  })
})

// RFC-395 II-a A2: canonical synthesized definitions no longer seed the catalog.
describeEachProvider(
  'RFC-199 —— agent / workgroup 合成定义采用最新 schema 并保持序列化幂等',
  (harness) => {
    test('synthesized host definitions use the latest schema and serialize idempotently without catalog seeds', async () => {
      const db = harness.db
      const definitions = [
        buildAgentHostSnapshot({ id: 'agent', name: 'agent' }, false),
        buildWorkgroupHostSnapshot({
          workgroupId: 'group',
          workgroupName: 'Group',
          mode: 'free_collab',
          members: [],
          leaderMemberId: null,
          instructions: '',
          goal: '',
          switches: { shareOutputs: true, directMessages: false, blackboard: false },
          maxRounds: 3,
          completionGate: false,
        }),
      ]
      for (const definition of definitions) {
        const parsed = WorkflowDefinitionSchema.parse(definition)
        const canonical = serializeWorkflowDefinitionStorageV1(parsed)
        expect(serializeWorkflowDefinitionStorageV1(JSON.parse(canonical))).toBe(canonical)
        expect(JSON.parse(canonical).$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
      }
      const rows = await readWorkflowFixtures(db)
      for (const host of Object.values(TASK_DEFINITION_HOSTS))
        expect(rows.some((row) => row.id === host.id)).toBe(false)
    })
  },
)
