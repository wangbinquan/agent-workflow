import { beforeEach, describe, expect, test } from 'bun:test'
import type { AclResourceType } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  capabilityTemplates,
  employeeDefinitions,
  employeeJobTemplates,
  mcps,
  plugins,
  resourceGrants,
  skills,
  users,
  workflows,
  workgroups,
} from '../src/db/schema'
import { updateResourceAcl, type AclRow } from '../src/services/resourceAcl'
import { ConflictError, ForbiddenError, NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// RFC-304 — the two capability template layers carry owner+name unique indexes
// exactly like the five above, so a transfer into an occupied name bucket must
// produce the same typed 409. They were absent from `OWNER_NAME_UNIQUE_TYPES`
// while the tables already had the constraint, which turns that transfer into a
// raw SQLite error instead — a 500 where a 409 was designed.
const OWNER_SCOPED_TYPES = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workgroup',
  'capability_template',
] as const

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
      await db.insert(skills).values({ id, name, ...acl })
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
    case 'capability_template':
      await db.insert(capabilityTemplates).values({
        id,
        name,
        capability: 'mr-review',
        createdAt: 1,
        updatedAt: 1,
        ...acl,
      })
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

  test('every owner-scoped type rejects a transfer into the target owner name bucket', async () => {
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
        capability_template: capabilityTemplates,
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

  test('a caller who lost visibility gets 404 before any stale-revision oracle', async () => {
    const source = await seedResource(db, 'agent', 'agent-hidden', 'agent-hidden', 'owner-a')
    await updateResourceAcl(db, admin, 'agent', source, {
      ownerUserId: 'owner-b',
      visibility: 'private',
      expectedResourceId: source.id,
      expectedAclRevision: 0,
    })
    await updateResourceAcl(
      db,
      admin,
      'agent',
      { ...source, ownerUserId: 'owner-b', visibility: 'private' },
      {
        grants: [],
        expectedResourceId: source.id,
        expectedAclRevision: 1,
      },
    )

    await expect(
      updateResourceAcl(db, ownerA, 'agent', source, {
        visibility: 'public',
        expectedResourceId: source.id,
        expectedAclRevision: 0,
      }),
    ).rejects.toBeInstanceOf(NotFoundError)
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

// RFC-330 D17' / D-① —— owner-name 唯一表长出分区列。
//
//   - 岗位模版的唯一索引是 (owner, type_id, type_revision, name)：转移到「只在**其它**
//     类型版本下有同名模版」的 owner 必须成功，同分区撞名才 409（分区列不参与判定的
//     话前者会被误拒——这正是 v1 设计里 (owner, name) 的问题）；
//   - `employee_definitions_owner_name_unique` 自 RFC-310 就在，但类型此前没登记进
//     唯一表：撞名转移是一次 raw UNIQUE 失败（500）而非 409。
describe('RFC-330 —— 分区化的 owner-name 唯一转移预检', () => {
  const NOW = 1_700_000_000_000
  let db: DbClient
  let admin: Actor

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'owner-a', 'user')
    await seedUser(db, 'owner-b', 'user')
    await seedUser(db, 'admin', 'admin')
    admin = actor('admin', 'admin')
  })

  const seedTemplate = async (
    id: string,
    ownerUserId: string,
    typeRevision: number,
    name: string,
  ): Promise<AclRow> => {
    await db.insert(employeeJobTemplates).values({
      id,
      typeId: 'design',
      typeRevision,
      name,
      draftJson: '{}',
      publishedRevision: null,
      ownerUserId,
      visibility: 'public',
      aclRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    })
    return { id, ownerUserId, visibility: 'public' }
  }

  test('岗位模版：目标 owner 只在其它类型版本下有同名 ⇒ 转移成功；同分区撞名 ⇒ 409', async () => {
    const source = await seedTemplate('job-src', 'owner-a', 2, 'Reviewer')
    await seedTemplate('job-other-revision', 'owner-b', 1, 'Reviewer')
    const moved = await updateResourceAcl(db, admin, 'employee_job_template', source, {
      ownerUserId: 'owner-b',
      expectedResourceId: source.id,
      expectedAclRevision: 0,
    })
    expect(moved.ownerUserId).toBe('owner-b')

    const second = await seedTemplate('job-src-2', 'owner-a', 2, 'Reviewer')
    await expect(
      updateResourceAcl(db, admin, 'employee_job_template', second, {
        ownerUserId: 'owner-b',
        expectedResourceId: second.id,
        expectedAclRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'resource-name-conflict', status: 409 })
    expect(
      await db
        .select({ ownerUserId: employeeJobTemplates.ownerUserId })
        .from(employeeJobTemplates)
        .where(eq(employeeJobTemplates.id, second.id))
        .get(),
    ).toEqual({ ownerUserId: 'owner-a' })
  })

  test('员工定义：撞名转移 ⇒ 409 resource-name-conflict（此前是 raw UNIQUE 500）', async () => {
    const seedDefinition = async (id: string, ownerUserId: string): Promise<AclRow> => {
      await db.insert(employeeDefinitions).values({
        id,
        name: 'shared-employee',
        typeId: 'design',
        typeRevision: 1,
        configurationJson: '{}',
        currentRevision: null,
        ownerUserId,
        visibility: 'public',
        aclRevision: 0,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
      })
      return { id, ownerUserId, visibility: 'public' }
    }
    const source = await seedDefinition('emp-src', 'owner-a')
    await seedDefinition('emp-target', 'owner-b')
    await expect(
      updateResourceAcl(db, admin, 'employee_definition', source, {
        ownerUserId: 'owner-b',
        expectedResourceId: source.id,
        expectedAclRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'resource-name-conflict', status: 409 })
  })
})
