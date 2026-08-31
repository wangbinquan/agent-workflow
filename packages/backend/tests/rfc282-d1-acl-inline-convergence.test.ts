// RFC-282 D1 — behavior lock for the ACL-predicate convergence (设计门 P2-1).
//
// Locks the (visibility, error-code, throw-order) triple of the four inline
// ACL sites BEFORE they converge on the shared resourceAcl predicates, so the
// refactor is provably behavior-preserving:
//
//   1. scheduledTasks.ts private `canViewResourceInTx` (the ONE true copy —
//      it shadowed the shared export and supported only 3/6 types) →
//      replaced by the shared predicate. NULL-visibility note: the private
//      copy used strict `=== 'public'`, the shared one lenient
//      `(?? 'public')`; every ACL table declares `visibility` NOT NULL with a
//      'public' default (schema.ts), so the two are indistinguishable on any
//      row SQLite will ever return — no observable change.
//   2/3/4. agent.ts / workflow.ts / workgroups.ts write-path assertions keep
//      their local isAdmin/isOwner (reused for the 403 decision) and their
//      exact error-code order (resource-specific 404 → assertNotBuiltin →
//      403 → stale/version), only the `visible` sub-expression is shared.
//
// If any assertion here goes red after a refactor, the refactor changed
// user-visible ACL behavior — that is a bug per RFC-282 §0 (功能不受影响).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, users, workflows, workgroups } from '../src/db/schema'
import { createScheduledTaskWithIntegrationTriggerResources as createScheduledTask } from './helpers/integrationTriggerResourceBinding'
import { deleteAgent } from '../src/services/agent'
import { deleteWorkflow } from '../src/services/workflow'
import { deleteWorkgroup } from '../src/services/workgroups'
import { eq } from 'drizzle-orm'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const

function actorOf(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-6)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user' = 'user'): Promise<void> {
  await db.insert(users).values({
    id,
    username: `u-${id.slice(-6)}`,
    displayName: `U ${id.slice(-6)}`,
    role,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function grant(
  db: DbClient,
  type: 'agent' | 'workflow' | 'workgroup',
  resourceId: string,
  userId: string,
  ownerId: string,
): Promise<void> {
  await db.insert(resourceGrants).values({
    resourceType: type,
    resourceId,
    userId,
    addedBy: ownerId,
    addedAt: Date.now(),
  })
}

describe('RFC-282 D1 — scheduledTasks target-visibility triple (true-copy convergence)', () => {
  let db: DbClient
  const ownerId = ulid()
  const grantedId = ulid()
  const strangerId = ulid()
  const adminId = ulid()
  let wfId: string
  let agentId: string
  let wgId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    for (const [id, role] of [
      [ownerId, 'user'],
      [grantedId, 'user'],
      [strangerId, 'user'],
      [adminId, 'admin'],
    ] as const) {
      await seedUser(db, id, role)
    }
    wfId = ulid()
    await db.insert(workflows).values({
      id: wfId,
      name: `wf-${wfId.toLowerCase()}`,
      description: '',
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
      version: 1,
      ownerUserId: ownerId,
      visibility: 'private',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    agentId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: `ag-${agentId.toLowerCase()}`,
      ownerUserId: ownerId,
      visibility: 'private',
    })
    wgId = ulid()
    await db.insert(workgroups).values({
      id: wgId,
      name: `wg-${wgId.toLowerCase()}`,
      mode: 'free_collab',
      ownerUserId: ownerId,
      visibility: 'private',
    })
    await grant(db, 'workflow', wfId, grantedId, ownerId)
    await grant(db, 'agent', agentId, grantedId, ownerId)
    await grant(db, 'workgroup', wgId, grantedId, ownerId)
  })

  function createInput(kind: 'workflow' | 'agent' | 'workgroup') {
    const payload =
      kind === 'workflow'
        ? { workflowId: wfId, name: 't', inputs: {}, repoUrl: 'https://example.com/a.git' }
        : kind === 'agent'
          ? { agentId, name: 't', description: 'do it', scratch: true }
          : { workgroupId: wgId, name: 't', goal: 'do it', scratch: true }
    return {
      name: `sched-${ulid().toLowerCase()}`,
      launchKind: kind,
      launchPayload: payload,
      scheduleSpec: SPEC,
      enabled: false,
    }
  }

  const KINDS = [
    ['workflow', 'workflow-not-found'],
    ['agent', 'agent-not-found'],
    ['workgroup', 'workgroup-not-found'],
  ] as const

  for (const [kind, notFoundCode] of KINDS) {
    test(`${kind}: invisible target → 404 ${notFoundCode} (stranger)`, async () => {
      await expect(
        createScheduledTask(db, createInput(kind) as never, { actor: actorOf(strangerId) }),
      ).rejects.toMatchObject({ code: notFoundCode })
    })

    test(`${kind}: owner / granted / admin all pass the visibility gate`, async () => {
      for (const [id, role] of [
        [ownerId, 'user'],
        [grantedId, 'user'],
        [adminId, 'admin'],
      ] as const) {
        const created = await createScheduledTask(db, createInput(kind) as never, {
          actor: actorOf(id, role),
        })
        expect(created.id).toBeTruthy()
      }
    })
  }

  test('public target passes for a stranger (visibility, not ownership, gates create)', async () => {
    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, agentId))
    const created = await createScheduledTask(db, createInput('agent') as never, {
      actor: actorOf(strangerId),
    })
    expect(created.launchKind).toBe('agent')
  })
})

