// RFC-167 T3 — dynamic workflow space CRUD service. Locks:
//  1. create → get round-trip; pool de-duped on write; empty pool is valid.
//  2. update (description / pool full-replace); rename; delete.
//  3. name-in-use conflict on create + rename; not-found on update/delete/rename.
//  4. malformed agent_pool_json column degrades to [].
//  5. diffNewPoolAgentNames returns only newly-added names (D15 input).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { dynamicWorkflowSpaces } from '../src/db/schema'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createDynamicWorkflowSpace,
  deleteDynamicWorkflowSpace,
  diffNewPoolAgentNames,
  getDynamicWorkflowSpace,
  listDynamicWorkflowSpaces,
  renameDynamicWorkflowSpace,
  updateDynamicWorkflowSpace,
} from '../src/services/dynamicWorkflowSpaces'
import { ConflictError, NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-167 dynamic workflow space CRUD', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('create → get round-trip; pool de-duped; owner + public default', async () => {
    const created = await createDynamicWorkflowSpace(
      db,
      { name: 'squad', description: 'a space', agentPool: ['coder', 'auditor', 'coder'] },
      { ownerUserId: 'u1' },
    )
    expect(created.agentPool).toEqual(['coder', 'auditor']) // de-duped, order preserved
    expect(created.ownerUserId).toBe('u1')
    expect(created.visibility).toBe('public')
    const fetched = await getDynamicWorkflowSpace(db, 'squad')
    expect(fetched?.agentPool).toEqual(['coder', 'auditor'])
  })

  test('empty pool is a valid quick-create', async () => {
    const created = await createDynamicWorkflowSpace(db, {
      name: 'empty',
      description: '',
      agentPool: [],
    })
    expect(created.agentPool).toEqual([])
    expect(created.ownerUserId).toBeNull()
  })

  test('duplicate name → ConflictError', async () => {
    await createDynamicWorkflowSpace(db, { name: 'dup', description: '', agentPool: [] })
    await expect(
      createDynamicWorkflowSpace(db, { name: 'dup', description: '', agentPool: [] }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('update replaces description + pool wholesale', async () => {
    await createDynamicWorkflowSpace(db, { name: 's', description: 'old', agentPool: ['a'] })
    const updated = await updateDynamicWorkflowSpace(db, 's', {
      description: 'new',
      agentPool: ['b', 'c', 'b'],
    })
    expect(updated.description).toBe('new')
    expect(updated.agentPool).toEqual(['b', 'c'])
  })

  test('update without pool leaves it untouched', async () => {
    await createDynamicWorkflowSpace(db, { name: 's', description: '', agentPool: ['a'] })
    const updated = await updateDynamicWorkflowSpace(db, 's', { description: 'changed' })
    expect(updated.agentPool).toEqual(['a'])
  })

  test('update / delete / rename on a missing space → NotFoundError', async () => {
    await expect(updateDynamicWorkflowSpace(db, 'ghost', {})).rejects.toBeInstanceOf(NotFoundError)
    await expect(deleteDynamicWorkflowSpace(db, 'ghost')).rejects.toBeInstanceOf(NotFoundError)
    await expect(renameDynamicWorkflowSpace(db, 'ghost', 'x')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('rename moves the row; old name 404s, name-in-use conflicts', async () => {
    await createDynamicWorkflowSpace(db, { name: 'old', description: '', agentPool: [] })
    await createDynamicWorkflowSpace(db, { name: 'taken', description: '', agentPool: [] })
    const renamed = await renameDynamicWorkflowSpace(db, 'old', 'fresh')
    expect(renamed.name).toBe('fresh')
    expect(await getDynamicWorkflowSpace(db, 'old')).toBeNull()
    await expect(renameDynamicWorkflowSpace(db, 'fresh', 'taken')).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  test('delete removes the row', async () => {
    await createDynamicWorkflowSpace(db, { name: 'gone', description: '', agentPool: [] })
    await deleteDynamicWorkflowSpace(db, 'gone')
    expect(await getDynamicWorkflowSpace(db, 'gone')).toBeNull()
    expect(await listDynamicWorkflowSpaces(db)).toEqual([])
  })

  test('malformed agent_pool_json column degrades to []', async () => {
    await createDynamicWorkflowSpace(db, { name: 's', description: '', agentPool: ['a'] })
    await db
      .update(dynamicWorkflowSpaces)
      .set({ agentPoolJson: 'not json' })
      .where(eq(dynamicWorkflowSpaces.name, 's'))
    expect((await getDynamicWorkflowSpace(db, 's'))?.agentPool).toEqual([])
  })
})

describe('diffNewPoolAgentNames (D15 ref-usability input)', () => {
  test('returns only names not already in prev', () => {
    expect(diffNewPoolAgentNames(null, ['a', 'b'])).toEqual(['a', 'b'])
    expect(diffNewPoolAgentNames({ agentPool: ['a'] }, ['a', 'b'])).toEqual(['b'])
    expect(diffNewPoolAgentNames({ agentPool: ['a', 'b'] }, ['a', 'b'])).toEqual([])
  })
})
