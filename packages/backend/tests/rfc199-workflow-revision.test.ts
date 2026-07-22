// RFC-199 B1 regression locks.
// Workflow saves and deletes are full-snapshot, actor-aware CAS operations:
// two edits from one base cannot share a successor revision, retries reconcile
// by canonical bytes, and legacy physical storage heals exactly once.

import {
  serializeWorkflowDefinitionStorageV1,
  type SaveWorkflowReceipt,
  type WorkflowDefinition,
  type WorkflowDetail,
  type WorkflowDraftSnapshot,
  type WorkflowsWsMessage,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, users, workflows } from '../src/db/schema'
import { AGENT_HOST_WORKFLOW_ID, ensureAgentHostWorkflow } from '../src/services/agentLaunch'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  migrateDefinitionToLatest,
  updateWorkflow,
  workflowDraftSnapshotOf,
  workflowSnapshotHashOf,
  type WorkflowWritePrincipal,
} from '../src/services/workflow'
import { DomainError } from '../src/util/errors'
import {
  ensureWorkgroupHostWorkflow,
  WORKGROUP_HOST_WORKFLOW_ID,
} from '../src/services/workgroup/launch'
import {
  resetBroadcastersForTests,
  WORKFLOWS_CHANNEL,
  workflowsBroadcaster,
} from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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
  db: DbClient,
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

