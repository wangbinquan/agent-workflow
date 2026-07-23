import { beforeEach, describe, expect, test } from 'bun:test'
import type { AclResourceType } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  mcps,
  plugins,
  resourceGrants,
  skills,
  users,
  workflows,
  workgroups,
} from '../src/db/schema'
import { updateResourceAcl, type AclRow } from '../src/services/resourceAcl'
import { ConflictError, ForbiddenError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const OWNER_SCOPED_TYPES = ['agent', 'skill', 'mcp', 'plugin', 'workgroup'] as const

function actor(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user'): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

async function seedResource(
  db: DbClient,
  type: AclResourceType,
  id: string,
  name: string,
  ownerUserId: string,
): Promise<AclRow> {
  const acl = { ownerUserId, visibility: 'public' as const, aclRevision: 0 }
  switch (type) {
    case 'agent':
      await db.insert(agents).values({ id, name, ...acl })
      break
    case 'skill':
      await db.insert(skills).values({ id, name, sourceKind: 'managed', ...acl })
      break
    case 'mcp':
      await db.insert(mcps).values({ id, name, type: 'local', ...acl })
      break
    case 'plugin':
      await db.insert(plugins).values({
        id,
        name,
        spec: 'pkg',
        sourceKind: 'npm',
        cachedPath: `/tmp/${id}`,
        installedAt: 1,
        ...acl,
      })
      break
    case 'workflow':
      await db.insert(workflows).values({ id, name, definition: '{}', ...acl })
      break
    case 'workgroup':
      await db.insert(workgroups).values({ id, name, ...acl })
      break
  }
  return { id, ownerUserId, visibility: 'public' }
}

describe('RFC-223 owner transfer and fresh-ACL fences', () => {
  let db: DbClient
  let admin: Actor
  let ownerA: Actor

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a', 'user')
    await seedUser(db, 'owner-b', 'user')
    await seedUser(db, 'admin', 'admin')
    ownerA = actor('owner-a', 'user')
    admin = actor('admin', 'admin')
  })

  test('five owner-scoped types reject a transfer into the target owner name bucket', async () => {
    for (const type of OWNER_SCOPED_TYPES) {
      const source = await seedResource(db, type, `${type}-source`, 'shared-name', 'owner-a')
      await seedResource(db, type, `${type}-target`, 'shared-name', 'owner-b')

      await expect(
        updateResourceAcl(db, admin, type, source, {
          ownerUserId: 'owner-b',
          expectedResourceId: source.id,
          expectedAclRevision: 0,
        }),
      ).rejects.toMatchObject({
        code: 'resource-name-conflict',
        status: 409,
      })

      const table = {
        agent: agents,
        skill: skills,
        mcp: mcps,
        plugin: plugins,
        workgroup: workgroups,
      }[type]
      expect(
        await db
          .select({
            ownerUserId: table.ownerUserId,
            aclRevision: table.aclRevision,
          })
          .from(table)
          .where(eq(table.id, source.id))
          .get(),
      ).toEqual({ ownerUserId: 'owner-a', aclRevision: 0 })
      expect(
        await db.select().from(resourceGrants).where(eq(resourceGrants.resourceId, source.id)),
      ).toEqual([])
    }
  })

  test('workflow remains the explicit non-unique transfer exception', async () => {
    const source = await seedResource(db, 'workflow', 'workflow-source', 'shared-name', 'owner-a')
    await seedResource(db, 'workflow', 'workflow-target', 'shared-name', 'owner-b')

    const result = await updateResourceAcl(db, admin, 'workflow', source, {
      ownerUserId: 'owner-b',
      expectedResourceId: source.id,
      expectedAclRevision: 0,
    })
    expect(result.ownerUserId).toBe('owner-b')
    expect(result.aclRevision).toBe(1)
  })

  test('authorization is repeated from the transaction snapshot after ownership changes', async () => {
    const source = await seedResource(db, 'agent', 'agent-source', 'agent', 'owner-a')
    await updateResourceAcl(db, admin, 'agent', source, {
      ownerUserId: 'owner-b',
      expectedResourceId: source.id,
      expectedAclRevision: 0,
    })

    await expect(
      updateResourceAcl(db, ownerA, 'agent', source, {
        visibility: 'private',
        expectedResourceId: source.id,
        expectedAclRevision: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError)
    expect(
      await db
        .select({
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
          aclRevision: agents.aclRevision,
        })
        .from(agents)
        .where(eq(agents.id, source.id))
        .get(),
    ).toEqual({ ownerUserId: 'owner-b', visibility: 'public', aclRevision: 1 })
  })

  test('two writes from one revision have exactly one winner', async () => {
    const source = await seedResource(db, 'agent', 'agent-cas', 'agent-cas', 'owner-a')
    await updateResourceAcl(db, ownerA, 'agent', source, {
      visibility: 'private',
      expectedResourceId: source.id,
      expectedAclRevision: 0,
    })
    await expect(
      updateResourceAcl(db, ownerA, 'agent', source, {
        visibility: 'public',
        expectedResourceId: source.id,
        expectedAclRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})