describe('RFC-282 D1 — write-path assertion triples (agent / workflow / workgroup)', () => {
  let db: DbClient
  const ownerId = ulid()
  const grantedId = ulid()
  const strangerId = ulid()
  let agentRow: { id: string; updatedAt: number; aclRevision: number }
  let wfId: string
  let wgId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    for (const id of [ownerId, grantedId, strangerId]) await seedUser(db, id)
    const aId = ulid()
    const now = Date.now()
    await db.insert(agents).values({
      id: aId,
      name: `ag-${aId.toLowerCase()}`,
      ownerUserId: ownerId,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    })
    const fresh = await db.select().from(agents).where(eq(agents.id, aId))
    agentRow = { id: aId, updatedAt: fresh[0]!.updatedAt, aclRevision: fresh[0]!.aclRevision }
    wfId = ulid()
    await db.insert(workflows).values({
      id: wfId,
      name: `wf-${wfId.toLowerCase()}`,
      description: '',
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
      version: 1,
      ownerUserId: ownerId,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    })
    wgId = ulid()
    await db.insert(workgroups).values({
      id: wgId,
      name: `wg-${wgId.toLowerCase()}`,
      mode: 'free_collab',
      ownerUserId: ownerId,
      visibility: 'private',
    })
    await grant(db, 'agent', agentRow.id, grantedId, ownerId)
    await grant(db, 'workflow', wfId, grantedId, ownerId)
    await grant(db, 'workgroup', wgId, grantedId, ownerId)
  })

  const fence = () => ({
    expectedUpdatedAt: agentRow.updatedAt,
    expectedAclRevision: agentRow.aclRevision,
  })

  test('agent: invisible → 404 agent-not-found (before any 403)', async () => {
    await expect(deleteAgent(db, agentRow.id, actorOf(strangerId), fence())).rejects.toMatchObject({
      code: 'agent-not-found',
    })
  })

  test('agent: visible-but-not-owner → 403 resource-govern-owner-only, even with a stale fence (403 precedes stale)', async () => {
    await expect(
      deleteAgent(db, agentRow.id, actorOf(grantedId), {
        expectedUpdatedAt: fence().expectedUpdatedAt + 999,
        expectedAclRevision: fence().expectedAclRevision,
      }),
      // RFC-324 —— 拒绝码从裸 `forbidden` 分流成治理档专用码。锁的东西没变：
      // 「看得见但不是 owner」在删除面必须 403，且 403 先于 stale。分流是为了让前端
      // 能把「你只有只读授权」与「可能已删除」讲成两句不同的话。
    ).rejects.toMatchObject({ code: 'resource-govern-owner-only' })
  })

  test('agent: owner with stale fence → resource-operation-stale (stale comes after the ACL gates)', async () => {
    await expect(
      deleteAgent(db, agentRow.id, actorOf(ownerId), {
        expectedUpdatedAt: fence().expectedUpdatedAt + 999,
        expectedAclRevision: fence().expectedAclRevision,
      }),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
  })

  test('workflow: invisible → 404 workflow-not-found', async () => {
    await expect(
      deleteWorkflow(
        db,
        wfId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(strangerId) },
      ),
    ).rejects.toMatchObject({ code: 'workflow-not-found' })
  })

  test('workflow: visible-but-not-owner → 403 resource-govern-owner-only (after builtin check position)', async () => {
    await expect(
      deleteWorkflow(
        db,
        wfId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(grantedId) },
      ),
      // RFC-324 —— 拒绝码从裸 `forbidden` 分流成治理档专用码。锁的东西没变：
      // 「看得见但不是 owner」在删除面必须 403，且 403 先于 stale。分流是为了让前端
      // 能把「你只有只读授权」与「可能已删除」讲成两句不同的话。
    ).rejects.toMatchObject({ code: 'resource-govern-owner-only' })
  })

  test('workflow: builtin outranks 403 — visible non-owner on a builtin row gets builtin-readonly', async () => {
    await db.update(workflows).set({ builtin: true }).where(eq(workflows.id, wfId))
    await expect(
      deleteWorkflow(
        db,
        wfId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(grantedId) },
      ),
    ).rejects.toMatchObject({ code: 'builtin-readonly' })
  })

  test('workflow: owner with wrong version → resource-operation-stale (order: ACL → builtin → version；RFC-285 B5 归一)', async () => {
    await expect(
      deleteWorkflow(
        db,
        wfId,
        { expectedVersion: 7, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
  })

  test('workgroup: invisible → 404 workgroup-not-found', async () => {
    await expect(
      deleteWorkgroup(
        db,
        wgId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(strangerId) },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-not-found' })
  })

  test('workgroup: visible-but-not-owner → 403 resource-govern-owner-only', async () => {
    await expect(
      deleteWorkgroup(
        db,
        wgId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(grantedId) },
      ),
      // RFC-324 —— 拒绝码从裸 `forbidden` 分流成治理档专用码。锁的东西没变：
      // 「看得见但不是 owner」在删除面必须 403，且 403 先于 stale。分流是为了让前端
      // 能把「你只有只读授权」与「可能已删除」讲成两句不同的话。
    ).rejects.toMatchObject({ code: 'resource-govern-owner-only' })
  })

  test('workgroup: owner with wrong version → resource-operation-stale（RFC-285 B5 归一）', async () => {
    await expect(
      deleteWorkgroup(
        db,
        wgId,
        { expectedVersion: 7, clientMutationId: ulid() },
        { kind: 'actor', actor: actorOf(ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'resource-operation-stale' })
  })
})