describe('RFC-199 workflow revision fencing', () => {
  test('create stores canonical latest definition and returns a derived detail hash', async () => {
    const db = createInMemoryDb(MIGRATIONS)
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
      await db
        .select({ definition: workflows.definition })
        .from(workflows)
        .where(eq(workflows.id, workflow.id))
    )[0]
    expect(raw?.definition).toBe(
      serializeWorkflowDefinitionStorageV1(migrateDefinitionToLatest(legacy)),
    )
    expect(workflow.snapshotHash).toBe(workflowSnapshotHashOf(workflowDraftSnapshotOf(workflow)))
    expect(workflow.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('fixed agent/workgroup host seeds use the same canonical latest storage', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await ensureAgentHostWorkflow(db)
    await ensureWorkgroupHostWorkflow(db)

    const rows = await db
      .select({ id: workflows.id, definition: workflows.definition })
      .from(workflows)
    const byId = new Map(rows.map((row) => [row.id, row.definition]))
    const expected = serializeWorkflowDefinitionStorageV1(EMPTY_DEFINITION)
    expect(byId.get(AGENT_HOST_WORKFLOW_ID)).toBe(expected)
    expect(byId.get(WORKGROUP_HOST_WORKFLOW_ID)).toBe(expected)
  })

  test('two writers from the same base produce one owned receipt and one conflict', async () => {
    const db = createInMemoryDb(MIGRATIONS)
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
    expect(codeOf(rejected[0]?.reason)).toBe('workflow-version-conflict')
    const current = await getWorkflow(db, workflow.id)
    expect(current?.version).toBe(2)
    expect(current?.description).toBe(winner.value.snapshot.description)
  })

  test('logical no-op and stale exact retry do not bump or broadcast', async () => {
    resetBroadcastersForTests()
    const db = createInMemoryDb(MIGRATIONS)
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
    const db = createInMemoryDb(MIGRATIONS)
    const id = ulid()
    const legacy: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [],
      edges: [],
    }
    await db.insert(workflows).values({
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
      await db
        .select({ definition: workflows.definition })
        .from(workflows)
        .where(eq(workflows.id, id))
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
    const db = createInMemoryDb(MIGRATIONS)
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
      expect(codeOf(error)).toBe('workflow-version-conflict')
      expect((error as DomainError).details).toEqual({ current: winner.revision })
    }
    expect((await getWorkflow(db, workflow.id))?.description).toBe('winner')
  })

  test('current visibility precedes builtin/owner and current owner is rechecked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const alice = actorPrincipal('alice')
    const bob = actorPrincipal('bob')
    const workflow = await createWorkflow(
      db,
      { name: 'acl-fence', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: 'alice' },
    )
    await db.update(workflows).set({ visibility: 'private' }).where(eq(workflows.id, workflow.id))

    await expect(
      save(db, workflow, snapshot(workflow, { description: 'hidden' }), { principal: bob }),
    ).rejects.toMatchObject({ code: 'workflow-not-found', status: 404 })

    await db
      .update(workflows)
      .set({ visibility: 'public', ownerUserId: 'bob' })
      .where(eq(workflows.id, workflow.id))
    await expect(
      save(db, workflow, snapshot(workflow, { description: 'stale-owner' }), {
        principal: alice,
      }),
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })

    await db.update(workflows).set({ builtin: true }).where(eq(workflows.id, workflow.id))
    await expect(
      save(db, workflow, snapshot(workflow, { description: 'system-write' }), {
        principal: SYSTEM,
      }),
    ).rejects.toMatchObject({ code: 'builtin-readonly', status: 403 })
    expect((await getWorkflow(db, workflow.id))?.version).toBe(1)
  })

  test('changed legacy name is gated while an unchanged legacy name may heal/save', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await createWorkflow(db, {
      name: 'Legacy Name With Spaces',
      description: '',
      definition: EMPTY_DEFINITION,
    })
    const sameName = await save(db, workflow, snapshot(workflow, { description: 'allowed' }))
    expect(sameName.outcome).toBe('committed')

    const current = await getWorkflow(db, workflow.id)
    if (current === null) throw new Error('workflow missing')
    await expect(
      save(db, current, snapshot(current, { name: 'Another Bad Name' })),
    ).rejects.toMatchObject({ code: 'workflow-name-invalid', status: 422 })
    expect((await getWorkflow(db, workflow.id))?.version).toBe(2)
  })

  test('new-reference preflight failure leaves editable bytes and version untouched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const alice = actorPrincipal('alice')
    const workflow = await createWorkflow(
      db,
      { name: 'reference-preflight', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: 'alice' },
    )
    await db.insert(agents).values({
      id: ulid(),
      name: 'secret-agent',
      ownerUserId: 'carol',
      visibility: 'private',
    })
    const nextDefinition: WorkflowDefinition = {
      ...EMPTY_DEFINITION,
      nodes: [{ id: 'worker', kind: 'agent-single', agentName: 'secret-agent' }],
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
    const db = createInMemoryDb(MIGRATIONS)
    const alice = actorPrincipal('alice')
    const bob = actorPrincipal('bob')
    const workflow = await createWorkflow(
      db,
      { name: 'delete-acl', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: 'alice' },
    )
    const fence = () => ({ expectedVersion: 1, clientMutationId: ulid() })

    await db.update(workflows).set({ visibility: 'private' }).where(eq(workflows.id, workflow.id))
    await expect(deleteWorkflow(db, workflow.id, fence(), bob)).rejects.toMatchObject({
      code: 'workflow-not-found',
      status: 404,
    })

    await db.update(workflows).set({ visibility: 'public' }).where(eq(workflows.id, workflow.id))
    await expect(deleteWorkflow(db, workflow.id, fence(), bob)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    })

    // Simulate an owner transfer after an earlier route/detail read: the old
    // owner remains visible but must fail the service's current-row owner gate.
    await db.update(workflows).set({ ownerUserId: 'bob' }).where(eq(workflows.id, workflow.id))
    await expect(deleteWorkflow(db, workflow.id, fence(), alice)).rejects.toMatchObject({
      code: 'forbidden',
      status: 403,
    })

    await db.update(workflows).set({ builtin: true }).where(eq(workflows.id, workflow.id))
    await expect(deleteWorkflow(db, workflow.id, fence(), SYSTEM)).rejects.toMatchObject({
      code: 'builtin-readonly',
      status: 403,
    })
    expect((await getWorkflow(db, workflow.id))?.version).toBe(1)
  })

  test('delete is version-fenced, reference-checked, and broadcasts the winning fence', async () => {
    resetBroadcastersForTests()
    const db = createInMemoryDb(MIGRATIONS)
    const alice = actorPrincipal('alice')
    await db.insert(users).values({
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
    ).rejects.toMatchObject({ code: 'workflow-version-conflict', status: 409 })
    expect(await getWorkflow(db, workflow.id)).not.toBeNull()

    await db.insert(tasks).values({
      id: ulid(),
      name: 'delete-blocker',
      workflowId: workflow.id,
      workflowSnapshot: serializeWorkflowDefinitionStorageV1(EMPTY_DEFINITION),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/worktree',
      baseBranch: 'main',
      branch: 'agent-workflow/delete-blocker',
      status: 'done',
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

    await db.delete(tasks).where(eq(tasks.workflowId, workflow.id))
    const mutationId = ulid()
    await deleteWorkflow(
      db,
      workflow.id,
      { expectedVersion: committed.revision.version, clientMutationId: mutationId },
      alice,
    )
    expect(await getWorkflow(db, workflow.id)).toBeNull()
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
