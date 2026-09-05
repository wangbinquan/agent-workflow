// RFC-359 W4-D1 —— integration 触发器链的 dbTxSync 归零：定时任务持久化 + 触发器资源快照（resource-catalog 工厂 +
// digital-employee 参与者）合一，两个引擎各跑一遍：写事务里加载已授权快照、私有资源对外人 404、CAS 认领、
// 成功 / 失败记账与自动停用、ACL 原子替换与修订冲突、数字员工快照（归档 / 外人 → 404）。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  employeeDefinitionRevisions,
  employeeDefinitions,
  employeeTypePackages,
  scheduledTasks,
  users,
  workflows,
} from '@/db/schema'
import type { ScheduledTaskCreateRecord } from '@/modules/integration/application/ports/scheduledTaskPersistence'
import { createIntegrationTriggerResources } from '@/modules/integration/infrastructure/integrationTriggerResources'
import { createScheduledTaskPersistence } from '@/modules/integration/infrastructure/scheduledTaskPersistence'
import { composeIntegrationTriggerResourceSnapshotFactory } from '@/modules/resource-catalog/composition/integrationTrigger'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import { assertNotBuiltin } from '@/services/systemResources'
import { ConflictError, NotFoundError } from '@/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function seedUser(db: ProviderNeutralDatabase, id: string): Promise<Actor> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  })
  return {
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'http',
    permissions: new Set(['scheduled-tasks:read', 'resource-acl:private']),
  } as unknown as Actor
}

function pairOf(actor: Actor) {
  return Object.freeze({ authority: Object.freeze({}) as ResourceRequestContext, actor })
}

