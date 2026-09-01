// RFC-282 D4 — two fail-open seams in the reference-check surface, closed:
//
//   1. `resolveRefsUsableByName` had no grandfathering parameter — the D15
//      "only NEW references are ACL-checked" contract relied on every caller
//      remembering to diff by hand; one forgotten diff silently re-checked
//      grandfathered names (bricking saves after a grant revocation). The
//      resolver now takes `grandfatheredNames`, symmetric with the id domain.
//   2. `RefCheckGroup.domain` defaulted to 'id' — a caller passing NAME tokens
//      that forgot the tag silently took the id path and PASSED (ids never
//      match display names ⇒ zero rows ⇒ no missing). Now required; this file
//      pins the source shape so a future "convenience default" cannot return.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users, workflows } from '../src/db/schema'
import { resolveRefsUsableByName } from '../src/services/resourceRefs'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

function actorOf(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-6)}`, displayName: 'U', role: 'user', status: 'active' },
    source: 'session',
  })
}

describe('RFC-282 D4 — name-domain grandfathering lives in the resolver', () => {
  let db: DbClient
  const ownerId = ulid()
  const editorId = ulid()

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    for (const id of [ownerId, editorId]) {
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
    for (const name of ['secret-a', 'secret-b']) {
      await db.insert(workflows).values({
        id: ulid(),
        name,
        description: '',
        definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
        version: 1,
        ownerUserId: ownerId,
        visibility: 'private',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
  })

  test('without grandfathering an invisible-name ref is missing (baseline)', async () => {
    const res = await resolveRefsUsableByName(db, actorOf(editorId), 'workflow', ['secret-a'])
    expect(res.missing).toEqual([{ type: 'workflow', name: 'secret-a' }])
  })

  test('a grandfathered name is not re-checked; genuinely new names still are', async () => {
    const res = await resolveRefsUsableByName(
      db,
      actorOf(editorId),
      'workflow',
      ['secret-a', 'secret-b', 'dangling-never-exists'],
      { grandfatheredNames: new Set(['secret-a']) },
    )
    expect(res.missing).toEqual([{ type: 'workflow', name: 'secret-b' }])
  })

  test('grandfathering everything yields zero checks (revoked grant cannot brick a save)', async () => {
    const res = await resolveRefsUsableByName(db, actorOf(editorId), 'workflow', ['secret-a'], {
      grandfatheredNames: new Set(['secret-a']),
    })
    expect(res.missing).toEqual([])
  })
})

describe('RFC-282 D4 — RefCheckGroup.domain is required', () => {
  test('the source shape has no optional domain and no ?? fallback', () => {
    const text = readFileSync(
      resolve(SRC, 'modules/resource-catalog/application/agents/referenceTypes.ts'),
      'utf8',
    )
    expect(text).toContain("domain: 'id' | 'name'")
    expect(text).not.toContain("domain?: 'id' | 'name'")
    expect(text).not.toContain("group.domain ?? 'id'")
  })
})
