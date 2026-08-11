// RFC-282 D2 — the "all grants of a type for a user" SQL exists exactly once
// (resourceAcl.grantsOfUserWhere). importRefs / resourceRefs carried literal
// copies; this locks the convergence two ways:
//   1. behavior: the sync in-tx variant returns byte-identical sets to the
//      async variant on the same DB state (the对拍 for the swap);
//   2. source: no file outside resourceAcl.ts selects from resource_grants
//      with the type+userId pair again (grep lock, scoped to the two files
//      D2 converged — the global lock arrives with A2).

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, resourceGrants, users } from '../src/db/schema'
import { dbTxSync } from '../src/db/txSync'
import { listGrantedResourceIds, listGrantedResourceIdsInTx } from '../src/services/resourceAcl'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

function actorOf(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-6)}`, displayName: 'U', role: 'user', status: 'active' },
    source: 'session',
  })
}

describe('RFC-282 D2 — grant-set query single source', () => {
  let db: DbClient
  const userA = ulid()
  const userB = ulid()

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    for (const id of [userA, userB]) {
      await db.insert(users).values({
        id,
        username: `u-${id.slice(-6)}`,
        displayName: 'U',
        role: 'user',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    const a1 = ulid()
    const a2 = ulid()
    await db.insert(agents).values([
      { id: a1, name: `a-${a1.toLowerCase()}`, ownerUserId: userB, visibility: 'private' },
      { id: a2, name: `a-${a2.toLowerCase()}`, ownerUserId: userB, visibility: 'private' },
    ])
    await db.insert(resourceGrants).values([
      { resourceType: 'agent', resourceId: a1, userId: userA, addedBy: userB, addedAt: 1 },
      { resourceType: 'agent', resourceId: a2, userId: userA, addedBy: userB, addedAt: 1 },
      // different type, same user — must NOT leak into the 'agent' set
      { resourceType: 'mcp', resourceId: a1, userId: userA, addedBy: userB, addedAt: 1 },
    ])
  })

  test('sync in-tx variant equals the async variant on the same state (对拍)', async () => {
    for (const [actor, type] of [
      [actorOf(userA), 'agent'],
      [actorOf(userA), 'mcp'],
      [actorOf(userA), 'workflow'],
      [actorOf(userB), 'agent'],
    ] as const) {
      const asyncSet = await listGrantedResourceIds(db, actor, type)
      const syncSet = dbTxSync(db, (tx) => listGrantedResourceIdsInTx(tx, actor, type))
      expect([...syncSet].sort()).toEqual([...asyncSet].sort())
    }
  })

  test('importRefs / resourceRefs no longer carry the grant-set SQL', () => {
    for (const file of ['services/importRefs.ts', 'services/resourceRefs.ts']) {
      const text = readFileSync(resolve(SRC, file), 'utf8')
      expect(text).not.toContain('.from(resourceGrants)')
    }
  })
})
