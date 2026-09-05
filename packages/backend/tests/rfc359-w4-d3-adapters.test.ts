// RFC-359 W4-D3 —— resource-catalog 自有 ACL 类型的读 / 写 / owner-name 预检端口合一，两个引擎各跑一遍：
// 快照读（identity + grants + users 一致）、写事务里的决策快照（owner+name 撞库检测、活跃用户过滤、当前 grants 与
// actor 的 grant 等级）、identity 行 CAS 与 grants 整体替换、after-write 钩子在同一事务里、非自有类型拒绝、
// owner+name 唯一键撞库经能力矩阵归类。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, resourceGrants, users } from '@/db/schema'
import {
  createResourceAclReadPort,
  createResourceCatalogAclIdentityReadPort,
  findOwnedAclResourceIdsByName,
  getAclResourceAccessRow,
  listAclResourceIdentityRowsByIds,
  listAclResourceIdentityRowsByNames,
  loadAclResourceNamesByIds,
} from '@/modules/resource-catalog/infrastructure/aclReadRepository'
import {
  createResourceAclMutationPort,
  isOwnerNameConstraintError,
} from '@/modules/resource-catalog/infrastructure/resourceAclRepository'
import { describeEachProvider } from './helpers/eachProvider'

const NOW = 1_700_000_000_000

async function seedUser(
  db: ProviderNeutralDatabase,
  status: 'active' | 'disabled' = 'active',
): Promise<string> {
  const id = `u_d3_${ulid()}`
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status,
    createdAt: NOW,
    updatedAt: NOW,
  })
  return id
}

async function seedAgent(
  db: ProviderNeutralDatabase,
  id: string,
  ownerUserId: string,
  name = id,
): Promise<void> {
  await db.insert(agents).values({
    id,
    name,
    description: 'd3',
    outputs: '[]',
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    ownerUserId,
    visibility: 'private',
    createdAt: NOW,
    updatedAt: NOW,
  })
}

