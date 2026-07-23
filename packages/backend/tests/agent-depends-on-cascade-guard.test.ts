// Locks RFC-022 §2.1 #5 delete reverse-dep guard and RFC-223 rename stability.
// Delete still refuses while an id is referenced; rename succeeds because the
// reference remains bound to the same canonical row.
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
import type { Agent } from '@agent-workflow/shared'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seed(db: DbClient, name: string, dependsOn: string[] = []): Promise<Agent> {
  return createAgent(db, {
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
    const auditor = await seed(db, 'auditor')
    const orchestrator = await seed(db, 'orchestrator', [auditor.id])

    await expect(deleteAgent(db, auditor.id, T6_ACTOR)).rejects.toBeInstanceOf(ConflictError)
    try {
      await deleteAgent(db, auditor.id, T6_ACTOR)
    } catch (e) {
      const err = e as ConflictError
      expect(err.code).toBe('agent-dependency-still-referenced')
      expect(err.details).toEqual({
        visible: [{ id: expect.any(String), name: 'orchestrator' }],
        hiddenCount: 0,
      })
    }

    // Sanity: once orchestrator is unbound, the delete proceeds.
    await updateAgent(db, orchestrator.id, { dependsOn: [] })
    await expect(deleteAgent(db, auditor.id, T6_ACTOR)).resolves.toBeUndefined()
  })

  test('renameAgent preserves another agent.dependsOn id', async () => {
    const auditor = await seed(db, 'auditor')
    const orchestrator = await seed(db, 'orchestrator', [auditor.id])

    await expect(renameAgent(db, auditor.id, { newName: 'reviewer' })).resolves.toMatchObject({
      id: auditor.id,
      name: 'reviewer',
    })
    expect(orchestrator.dependsOn).toEqual([auditor.id])
  })

  test('updateAgent surfaces validateDependsOn errors (unknown name → 400)', async () => {
    const orchestrator = await seed(db, 'orchestrator')
    await expect(
      updateAgent(db, orchestrator.id, { dependsOn: ['no-such-agent'] }),
    ).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
    })
  })
})
