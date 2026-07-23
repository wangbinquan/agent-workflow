// RFC-170 §8 — ACL aclRevision monotonic CAS.
//
// The security property: a stale PUT (client read revision N, then paused while
// another writer advanced the resource to N+1) is 409-rejected, so it cannot
// silently reinstate a revoked grant or re-take ownership. RFC-223 makes the
// immutable id + revision pair mandatory and repeats actor authorization from
// the in-transaction row snapshot. Also locks the referenced-user active check
// (G5-P5).

import { describe, expect, test, beforeEach } from 'bun:test'
import { UpdateResourceAclBodySchema } from '@agent-workflow/shared'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, users } from '../src/db/schema'
import { getResourceAcl, updateResourceAcl, type AclRow } from '../src/services/resourceAcl'
import { ConflictError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actorOfUser(id: string, role: 'admin' | 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}
async function seedUser(
  db: DbClient,
  id: string,
  role: 'admin' | 'user',
  status: 'active' | 'disabled' = 'active',
): Promise<void> {
  await db.insert(users).values({
    id,
    username: `u-${id}`,
    displayName: id,
    role,
    status,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

describe('RFC-170 §8 — ACL aclRevision CAS', () => {
  let db: DbClient
  let owner: Actor
  let admin: Actor
  const OWNER = 'user-owner'
  const OTHER = 'user-other'
  const ADMIN = 'user-admin'
  let agentRow: AclRow

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, OWNER, 'user')
    await seedUser(db, OTHER, 'user')
    await seedUser(db, ADMIN, 'admin')
    owner = actorOfUser(OWNER, 'user')
    admin = actorOfUser(ADMIN, 'admin')
    const id = ulid()
    await db.insert(agents).values({
      id,
      name: 'a1',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      ownerUserId: OWNER,
      visibility: 'public',
    })
    agentRow = { id, ownerUserId: OWNER, visibility: 'public' }
  })

  test('GET starts at aclRevision 0; each successful PUT bumps it monotonically', async () => {
    expect((await getResourceAcl(db, owner, 'agent', agentRow)).aclRevision).toBe(0)
    const a = await updateResourceAcl(db, owner, 'agent', agentRow, {
      visibility: 'private',
      expectedResourceId: agentRow.id,
      expectedAclRevision: 0,
    })
    expect(a.aclRevision).toBe(1)
    const b = await updateResourceAcl(db, owner, 'agent', agentRow, {
      visibility: 'public',
      expectedResourceId: agentRow.id,
      expectedAclRevision: 1,
    })
    expect(b.aclRevision).toBe(2)
  })

  test('PUT with a MATCHING expectedAclRevision succeeds', async () => {
    const res = await updateResourceAcl(db, owner, 'agent', agentRow, {
      visibility: 'private',
      expectedResourceId: agentRow.id,
      expectedAclRevision: 0,
    })
    expect(res.aclRevision).toBe(1)
  })

  test('PUT with a STALE expectedAclRevision → 409 ConflictError (no write applied)', async () => {
    // Advance to revision 1.
    await updateResourceAcl(db, owner, 'agent', agentRow, {
      visibility: 'private',
      expectedResourceId: agentRow.id,
      expectedAclRevision: 0,
    })
    // A request that still believes it is at revision 0 must be rejected.
    await expect(
      updateResourceAcl(db, owner, 'agent', agentRow, {
        userIds: [OTHER],
        expectedResourceId: agentRow.id,
        expectedAclRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    // The stale write did NOT apply — no grant to OTHER.
    const acl = await getResourceAcl(db, owner, 'agent', agentRow)
    expect(acl.users.map((u) => u.id)).not.toContain(OTHER)
    expect(acl.aclRevision).toBe(1)
  })

  test('SECURITY: a stale request cannot re-take ownership after an admin transferred it', async () => {
    // Client reads revision 0 (owner = OWNER).
    const seen = await getResourceAcl(db, owner, 'agent', agentRow)
    expect(seen.aclRevision).toBe(0)
    // Admin transfers ownership to OTHER (revision → 1).
    await updateResourceAcl(db, admin, 'agent', agentRow, {
      ownerUserId: OTHER,
      expectedResourceId: agentRow.id,
      expectedAclRevision: 0,
    })
    // The paused original request tries to keep OWNER as owner using its stale
    // revision — must 409, NOT silently re-take ownership.
    await expect(
      updateResourceAcl(db, owner, 'agent', agentRow, {
        ownerUserId: OWNER,
        expectedResourceId: agentRow.id,
        expectedAclRevision: seen.aclRevision,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
    const after = await getResourceAcl(db, admin, 'agent', {
      id: agentRow.id,
      ownerUserId: OTHER,
      visibility: 'public',
    })
    expect(after.ownerUserId).toBe(OTHER) // ownership stayed transferred
  })

  test('wrong expectedResourceId → 409', async () => {
    await expect(
      updateResourceAcl(db, owner, 'agent', agentRow, {
        visibility: 'private',
        expectedResourceId: 'some-other-id',
        expectedAclRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('a payload without the immutable id + revision pair is rejected by the wire schema', () => {
    expect(UpdateResourceAclBodySchema.safeParse({ visibility: 'private' }).success).toBe(false)
  })

  test('G5-P5: a referenced user disabled before the CAS is rejected in-tx (422)', async () => {
    // Disable OTHER, then try to grant to them.
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, OTHER)).run()
    await expect(
      updateResourceAcl(db, owner, 'agent', agentRow, {
        userIds: [OTHER],
        expectedResourceId: agentRow.id,
        expectedAclRevision: 0,
      }),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