describeEachProvider('RFC-359 W4-D3 —— resource-catalog ACL 内核', (harness) => {
  test('快照读 / owner-name 预检 / 写事务里的决策与 CAS / after-write 钩子', async () => {
    const db = harness.db
    const owner = await seedUser(db)
    const other = await seedUser(db)
    const grantee = await seedUser(db)
    const disabled = await seedUser(db, 'disabled')
    await seedAgent(db, 'agent-a', owner, 'shared-name')
    await seedAgent(db, 'agent-b', other, 'shared-name')

    const reads = createResourceAclReadPort(db)
    const identities = createResourceCatalogAclIdentityReadPort(db)
    expect(
      await reads.readSnapshot('agent', 'missing', {
        id: 'missing',
        ownerUserId: null,
        visibility: 'public',
      }),
    ).toBeNull()
    expect(
      await reads.readSnapshot('agent', 'agent-a', {
        id: 'agent-a',
        ownerUserId: null,
        visibility: 'public',
      }),
    ).toMatchObject({
      identity: { id: 'agent-a', ownerUserId: owner, visibility: 'private' },
      aclRevision: 0,
      grants: [],
    })
    expect(await identities.getOwner('agent', 'agent-a')).toBe(owner)
    expect(await identities.getOwner('agent', 'missing')).toBeUndefined()
    expect(await identities.listOwnedNames('agent', owner)).toEqual(['shared-name'])
    expect(await findOwnedAclResourceIdsByName(db, 'agent', other, 'shared-name')).toEqual([
      'agent-b',
    ])
    expect(await loadAclResourceNamesByIds(db, 'agent', ['agent-a', 'nope'])).toEqual(
      new Map([['agent-a', 'shared-name']]),
    )
    expect(await getAclResourceAccessRow(db, 'agent', 'agent-b')).toEqual({
      id: 'agent-b',
      ownerUserId: other,
      visibility: 'private',
    })
    expect(
      (await listAclResourceIdentityRowsByIds(db, 'agent', ['agent-a'])).map(
        (row) => row.aclRevision,
      ),
    ).toEqual([0])
    expect(
      (await listAclResourceIdentityRowsByNames(db, 'agent', ['shared-name']))
        .map((row) => row.id)
        .sort(),
    ).toEqual(['agent-a', 'agent-b'])
    await expect(
      reads.readSnapshot('development_adapter', 'x', {
        id: 'x',
        ownerUserId: null,
        visibility: 'public',
      }),
    ).rejects.toThrow('ACL identity persistence is required')

    const changes: Array<{ readonly resourceId: string; readonly grantsSeenInTx: number }> = []
    const mutations = createResourceAclMutationPort(db, {
      async afterWriteInTransaction(tx, change) {
        const rows = await tx
          .select({ userId: resourceGrants.userId })
          .from(resourceGrants)
          .where(eq(resourceGrants.resourceId, change.resourceId))
        changes.push({ resourceId: change.resourceId, grantsSeenInTx: rows.length })
      },
    })
    const first = await mutations.mutate(
      {
        type: 'agent',
        resourceId: 'agent-a',
        actorUserId: owner,
        referencedUserIds: [grantee, disabled],
        candidateOwnerUserId: other,
      },
      (snapshot) => {
        expect(snapshot.current).toEqual({
          id: 'agent-a',
          name: 'shared-name',
          ownerUserId: owner,
          visibility: 'private',
          aclRevision: 0,
        })
        expect(snapshot.ownerNameIsUnique).toBe(true)
        // other 名下已有同名 agent：把 owner 换成 other 会撞 owner+name 唯一键。
        expect(snapshot.ownerNameCollision).toBe(true)
        expect(snapshot.activeUserIds).toEqual(new Set([grantee]))
        expect(snapshot.currentGrants.size).toBe(0)
        expect(snapshot.actorGrantLevel).toBeNull()
        return {
          update: { ownerUserId: owner, visibility: 'public', aclRevision: 1, updatedAt: NOW + 1 },
          grants: new Map([[grantee, 'read' as const]]),
          addedBy: owner,
          addedAt: NOW + 1,
          result: {
            id: 'agent-a',
            ownerUserId: owner,
            visibility: 'public',
            aclRevision: 1,
            grantedUserIds: new Set([grantee]),
          },
        }
      },
    )
    expect(first).toMatchObject({ id: 'agent-a', aclRevision: 1, visibility: 'public' })
    expect(changes).toEqual([{ resourceId: 'agent-a', grantsSeenInTx: 1 }])
    expect(
      await reads.readSnapshot('agent', 'agent-a', {
        id: 'agent-a',
        ownerUserId: null,
        visibility: 'public',
      }),
    ).toMatchObject({
      identity: { ownerUserId: owner, visibility: 'public' },
      aclRevision: 1,
      grants: [{ userId: grantee, level: 'read' }],
    })
    const snapshotUsers = (
      await reads.readSnapshot('agent', 'agent-a', {
        id: 'agent-a',
        ownerUserId: null,
        visibility: 'public',
      })
    )?.users
    expect([...(snapshotUsers?.keys() ?? [])].sort()).toEqual([owner, grantee].sort())

    // 第二轮：决策看到当前 grants 与 actor 的 grant 等级；grants 整体替换。
    const second = await mutations.mutate(
      {
        type: 'agent',
        resourceId: 'agent-a',
        actorUserId: grantee,
        referencedUserIds: [grantee],
        candidateOwnerUserId: null,
      },
      (snapshot) => {
        expect(snapshot.current.aclRevision).toBe(1)
        expect(snapshot.currentGrants).toEqual(new Map([[grantee, 'read']]))
        expect(snapshot.actorGrantLevel).toBe('read')
        expect(snapshot.ownerNameCollision).toBe(false)
        return {
          update: { ownerUserId: owner, visibility: 'private', aclRevision: 2, updatedAt: NOW + 2 },
          grants: new Map([[grantee, 'write' as const]]),
          addedBy: grantee,
          addedAt: NOW + 2,
          result: {
            id: 'agent-a',
            ownerUserId: owner,
            visibility: 'private',
            aclRevision: 2,
            grantedUserIds: new Set([grantee]),
          },
        }
      },
    )
    expect(second?.aclRevision).toBe(2)
    expect(
      (await db.select().from(resourceGrants).where(eq(resourceGrants.resourceId, 'agent-a')))[0],
    ).toMatchObject({
      userId: grantee,
      level: 'write',
      addedBy: grantee,
    })
    expect((await db.select().from(agents).where(eq(agents.id, 'agent-a')))[0]).toMatchObject({
      aclRevision: 2,
      visibility: 'private',
      updatedAt: NOW + 2,
    })

    // 不存在的资源：undefined；非自有类型：拒绝。
    expect(
      await mutations.mutate(
        {
          type: 'agent',
          resourceId: 'missing',
          actorUserId: owner,
          referencedUserIds: [],
          candidateOwnerUserId: null,
        },
        () => {
          throw new Error('decide must not run')
        },
      ),
    ).toBeUndefined()
    await expect(
      mutations.mutate(
        {
          type: 'employee_definition',
          resourceId: 'x',
          actorUserId: owner,
          referencedUserIds: [],
          candidateOwnerUserId: null,
        },
        () => {
          throw new Error('decide must not run')
        },
      ),
    ).rejects.toThrow('ACL identity persistence is required')

    // owner+name 唯一键撞库：两个引擎的驱动错误都经能力矩阵归类。
    let collision: unknown = null
    try {
      await seedAgent(db, 'agent-dup', owner, 'shared-name')
    } catch (error) {
      collision = error
    }
    expect(collision).not.toBeNull()
    expect(mutations.isOwnerNameConstraintError(collision)).toBe(true)
    expect(isOwnerNameConstraintError(db, new Error('something else'))).toBe(false)
  })
})