function record(id: string, ownerUserId: string): ScheduledTaskCreateRecord {
  return Object.freeze({
    id,
    name: `schedule ${id}`,
    ownerUserId,
    launchKind: 'workflow',
    launchPayload: '{}',
    scheduleSpec: '{"kind":"interval","everyMs":60000}',
    enabled: true,
    nextRunAt: NOW + 500,
    consecutiveFailures: 0,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describeEachProvider('RFC-359 W4-D1 —— 定时任务持久化 + 触发器资源快照链', (harness) => {
  test('写事务里加载已授权快照、私有资源对外人 404、CAS 认领、记账与自动停用、ACL 原子替换', async () => {
    const db = harness.db
    const owner = await seedUser(db, 'u_d1_owner')
    const stranger = await seedUser(db, 'u_d1_stranger')
    await db.insert(workflows).values([
      {
        id: 'wf-pub',
        name: 'public',
        description: '',
        definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        version: 3,
        schemaVersion: 2,
        ownerUserId: owner.user.id,
        visibility: 'public',
      },
      {
        id: 'wf-priv',
        name: 'private',
        description: '',
        definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
        version: 1,
        schemaVersion: 2,
        ownerUserId: owner.user.id,
        visibility: 'private',
      },
    ])
    const resources = createIntegrationTriggerResources(
      db,
      composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin }),
    )
    const persistence = createScheduledTaskPersistence(db, resources)

    // 快照在写事务里加载：finish 拿到的是冻结的 workflow 快照。
    const created = await persistence.createAtomically({
      record: record('sch-1', owner.user.id),
      authority: pairOf(owner),
      request: { kind: 'scheduled-workflow', workflowId: 'wf-priv' },
      finish: (snapshot) => ({
        ...record('sch-1', owner.user.id),
        launchPayload: JSON.stringify(
          snapshot.kind === 'scheduled-workflow'
            ? { workflowId: snapshot.workflow.id, version: snapshot.workflow.version }
            : { unexpected: snapshot.kind },
        ),
      }),
    })
    expect(JSON.parse(created.launchPayload)).toEqual({ workflowId: 'wf-priv', version: 1 })

    // 外人看不见私有 workflow：整个 create 事务回滚，没有半行留下。
    await expect(
      persistence.createAtomically({
        record: record('sch-2', stranger.user.id),
        authority: pairOf(stranger),
        request: { kind: 'scheduled-workflow', workflowId: 'wf-priv' },
        finish: (snapshot) => ({ ...record('sch-2', stranger.user.id), name: snapshot.kind }),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(await persistence.get('sch-2')).toBeNull()
    // 公开的就能用。
    await persistence.createAtomically({
      record: record('sch-2', stranger.user.id),
      authority: pairOf(stranger),
      request: { kind: 'scheduled-workflow', workflowId: 'wf-pub' },
      finish: (snapshot) => ({
        ...record('sch-2', stranger.user.id),
        name: snapshot.kind === 'scheduled-workflow' ? snapshot.workflow.name : '?',
      }),
    })
    expect((await persistence.get('sch-2'))?.name).toBe('public')
    expect((await persistence.list()).map((row) => row.id).sort()).toEqual(['sch-1', 'sch-2'])
    expect(await persistence.countVisible(owner)).toBe(1)

    // 原子更新：决策拿到最新行，可以重新加载一份快照。
    const updated = await persistence.updateAtomically({
      id: 'sch-1',
      authority: pairOf(owner),
      decide: (fresh) => ({
        request: { kind: 'scheduled-workflow', workflowId: 'wf-pub' },
        finish: (snapshot) => ({
          name: `${fresh.name} → ${snapshot?.kind === 'scheduled-workflow' ? snapshot.workflow.version : '?'}`,
          updatedAt: NOW + 1,
        }),
      }),
    })
    expect(updated.name).toBe('schedule sch-1 → 3')
    await expect(
      persistence.updateAtomically({
        id: 'missing',
        authority: pairOf(owner),
        decide: () => ({ request: null, finish: () => ({ updatedAt: NOW }) }),
      }),
    ).rejects.toBeInstanceOf(NotFoundError)

    // 认领是 CAS：同一次 nextRunAt 只能被认领一次。
    const claimed = await persistence.pollAndClaim({
      now: NOW + 1000,
      limit: 5,
      decide: (row) =>
        row.id === 'sch-2'
          ? { kind: 'disable', error: 'bad spec' }
          : { kind: 'claim', nextRunAt: NOW + 2000 },
    })
    expect(claimed.map((row) => row.id)).toEqual(['sch-1'])
    expect((await persistence.get('sch-2'))?.enabled).toBe(false)
    expect((await persistence.get('sch-2'))?.lastError).toBe('bad spec')
    expect(
      await persistence.pollAndClaim({
        now: NOW + 1000,
        limit: 5,
        decide: () => ({ kind: 'claim', nextRunAt: NOW + 3000 }),
      }),
    ).toEqual([])
    expect((await persistence.get('sch-1'))?.nextRunAt).toBe(NOW + 2000)

    await persistence.recordSuccess({
      id: 'sch-1',
      taskId: 't-1',
      firedAt: NOW + 1000,
      recordedAt: NOW + 1001,
    })
    expect(await persistence.get('sch-1')).toMatchObject({
      lastStatus: 'launched',
      lastTaskId: 't-1',
      lastRunAt: NOW + 1000,
      consecutiveFailures: 0,
    })
    expect(
      await persistence.recordFailure({
        id: 'sch-1',
        message: 'boom 1',
        firedAt: NOW + 1100,
        recordedAt: NOW + 1101,
        maxFailures: 2,
      }),
    ).toEqual({ autoDisabled: false })
    expect(
      await persistence.recordFailure({
        id: 'sch-1',
        message: 'boom 2',
        firedAt: NOW + 1200,
        recordedAt: NOW + 1201,
        maxFailures: 2,
      }),
    ).toEqual({ autoDisabled: true })
    expect(await persistence.get('sch-1')).toMatchObject({
      enabled: false,
      consecutiveFailures: 2,
      lastStatus: 'failed',
      lastError: 'boom 2',
      lastRunAt: NOW + 1200,
    })
    // 更早的一次失败不能倒退 last_run_at。
    await persistence.recordFailure({
      id: 'sch-1',
      message: 'late',
      firedAt: NOW + 900,
      recordedAt: NOW + 1300,
      maxFailures: 2,
    })
    expect((await persistence.get('sch-1'))?.lastError).toBe('boom 2')

    // ACL 原子替换：修订核对 + owner 不入 grants。
    await persistence.replaceAclAtomically({
      resourceId: 'sch-1',
      expectedResourceId: 'sch-1',
      expectedAclRevision: 0,
      actorUserId: owner.user.id,
      bypassOwner: false,
      grants: [
        { userId: stranger.user.id, level: 'read' },
        { userId: owner.user.id, level: 'write' },
      ],
      systemUserId: 'system',
      updatedAt: NOW + 5,
    })
    const acl = await persistence.loadAcl('sch-1')
    expect(acl?.aclRevision).toBe(1)
    expect(acl?.grants).toEqual([{ userId: stranger.user.id, level: 'read' }])
    expect(acl?.users.map((user) => user.id).sort()).toEqual(
      [owner.user.id, stranger.user.id].sort(),
    )
    expect(await persistence.loadGrantLevel('sch-1', stranger.user.id)).toBe('read')
    expect(await persistence.listGrantedResourceIds(stranger.user.id)).toEqual(new Set(['sch-1']))
    expect(await persistence.countVisible(stranger)).toBe(2)
    await expect(
      persistence.replaceAclAtomically({
        resourceId: 'sch-1',
        expectedResourceId: 'sch-1',
        expectedAclRevision: 0,
        actorUserId: owner.user.id,
        bypassOwner: false,
        grants: [],
        systemUserId: 'system',
        updatedAt: NOW + 6,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    expect(
      (await persistence.loadOwnerIdentities([owner.user.id, 'nobody'])).get(owner.user.id),
    ).toMatchObject({
      id: owner.user.id,
    })

    await persistence.updateHealedPayload({
      id: 'sch-2',
      launchPayload: '{"healed":true}',
      disableError: 'unhealable',
      updatedAt: NOW + 7,
    })
    expect(await persistence.get('sch-2')).toMatchObject({
      launchPayload: '{"healed":true}',
      enabled: false,
      nextRunAt: null,
      lastError: 'unhealable',
    })
    expect((await persistence.delete('sch-2'))?.id).toBe('sch-2')
    expect(await persistence.delete('sch-2')).toBeNull()
    expect(
      (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, 'sch-2'))).length,
    ).toBe(0)
  })

  test('触发器资源快照：agent / 数字员工，外人与归档都是 404', async () => {
    const db = harness.db
    const owner = await seedUser(db, 'u_d1_owner')
    const stranger = await seedUser(db, 'u_d1_stranger')
    const resources = createIntegrationTriggerResources(
      db,
      composeIntegrationTriggerResourceSnapshotFactory({ assertNotBuiltin }),
    )
    await db.insert(agents).values({
      id: 'agent-d1',
      name: 'agent-d1',
      description: 'private agent',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: owner.user.id,
      visibility: 'private',
      createdAt: NOW,
      updatedAt: NOW,
    })
    const agentSnapshots = await resources.loadAuthorized(pairOf(owner), [
      { kind: 'scheduled-agent', agentId: 'agent-d1' },
    ])
    expect(agentSnapshots[0]).toMatchObject({
      kind: 'scheduled-agent',
      agent: { id: 'agent-d1', name: 'agent-d1', description: 'private agent' },
    })
    await expect(
      resources.loadAuthorized(pairOf(stranger), [
        { kind: 'scheduled-agent', agentId: 'agent-d1' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      resources.loadAuthorized(pairOf(owner), [
        { kind: 'scheduled-workflow', workflowId: 'missing' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError)

    await db.insert(employeeTypePackages).values({
      typeId: 'type-d1',
      revision: 1,
      descriptorJson: JSON.stringify({
        workIntakeAuthoring: {
          acceptedKinds: ['body'],
          targetFields: [{ fieldRef: 'issue', required: true }],
        },
      }),
      descriptorDigest: 'type-d1',
      state: 'published',
      registeredAt: NOW,
    })
    await db.insert(employeeDefinitions).values({
      id: 'emp-d1',
      name: 'employee',
      typeId: 'type-d1',
      typeRevision: 1,
      configurationJson: '{}',
      currentRevision: 1,
      ownerUserId: owner.user.id,
      visibility: 'private',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(employeeDefinitionRevisions).values({
      employeeId: 'emp-d1',
      revision: 1,
      contentJson: '{"schemaVersion":1}',
      contentDigest: 'emp-d1-r1',
      createdAt: NOW,
    })
    const employeeSnapshots = await resources.loadAuthorized(pairOf(owner), [
      { kind: 'webhook-digital-employee', employeeDefinitionId: 'emp-d1' },
    ])
    expect(employeeSnapshots[0]).toEqual({
      kind: 'webhook-digital-employee',
      employee: {
        employeeDefinitionId: 'emp-d1',
        currentRevision: 1,
        typeId: 'type-d1',
        typeRevision: 1,
        intake: { acceptedKinds: ['body'], targetFields: [{ fieldRef: 'issue', required: true }] },
      },
    })
    await expect(
      resources.loadAuthorized(pairOf(stranger), [
        { kind: 'webhook-digital-employee', employeeDefinitionId: 'emp-d1' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError)
    await db
      .update(employeeDefinitions)
      .set({ archivedAt: NOW + 1 })
      .where(eq(employeeDefinitions.id, 'emp-d1'))
    await expect(
      resources.loadAuthorized(pairOf(owner), [
        { kind: 'webhook-digital-employee', employeeDefinitionId: 'emp-d1' },
      ]),
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})
