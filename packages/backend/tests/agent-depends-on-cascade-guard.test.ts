// Locks RFC-022 §2.1 #5 (delete / rename reverse-dep guard) — design.md
// §4.1 #3 and #4. Red here means deleteAgent / renameAgent let a referenced
// row vanish out from under another agent's dependsOn, leaving a runtime
// dangling reference that surfaces as `agent-dependency-not-found` only when
// the consuming task actually spawns. We refuse upfront.
//
// Also locks updateAgent → validateDependsOn integration: patching dependsOn
// to point at an unknown name MUST return 400 from the service layer, not
// silently land in the DB.

import { buildActor } from '../src/auth/actor'
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, deleteAgent, renameAgent, updateAgent } from '../src/services/agent'
import { ConflictError } from '../src/util/errors'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seed(db: DbClient, name: string, dependsOn: string[] = []): Promise<void> {
  await createAgent(db, {
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn,
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  })
}

describe('RFC-022 reverse-dep guard on delete / rename', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('deleteAgent refuses when another agent.dependsOn references it', async () => {
    await seed(db, 'auditor')
    await seed(db, 'orchestrator', ['auditor'])

    await expect(deleteAgent(db, 'auditor', T6_ACTOR)).rejects.toBeInstanceOf(ConflictError)
    try {
      await deleteAgent(db, 'auditor', T6_ACTOR)
    } catch (e) {
      const err = e as ConflictError
      expect(err.code).toBe('agent-dependency-still-referenced')
      expect(err.details).toEqual({
        visible: [{ id: expect.any(String), name: 'orchestrator' }],
        hiddenCount: 0,
      })
    }

    // Sanity: once orchestrator is unbound, the delete proceeds.
    await updateAgent(db, 'orchestrator', { dependsOn: [] })
    await expect(deleteAgent(db, 'auditor', T6_ACTOR)).resolves.toBeUndefined()
  })

  test('renameAgent refuses when another agent.dependsOn references it', async () => {
    await seed(db, 'auditor')
    await seed(db, 'orchestrator', ['auditor'])

    await expect(
      renameAgent(db, 'auditor', { newName: 'reviewer' }, T6_ACTOR),
    ).rejects.toBeInstanceOf(ConflictError)
    try {
      await renameAgent(db, 'auditor', { newName: 'reviewer' }, T6_ACTOR)
    } catch (e) {
      const err = e as ConflictError
      expect(err.code).toBe('agent-dependency-still-referenced')
      expect(err.details).toEqual({
        visible: [{ id: expect.any(String), name: 'orchestrator' }],
        hiddenCount: 0,
      })
    }
  })

  test('updateAgent surfaces validateDependsOn errors (unknown name → 400)', async () => {
    await seed(db, 'orchestrator')
    await expect(
      updateAgent(db, 'orchestrator', { dependsOn: ['no-such-agent'] }),
    ).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
    })
  })
})
