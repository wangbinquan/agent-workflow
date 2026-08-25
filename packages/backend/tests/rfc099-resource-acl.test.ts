// RFC-099 T3 — services/resourceAcl.ts matrix. This is the single authority
// for resource visibility/ownership, so the full actor × row matrix is pinned
// here: explicit ACL-bypass permission, owner,
// granted user, public, and the invisible-404 / non-owner-403 split.
// resolveTaskRole precedence (D17: owner > user > admin) is locked too —
// review/clarify attribution snapshots depend on it.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, workflows } from '../src/db/schema'
import {
  canViewResource,
  filterVisibleRows,
  canGovernResource,
  isVisibleRow,
  listGrantedResourceIds,
  requireResourceGovern,
  requireResourceView,
  resolveTaskRole,
  type AclRow,
} from '../src/services/resourceAcl'
import { ForbiddenError, NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOfUser(id: string, role: 'admin' | 'user' | 'guest', patScopes?: string[]): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role, status: 'active' },
    source: patScopes ? 'pat' : 'session',
    ...(patScopes ? { patScopes: patScopes as never } : {}),
  })
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user' | 'guest'): Promise<void> {
  const { users } = await import('../src/db/schema')
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    displayName: `U ${id.slice(-4)}`,
    role,
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

describe('resourceAcl — visibility matrix', () => {
  let db: DbClient
  const ownerId = ulid()
  const grantedId = ulid()
  const strangerId = ulid()
  const guestId = ulid()
  const adminId = ulid()
  let privateAgent: AclRow
  let publicAgent: AclRow

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    for (const [id, role] of [
      [ownerId, 'user'],
      [grantedId, 'user'],
      [strangerId, 'user'],
      [guestId, 'guest'],
      [adminId, 'admin'],
    ] as const) {
      await seedUser(db, id, role)
    }
    const privId = ulid()
    const pubId = ulid()
    await db.insert(agents).values([
      { id: privId, name: `priv-${privId}`, ownerUserId: ownerId, visibility: 'private' },
      { id: pubId, name: `pub-${pubId}`, ownerUserId: ownerId, visibility: 'public' },
    ])
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: privId,
      userId: grantedId,
      addedBy: ownerId,
      addedAt: Date.now(),
    })
    await db.insert(resourceGrants).values({
      resourceType: 'agent',
      resourceId: privId,
      userId: guestId,
      addedBy: ownerId,
      addedAt: Date.now(),
    })
    privateAgent = { id: privId, ownerUserId: ownerId, visibility: 'private' }
    publicAgent = { id: pubId, ownerUserId: ownerId, visibility: 'public' }
  })

  test('owner sees own private resource', async () => {
    expect(await canViewResource(db, actorOfUser(ownerId, 'user'), 'agent', privateAgent)).toBe(
      true,
    )
  })

  test('granted user sees the private resource', async () => {
    expect(await canViewResource(db, actorOfUser(grantedId, 'user'), 'agent', privateAgent)).toBe(
      true,
    )
  })

  test('stranger cannot see the private resource but sees the public one', async () => {
    const stranger = actorOfUser(strangerId, 'user')
    expect(await canViewResource(db, stranger, 'agent', privateAgent)).toBe(false)
    expect(await canViewResource(db, stranger, 'agent', publicAgent)).toBe(true)
  })

  test('guest is public-only even as owner or grantee until private range is explicitly granted', async () => {
    const guest = actorOfUser(guestId, 'guest')
    expect(await canViewResource(db, guest, 'agent', privateAgent)).toBe(false)
    expect(await canViewResource(db, guest, 'agent', publicAgent)).toBe(true)
    expect(
      canGovernResource(guest, {
        id: privateAgent.id,
        ownerUserId: guestId,
        visibility: 'private',
      }),
    ).toBe(false)

    const upgraded: Actor = {
      ...guest,
      permissions: new Set([...guest.permissions, 'resource-acl:private']),
    }
    expect(await canViewResource(db, upgraded, 'agent', privateAgent)).toBe(true)
    expect(
      canGovernResource(upgraded, {
        id: privateAgent.id,
        ownerUserId: guestId,
        visibility: 'private',
      }),
    ).toBe(true)
  })

  test('session preset may include bypass; PAT strips that system-domain permission', async () => {
    expect(await canViewResource(db, actorOfUser(adminId, 'admin'), 'agent', privateAgent)).toBe(
      true,
    )
    const narrowedAdmin = actorOfUser(adminId, 'admin', ['agents:read'])
    expect(narrowedAdmin.permissions.has('agents:write' as never)).toBe(false)
    expect(narrowedAdmin.permissions.has('resource-acl:bypass' as never)).toBe(false)
    expect(await canViewResource(db, narrowedAdmin, 'agent', privateAgent)).toBe(false)
  })

  test('grant is per resource type — an agent grant does not leak to a workflow with the same id', async () => {
    await db.insert(workflows).values({
      id: privateAgent.id, // deliberately reuse the id across tables
      name: 'wf-同id',
      definition: '{}',
      ownerUserId: ownerId,
      visibility: 'private',
    })
    const wfRow: AclRow = { id: privateAgent.id, ownerUserId: ownerId, visibility: 'private' }
    expect(await canViewResource(db, actorOfUser(grantedId, 'user'), 'workflow', wfRow)).toBe(false)
  })

  test('filterVisibleRows: stranger keeps public only; granted keeps both; admin keeps all', async () => {
    const rows = [privateAgent, publicAgent]
    expect(
      (await filterVisibleRows(db, actorOfUser(strangerId, 'user'), 'agent', rows)).map(
        (r) => r.id,
      ),
    ).toEqual([publicAgent.id])
    expect(
      (await filterVisibleRows(db, actorOfUser(grantedId, 'user'), 'agent', rows)).length,
    ).toBe(2)
    expect((await filterVisibleRows(db, actorOfUser(adminId, 'admin'), 'agent', rows)).length).toBe(
      2,
    )
  })

  test('isVisibleRow pure predicate covers the null-owner private row', () => {
    const orphanPrivate: AclRow = { id: 'x', ownerUserId: null, visibility: 'private' }
    expect(isVisibleRow(actorOfUser(strangerId, 'user'), orphanPrivate, new Set())).toBe(false)
    expect(isVisibleRow(actorOfUser(adminId, 'admin'), orphanPrivate, new Set())).toBe(true)
    expect(isVisibleRow(actorOfUser(strangerId, 'user'), orphanPrivate, new Set(['x']))).toBe(true)
  })

  test('listGrantedResourceIds returns only this user×type rows', async () => {
    expect([
      ...(await listGrantedResourceIds(db, actorOfUser(grantedId, 'user'), 'agent')),
    ]).toEqual([privateAgent.id])
    expect(
      (await listGrantedResourceIds(db, actorOfUser(grantedId, 'user'), 'workflow')).size,
    ).toBe(0)
  })

  test('requireResourceView: invisible → NotFoundError (404, not 403 — D1 existence isolation)', async () => {
    await expect(
      requireResourceView(db, actorOfUser(strangerId, 'user'), 'agent', privateAgent),
    ).rejects.toBeInstanceOf(NotFoundError)
    await expect(
      requireResourceView(db, actorOfUser(grantedId, 'user'), 'agent', privateAgent),
    ).resolves.toBeUndefined()
  })

  test('requireResourceGovern: owner + admin pass; granted non-owner → 403; stranger → 404', async () => {
    await expect(
      requireResourceGovern(db, actorOfUser(ownerId, 'user'), 'agent', privateAgent),
    ).resolves.toBeUndefined()
    await expect(
      requireResourceGovern(db, actorOfUser(adminId, 'admin'), 'agent', privateAgent),
    ).resolves.toBeUndefined()
    await expect(
      requireResourceGovern(db, actorOfUser(grantedId, 'user'), 'agent', privateAgent),
    ).rejects.toBeInstanceOf(ForbiddenError)
    await expect(
      requireResourceGovern(db, actorOfUser(strangerId, 'user'), 'agent', privateAgent),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('canGovernResource: owner / admin true; granted + stranger false; null owner only admin', () => {
    expect(canGovernResource(actorOfUser(ownerId, 'user'), privateAgent)).toBe(true)
    expect(canGovernResource(actorOfUser(adminId, 'admin'), privateAgent)).toBe(true)
    expect(canGovernResource(actorOfUser(grantedId, 'user'), privateAgent)).toBe(false)
    const orphan: AclRow = { id: 'x', ownerUserId: null, visibility: 'private' }
    expect(canGovernResource(actorOfUser(ownerId, 'user'), orphan)).toBe(false)
    expect(canGovernResource(actorOfUser(adminId, 'admin'), orphan)).toBe(true)
  })
})

describe('resourceAcl — resolveTaskRole precedence (D17: member identity first)', () => {
  const me = ulid()

  test('task owner → owner, even when the actor is also an admin', () => {
    expect(resolveTaskRole(actorOfUser(me, 'admin'), me, false)).toBe('owner')
    expect(resolveTaskRole(actorOfUser(me, 'user'), me, true)).toBe('owner')
  })

  test('member → user, even when the actor is also an admin', () => {
    expect(resolveTaskRole(actorOfUser(me, 'admin'), ulid(), true)).toBe('user')
    expect(resolveTaskRole(actorOfUser(me, 'user'), ulid(), true)).toBe('user')
  })

  test('non-member admin → admin; non-member user → null', () => {
    expect(resolveTaskRole(actorOfUser(me, 'admin'), ulid(), false)).toBe('admin')
    expect(resolveTaskRole(actorOfUser(me, 'user'), ulid(), false)).toBeNull()
  })

  test('users:write alone does not bypass task membership', () => {
    const base = actorOfUser(me, 'user')
    const usersWriter = {
      ...base,
      permissions: new Set([...base.permissions, 'users:write'] as const),
    }
    expect(resolveTaskRole(usersWriter, ulid(), false)).toBeNull()
    const bypassWriter = {
      ...base,
      permissions: new Set([...base.permissions, 'users:write', 'resource-acl:bypass'] as const),
    }
    expect(resolveTaskRole(bypassWriter, ulid(), false)).toBe('admin')
  })

  test('null task owner never matches as owner', () => {
    expect(resolveTaskRole(actorOfUser(me, 'user'), null, true)).toBe('user')
    expect(resolveTaskRole(actorOfUser(me, 'admin'), null, false)).toBe('admin')
  })
})
