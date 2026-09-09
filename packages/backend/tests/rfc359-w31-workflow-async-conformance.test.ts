import { type WorkflowDefinition } from '@agent-workflow/shared'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { users, workflows } from '../src/db/schema'
import {
  commitWorkflowSaveInTx,
  copyWorkflow,
  createWorkflow,
  getWorkflow,
  prepareWorkflowSave,
  updateWorkflow,
  workflowDraftSnapshotOf,
  workflowRevisionOf,
  workflowSnapshotHashOf,
} from '../src/services/workflow'
import { ConflictError } from '../src/util/errors'
import { describeEachProvider } from './helpers/eachProvider'

const definition: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
const principal = { kind: 'system', reason: 'rfc199-exact-operation-test' } as const

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: ProviderNeutralDatabase, id: string, role: 'admin' | 'user' = 'user') {
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

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function rows(db: ProviderNeutralDatabase) {
  return db.select().from(workflows).orderBy(workflows.id).all()
}

async function seed(db: ProviderNeutralDatabase, name: string) {
  return createWorkflow(db, { name, description: 'original', definition })
}

describeEachProvider('RFC359 W31 legacy workflow async persistence', (harness) => {
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

  test('keeps a prepared write and its rollback in the actual transaction', async () => {
    const db = harness.db
    const created = await seed(db, 'w31-rollback')
    const before = await rows(db)
    const prepared = await prepareWorkflowSave(
      db,
      created.id,
      {
        expectedVersion: 1,
        clientMutationId: ulid(),
        snapshot: { ...workflowDraftSnapshotOf(created), description: 'rolled-back' },
      },
      principal,
    )
    const failure = new Error('w31-workflow-rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        const result = await commitWorkflowSaveInTx(tx, prepared)
        expect(result.committed).toBe(true)
        expect(
          (await tx.select().from(workflows).where(eq(workflows.id, created.id)).get())
            ?.description,
        ).toBe('rolled-back')
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await rows(db)).toEqual(before)
  })

  test('keeps the original stale revision failure and complete stored row', async () => {
    const db = harness.db
    const created = await seed(db, 'w31-stale')
    const prepared = await prepareWorkflowSave(
      db,
      created.id,
      {
        expectedVersion: 1,
        clientMutationId: ulid(),
        snapshot: { ...workflowDraftSnapshotOf(created), description: 'stale write' },
      },
      principal,
    )
    await updateWorkflow(
      db,
      created.id,
      {
        expectedVersion: 1,
        clientMutationId: ulid(),
        snapshot: { ...workflowDraftSnapshotOf(created), description: 'winner' },
      },
      principal,
    )
    const before = await rows(db)
    const pending = harness.session.transaction((tx) => commitWorkflowSaveInTx(tx, prepared))
    await expect(pending).rejects.toBeInstanceOf(ConflictError)
    await expect(pending).rejects.toMatchObject({
      message: `workflow '${created.id}' is at version 2, expected 1`,
    })
    expect(await rows(db)).toEqual(before)
  })

  test('awaits the create guard before the real INSERT', async () => {
    const db = harness.db
    const entered = gate(),
      release = gate(),
      finished = gate()
    const id = ulid()
    let observed: Awaited<ReturnType<typeof rows>> | undefined
    const pending = createWorkflow(
      db,
      { name: 'w31-create-gate', description: 'guarded', definition },
      {
        id,
        inTxGuard: {
          async assert(tx) {
            entered.release()
            try {
              await release.promise
              observed = await tx.select().from(workflows).where(eq(workflows.id, id)).all()
            } finally {
              finished.release()
            }
          },
        },
      },
    )
    try {
      await entered.promise
    } finally {
      release.release()
      await pending
      await finished.promise
    }
    expect(observed).toEqual([])
    expect((await rows(db)).map((row) => row.id)).toEqual([id])
  })

  test('awaits the save guard before the real UPDATE', async () => {
    const db = harness.db
    const created = await seed(db, 'w31-save-gate')
    const before = await rows(db)
    const entered = gate(),
      release = gate(),
      finished = gate()
    let observed: Awaited<ReturnType<typeof rows>> | undefined
    const pending = updateWorkflow(
      db,
      created.id,
      {
        expectedVersion: 1,
        clientMutationId: ulid(),
        snapshot: { ...workflowDraftSnapshotOf(created), description: 'guarded' },
      },
      principal,
      {
        inTxGuard: {
          async assert(tx) {
            entered.release()
            try {
              await release.promise
              observed = await rows(tx)
            } finally {
              finished.release()
            }
          },
        },
      },
    )
    try {
      await entered.promise
    } finally {
      release.release()
      await pending
      await finished.promise
    }
    expect(observed).toEqual(before)
    expect((await rows(db))[0]).toMatchObject({
      id: created.id,
      description: 'guarded',
      version: 2,
    })
  })
})
