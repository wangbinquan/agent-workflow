import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { queryRows } from '@/platform/persistence/queryHelpers'
import { type WorkflowDefinition } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  getWorkflow,
  workflowDraftSnapshotOf,
  workflowRevisionOf,
  workflowSnapshotHashOf,
} from '../src/services/workflow'

import { describeEachProvider } from './helpers/eachProvider'
import { copyWorkflow, createWorkflow, updateWorkflow } from './helpers/model/resourceWrites'

const definition: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
const principal = { kind: 'system', reason: 'rfc199-exact-operation-test' } as const

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: PersistenceDb, id: string, role: 'admin' | 'user' = 'user') {
  const { users } = tablesOf(db)
  await insertOne(db, users, {
    id,
    username: id,
    displayName: id,
    role,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

async function rows(db: PersistenceDb) {
  const { workflows } = tablesOf(db)
  return queryRows(db.select().from(workflows).orderBy(workflows.id))
}

async function seed(db: PersistenceDb, name: string) {
  return createWorkflow(db, { name, description: 'original', definition })
}

// RFC-401 T6 (proposal G5): the legacy workflow writers are deleted; these cases run on the
// fixture writers (`helpers/model/resourceWrites.ts`), i.e. the one workflow write participant.
// The prepared-write, stale-prepare and in-transaction guard cases locked the deleted two-phase
// seams (`prepareWorkflowSave` / `commitWorkflowSaveInTx` / `inTxGuard`) and went with them.
describeEachProvider('RFC359 W31 workflow async persistence', (harness) => {
  test('preserves default rows and exact committed/no-op receipts', async () => {
    const db = harness.db
    const created = await seed(db, 'w31-defaults')
    const before = await rows(db)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({
      id: created.id,
      name: created.name,
      description: 'original',
      version: 1,
    })
    const snapshot = { ...workflowDraftSnapshotOf(created), description: 'updated' }
    const clientMutationId = ulid()
    const result = await updateWorkflow(
      db,
      created.id,
      { expectedVersion: 1, clientMutationId, snapshot },
      principal,
    )
    const current = await getWorkflow(db, created.id)
    expect(current).not.toBeNull()
    expect(result).toEqual({
      clientMutationId,
      requestedBaseVersion: 1,
      revision: workflowRevisionOf(current!),
      snapshot: workflowDraftSnapshotOf(current!),
      outcome: 'committed',
    })
    const committed = await rows(db)
    expect(committed[0]).toEqual({
      ...before[0]!,
      description: 'updated',
      version: 2,
      updatedAt: current!.updatedAt,
    })
    const noOpId = ulid()
    const noOp = await updateWorkflow(
      db,
      created.id,
      { expectedVersion: 2, clientMutationId: noOpId, snapshot: workflowDraftSnapshotOf(current!) },
      principal,
    )
    expect(noOp).toEqual({
      clientMutationId: noOpId,
      requestedBaseVersion: 2,
      revision: workflowRevisionOf(current!),
      snapshot: workflowDraftSnapshotOf(current!),
      outcome: 'already-current',
    })
    expect(await rows(db)).toEqual(committed)
  })

  test('copies through the original owner with occupied-name reads', async () => {
    const db = harness.db
    const userId = 'w31-copy-owner'
    await seedUser(db, userId)
    const source = await createWorkflow(
      db,
      { name: 'w31-copy-source', description: 'copy data', definition },
      { ownerUserId: userId },
    )
    const input = {
      expectedVersion: source.version,
      expectedSnapshotHash: workflowSnapshotHashOf(workflowDraftSnapshotOf(source)),
    }
    const first = await copyWorkflow(db, source.id, input, actor(userId))
    const second = await copyWorkflow(db, source.id, input, actor(userId))
    expect(first.name).not.toBe(source.name)
    expect(second.name).not.toBe(first.name)
    expect(first.definition).toEqual(source.definition)
    expect(second.definition).toEqual(source.definition)
    expect(first.description).toBe(source.description)
    expect(second.description).toBe(source.description)
    expect(first.version).toBe(1)
    expect(second.version).toBe(1)
    expect(await rows(db)).toHaveLength(3)
  })
})
