import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'

import { expect, test } from 'bun:test'

import { ulid } from 'ulid'
import { buildActor, type Actor } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import { getWorkgroupById } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import {
  workgroupDraftSnapshotOf,
  workgroupRevisionOf,
} from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createAgent,
  createWorkgroup,
  copyWorkgroup,
  saveWorkgroup,
} from './helpers/model/resourceWrites'

const principal = { kind: 'system', reason: 'rfc185 test' } as const
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
  db: PersistenceDb,
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
async function rows(db: PersistenceDb) {
  const { workgroups, workgroupMembers } = tablesOf(db)
  return {
    groups: await db.select().from(workgroups).orderBy(workgroups.id),
    members: await db.select().from(workgroupMembers).orderBy(workgroupMembers.id),
  }
}

// RFC-401 T6 (proposal G5): the legacy workgroup writers are deleted; these cases run on the
// fixture writers (`helpers/model/resourceWrites.ts`), i.e. the one workgroup write participant.
// The prepared-write, stale-prepare and before-write hook cases locked the deleted two-phase seams
// (`prepareWorkgroupSave` / `commitWorkgroupSaveInTx`) and went with them.
describeEachProvider('RFC359 W32 Workgroup async persistence', (harness) => {
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
})
