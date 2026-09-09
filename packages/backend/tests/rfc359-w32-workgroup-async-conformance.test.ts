import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import { users, workgroups, workgroupMembers } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createAgent } from '@/services/agent'
import { ConflictError } from '@/util/errors'
import {
  createWorkgroup,
  copyWorkgroup,
  getWorkgroupById,
  saveWorkgroup,
  prepareWorkgroupSave,
  commitWorkgroupSaveInTx,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import {
  workgroupDraftSnapshotOf,
  workgroupRevisionOf,
} from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import { describeEachProvider } from './helpers/eachProvider'

const principal = { kind: 'system', reason: 'rfc185 test' } as const
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

function groupInput(agentId: string) {
  return (over: Record<string, unknown> = {}) => ({
    name: 'squad',
    description: '',
    instructions: '',
    mode: 'leader_worker' as const,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 5,
    completionGate: false,
    members: [{ memberType: 'agent' as const, agentId, displayName: 'a1', roleDesc: '' }],
    ...over,
  })
}
async function seed(
  db: ProviderNeutralDatabase,
  name: string,
  owner?: { ownerUserId: string; actor: Actor },
) {
  const agent = await createAgent(
    db,
    {
      name: 'a1',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    },
    owner,
  )
  return await createWorkgroup(db, groupInput(agent.id)({ name }), owner)
}
async function rows(db: ProviderNeutralDatabase) {
  return {
    groups: await db.select().from(workgroups).orderBy(workgroups.id).all(),
    members: await db.select().from(workgroupMembers).orderBy(workgroupMembers.id).all(),
  }
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

describeEachProvider('RFC359 W32 legacy Workgroup async persistence', (harness) => {
  test('preserves actual default rows and full committed and no-op receipts', async () => {
    const db = harness.db
    const created = await seed(db, 'w32-defaults')
    const before = await rows(db)
    expect(before.groups).toHaveLength(1)
    expect(before.members).toHaveLength(1)
    expect(await getWorkgroupById(db, created.id)).toEqual(created)
    const snapshot = { ...workgroupDraftSnapshotOf(created), description: 'updated' }
    const clientMutationId = ulid()
    const result = await saveWorkgroup(
      db,
      created.id,
      { expectedVersion: created.version, clientMutationId, snapshot },
      principal,
    )
    const current = (await getWorkgroupById(db, created.id))!
    expect(result).toEqual({
      clientMutationId,
      requestedBaseVersion: created.version,
      revision: workgroupRevisionOf(current),
      snapshot: workgroupDraftSnapshotOf(current),
      workgroup: current,
      outcome: 'committed',
    })
    const committed = await rows(db)
    expect(committed.groups[0]).toEqual({
      ...before.groups[0]!,
      description: 'updated',
      version: 2,
      updatedAt: current.updatedAt,
    })
    expect(committed.members).toEqual(before.members)
    const noOpId = ulid()
    const noOp = await saveWorkgroup(
      db,
      created.id,
      {
        expectedVersion: current.version,
        clientMutationId: noOpId,
        snapshot: workgroupDraftSnapshotOf(current),
      },
      principal,
    )
    expect(noOp).toEqual({
      clientMutationId: noOpId,
      requestedBaseVersion: current.version,
      revision: workgroupRevisionOf(current),
      snapshot: workgroupDraftSnapshotOf(current),
      workgroup: current,
      outcome: 'already-current',
    })
    expect(await rows(db)).toEqual(committed)
  })
  test('copies through the original owner and occupied-name reads', async () => {
    const db = harness.db
    const userId = ulid()
    await seedUser(db, userId)
    const authority = actor(userId)
    const created = await seed(db, 'w32-copy', { ownerUserId: userId, actor: authority })
    const revision = workgroupRevisionOf(created)
    const input = { expectedVersion: revision.version, expectedSnapshotHash: revision.snapshotHash }
    const first = await copyWorkgroup(db, created.id, input, authority)
    const second = await copyWorkgroup(db, created.id, input, authority)
    expect(first.id).not.toBe(created.id)
    expect(second.id).not.toBe(first.id)
    expect(second.name).not.toBe(first.name)
    expect(first.version).toBe(1)
    expect(second.version).toBe(1)
    expect({ ...workgroupDraftSnapshotOf(first), name: created.name }).toEqual(
      workgroupDraftSnapshotOf(created),
    )
    expect((await rows(db)).groups).toHaveLength(3)
    expect((await rows(db)).members).toHaveLength(3)
  })
  test('reads the actual prepared write inside its transaction and rolls back both tables', async () => {
    const db = harness.db
    const created = await seed(db, 'w32-rollback')
    const before = await rows(db)
    const snapshot = {
      ...workgroupDraftSnapshotOf(created),
      description: 'rolled back',
      members: workgroupDraftSnapshotOf(created).members.map((m) => ({
        ...m,
        displayName: 'renamed',
      })),
    }
    const prepared = await prepareWorkgroupSave(
      db,
      created.id,
      { expectedVersion: created.version, clientMutationId: ulid(), snapshot },
      principal,
    )
    const failure = new Error('w32 actual transaction rollback')
    await expect(
      databaseSessionFor(db).transaction(async (tx) => {
        const result = await commitWorkgroupSaveInTx(tx, prepared)
        expect(result.committed).toBe(true)
        expect(
          (await tx.select().from(workgroups).where(eq(workgroups.id, created.id)).get())
            ?.description,
        ).toBe('rolled back')
        expect(
          (
            await tx
              .select()
              .from(workgroupMembers)
              .where(eq(workgroupMembers.workgroupId, created.id))
              .all()
          ).map((m) => m.displayName),
        ).toEqual(['renamed'])
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await rows(db)).toEqual(before)
  })
  test('preserves the exact stale failure and the complete winning rows', async () => {
    const db = harness.db
    const created = await seed(db, 'w32-stale')
    const snapshot = { ...workgroupDraftSnapshotOf(created), description: 'stale' }
    const prepared = await prepareWorkgroupSave(
      db,
      created.id,
      { expectedVersion: created.version, clientMutationId: ulid(), snapshot },
      principal,
    )
    await saveWorkgroup(
      db,
      created.id,
      {
        expectedVersion: created.version,
        clientMutationId: ulid(),
        snapshot: { ...snapshot, description: 'winner' },
      },
      principal,
    )
    const before = await rows(db)
    const pending = databaseSessionFor(db).transaction(
      async (tx) => await commitWorkgroupSaveInTx(tx, prepared),
    )
    await expect(pending).rejects.toBeInstanceOf(ConflictError)
    await expect(pending).rejects.toThrow(`workgroup '${created.id}' is at version 2, expected 1`)
    expect(await rows(db)).toEqual(before)
  })
  test('awaits the original create hook before actual write and publication', async () => {
    const db = harness.db
    const agent = await createAgent(db, {
      name: 'a1',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const entered = deferred(),
      release = deferred(),
      finished = deferred()
    let observed: Awaited<ReturnType<typeof rows>> | undefined
    const pending = createWorkgroup(db, groupInput(agent.id)({ name: 'w32-create-hook' }), {
      beforeWriteTransaction: async () => {
        entered.release()
        await release.promise
        observed = await rows(db)
        finished.release()
      },
    })
    try {
      await entered.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    } finally {
      release.release()
      await pending
      await finished.promise
    }
    expect(observed).toEqual({ groups: [], members: [] })
    expect((await rows(db)).groups).toHaveLength(1)
  })
  test('awaits the original save hook before actual write and publication', async () => {
    const db = harness.db
    const created = await seed(db, 'w32-save-hook')
    const before = await rows(db)
    const entered = deferred(),
      release = deferred(),
      finished = deferred()
    let observed: Awaited<ReturnType<typeof rows>> | undefined
    const pending = saveWorkgroup(
      db,
      created.id,
      {
        expectedVersion: created.version,
        clientMutationId: ulid(),
        snapshot: { ...workgroupDraftSnapshotOf(created), description: 'guarded' },
      },
      principal,
      {
        beforeWriteTransaction: async () => {
          entered.release()
          await release.promise
          observed = await rows(db)
          finished.release()
        },
      },
    )
    try {
      await entered.promise
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    } finally {
      release.release()
      await pending
      await finished.promise
    }
    expect(observed).toEqual(before)
    expect((await rows(db)).groups[0]?.description).toBe('guarded')
  })
})
