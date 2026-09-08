// RFC-359 AC1: keep both established Workgroup entry points and their original
// row/snapshot/hash behavior while sharing the six pure codec algorithms.
// The database cases run on real provider fixtures; the old synchronous writer
// is still exercised by the existing RFC-225 revision cases.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ZodError } from 'zod'
import { serializeWorkgroupEditableSnapshotV1, type Workgroup } from '@agent-workflow/shared'
import { workgroupMembers, workgroups } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { workgroupRepositoryDependencies } from '@/modules/resource-catalog/composition/workgroupOperations'
import {
  rowToWorkgroup,
  workgroupDraftSnapshotOf,
  workgroupRevisionOf,
  workgroupSnapshotHashOf,
  workgroupToDetail,
} from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import {
  createWorkgroupRepository,
  workgroupFromRows,
} from '@/modules/resource-catalog/infrastructure/workgroupRepository'
import { describeEachProvider } from './helpers/eachProvider'

type WorkgroupRow = typeof workgroups.$inferSelect
type MemberRow = typeof workgroupMembers.$inferSelect
const T0 = 1_700_000_000_000

function rowFixture(mode: WorkgroupRow['mode'] = 'leader_worker'): WorkgroupRow {
  return {
    id: 'wg-codec',
    name: 'codec-team',
    description: 'stored description',
    instructions: 'coordinate the work',
    mode,
    outputContract: 'discussion',
    leaderMemberId: mode === 'leader_worker' ? 'member-lead' : null,
    shareOutputs: false,
    directMessages: true,
    blackboard: false,
    maxRounds: 12,
    completionGate: true,
    clarifyBudget: 5,
    fanOut: mode === 'leader_worker',
    version: 7,
    ownerUserId: 'opaque-owner',
    visibility: 'private',
    aclRevision: 11,
    schemaVersion: 1,
    createdAt: T0,
    updatedAt: T0 + 45,
  }
}

function memberFixtures(mode: WorkgroupRow['mode'] = 'leader_worker'): MemberRow[] {
  return [
    {
      id: 'member-zulu',
      workgroupId: 'wg-codec',
      memberType: 'agent',
      agentName: 'Stored Zulu',
      agentId: 'agent-zulu',
      userId: null,
      displayName: 'Zulu',
      roleDesc: 'implement',
      sortOrder: 1,
      createdAt: T0 + 1,
    },
    {
      id: 'member-alpha',
      workgroupId: 'wg-codec',
      memberType: mode === 'dynamic_workflow' ? 'agent' : 'human',
      agentName: mode === 'dynamic_workflow' ? 'Stored Alpha' : null,
      agentId: mode === 'dynamic_workflow' ? 'agent-alpha' : null,
      userId: mode === 'dynamic_workflow' ? null : 'opaque-human',
      displayName: 'Alpha',
      roleDesc: 'review',
      sortOrder: 1,
      createdAt: T0 + 2,
    },
    {
      id: 'member-lead',
      workgroupId: 'wg-codec',
      memberType: 'agent',
      agentName: 'Stored Lead',
      agentId: 'agent-lead',
      userId: null,
      displayName: 'Lead',
      roleDesc: 'coordinate',
      sortOrder: 0,
      createdAt: T0 + 3,
    },
  ]
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// Fixed old-entry goldens include every DTO field and the exact editable bytes.
const OLD_GOLDENS = {
  leader_worker: {
    dto: '5e393ea08d9c6eb12e96224c9678b1a6fe0c036b4f260bf47887fd9576824964',
    snapshot: 'c127a5ade98f5816cdc9e49eea271b471a2e4b56eaaf05ffe6ebe878ae8e4ad1',
  },
  free_collab: {
    dto: 'd2735b543d18be8b66d0c9e6060f96057241b4a947eaa95e1af28611bd846e3f',
    snapshot: '57d104ce3327ec4aac86407335fc1b7f23f6e547a5f3a6e2d692ef59b3f869a9',
  },
  dynamic_workflow: {
    dto: '01d15d6d4b9d993b657b429886a63efd92089b7b1e0d26aa26f92581886e2913',
    snapshot: '0bf589af129aec676af98d79106ee201bba3b42e66a1f5369f11503d9cece0c3',
  },
}

function repositoryFor(db: ProviderNeutralDatabase) {
  return createWorkgroupRepository(db, workgroupRepositoryDependencies({ db, now: () => T0 + 50 }))
}

async function seed(db: ProviderNeutralDatabase, mode: WorkgroupRow['mode'] = 'leader_worker') {
  await db.insert(workgroups).values(rowFixture(mode)).run()
  await db.insert(workgroupMembers).values(memberFixtures(mode)).run()
}

function thrownBy(run: () => unknown): unknown {
  try {
    run()
    throw new Error('expected the codec to throw')
  } catch (error) {
    return error
  }
}

describeEachProvider('RFC-359 Workgroup codec on stored rows', (harness) => {
  for (const mode of ['leader_worker', 'free_collab', 'dynamic_workflow'] as const) {
    test(`${mode}: real repository and legacy codec preserve complete rows, order and snapshot bytes`, async () => {
      await seed(harness.db, mode)
      const { repository, projection } = repositoryFor(harness.db)
      const stored = await harness.db
        .select()
        .from(workgroups)
        .where(eq(workgroups.id, 'wg-codec'))
        .get()
      const members = await harness.db
        .select()
        .from(workgroupMembers)
        .orderBy(workgroupMembers.id)
        .all()
      expect(stored).toBeDefined()
      if (stored === undefined) throw new Error('missing stored group')
      const originalMemberOrder = members.map((member) => member.id)
      const legacy = rowToWorkgroup(stored, members)
      const neutral = workgroupFromRows(stored, members)
      expect(neutral).toEqual(legacy)
      expect(digest(JSON.stringify(neutral))).toBe(OLD_GOLDENS[mode].dto)
      expect(members.map((member) => member.id)).toEqual(originalMemberOrder)
      expect(neutral.members.map((member) => member.displayName)).toEqual(['Lead', 'Alpha', 'Zulu'])
      const detail = await repository.get(stored.id)
      expect(detail).toEqual(workgroupToDetail(legacy))
      expect(await repository.list()).toEqual([neutral])
      const snapshot = projection.snapshotOf(neutral)
      expect(snapshot).toEqual(workgroupDraftSnapshotOf(legacy))
      expect(workgroupSnapshotHashOf(snapshot)).toBe(OLD_GOLDENS[mode].snapshot)
      expect(digest(serializeWorkgroupEditableSnapshotV1(snapshot))).toBe(
        OLD_GOLDENS[mode].snapshot,
      )
      expect(workgroupRevisionOf(neutral)).toEqual({
        workgroupId: stored.id,
        version: 7,
        snapshotHash: OLD_GOLDENS[mode].snapshot,
        updatedAt: T0 + 45,
      })
      expect(snapshot.leaderDisplayName).toBe(mode === 'leader_worker' ? 'Lead' : undefined)
    })
  }

  test('stored revision and member IDs can change without changing editable snapshot bytes', async () => {
    await seed(harness.db)
    const { repository, projection } = repositoryFor(harness.db)
    const before = await repository.get('wg-codec')
    if (before === null) throw new Error('missing original group')
    await harness.session.transaction(async (tx) => {
      await tx.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, 'wg-codec')).run()
      await tx
        .insert(workgroupMembers)
        .values(
          memberFixtures().map((member) => ({
            ...member,
            id: `replacement-${member.id}`,
            createdAt: T0 + 100,
          })),
        )
        .run()
      await tx
        .update(workgroups)
        .set({
          leaderMemberId: 'replacement-member-lead',
          version: 8,
          updatedAt: T0 + 100,
        })
        .where(eq(workgroups.id, 'wg-codec'))
        .run()
    })
    const after = await repository.get('wg-codec')
    if (after === null) throw new Error('missing updated group')
    expect(after.members.map((member) => member.id)).toEqual([
      'replacement-member-lead',
      'replacement-member-alpha',
      'replacement-member-zulu',
    ])
    expect(projection.snapshotOf(after)).toEqual(projection.snapshotOf(before))
    expect(after.snapshotHash).toBe(before.snapshotHash)
    expect(workgroupRevisionOf(after)).toEqual({
      workgroupId: before.id,
      version: 8,
      snapshotHash: before.snapshotHash,
      updatedAt: T0 + 100,
    })
  })

  test('transaction-bound projection sees changed rows and rollback restores document and hash', async () => {
    await seed(harness.db)
    const { repository } = repositoryFor(harness.db)
    const before = await repository.get('wg-codec')
    const failure = new Error('rollback the workgroup document')
    await expect(
      harness.session.transaction(async (tx) => {
        await tx
          .update(workgroups)
          .set({ instructions: 'uncommitted', version: 8 })
          .where(eq(workgroups.id, 'wg-codec'))
          .run()
        await tx
          .update(workgroupMembers)
          .set({ roleDesc: 'uncommitted role' })
          .where(eq(workgroupMembers.id, 'member-zulu'))
          .run()
        const row = await tx.select().from(workgroups).where(eq(workgroups.id, 'wg-codec')).get()
        const members = await tx
          .select()
          .from(workgroupMembers)
          .where(eq(workgroupMembers.workgroupId, 'wg-codec'))
          .all()
        if (row === undefined) throw new Error('missing transaction group')
        const detail = workgroupToDetail(workgroupFromRows(row, members))
        expect(detail.instructions).toBe('uncommitted')
        expect(detail.members.find((member) => member.id === 'member-zulu')?.roleDesc).toBe(
          'uncommitted role',
        )
        expect(detail.snapshotHash).not.toBe(before?.snapshotHash)
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await repository.get('wg-codec')).toEqual(before)
  })

  test('stored malformed editable content keeps the original schema issue ordering', async () => {
    await seed(harness.db)
    await harness.db
      .update(workgroups)
      .set({ name: '', maxRounds: 0 })
      .where(eq(workgroups.id, 'wg-codec'))
      .run()
    const { repository, projection } = repositoryFor(harness.db)
    const row = await harness.db
      .select()
      .from(workgroups)
      .where(eq(workgroups.id, 'wg-codec'))
      .get()
    const members = await harness.db.select().from(workgroupMembers).all()
    if (row === undefined) throw new Error('missing corrupt group')
    const group = rowToWorkgroup(row, members)
    const legacyError = thrownBy(() => workgroupDraftSnapshotOf(group))
    const neutralError = thrownBy(() => projection.snapshotOf(group))
    expect(legacyError).toBeInstanceOf(ZodError)
    expect(neutralError).toBeInstanceOf(ZodError)
    if (!(legacyError instanceof ZodError) || !(neutralError instanceof ZodError)) {
      throw new Error('expected the original schema errors')
    }
    expect(neutralError.issues).toEqual(legacyError.issues)
    expect(legacyError.issues.map((issue) => issue.path)).toEqual([
      ['name'],
      ['name'],
      ['maxRounds'],
    ])
    await expect(repository.get('wg-codec')).rejects.toThrow(ZodError)
  })
})

describe('Workgroup codec original JavaScript evaluation boundaries', () => {
  test('legacy slice preserves holes while the neutral spread keeps its original failure', () => {
    const sparse: MemberRow[] = []
    sparse[1] = memberFixtures()[0]!
    const legacy = rowToWorkgroup(rowFixture(), sparse)
    expect(legacy.members.length).toBe(2)
    expect(0 in legacy.members).toBe(true)
    expect(1 in legacy.members).toBe(false)
    expect(() => workgroupFromRows(rowFixture(), sparse)).toThrow(TypeError)
    expect(0 in sparse).toBe(false)
    expect(1 in sparse).toBe(true)
  })

  test('the two wrappers retain their original iterator and slice selection', () => {
    const members = [memberFixtures()[2]!]
    Object.defineProperty(members, Symbol.iterator, {
      value: function* () {
        yield memberFixtures()[0]!
      },
    })
    Object.defineProperty(members, 'slice', { value: () => [memberFixtures()[1]!] })
    expect(
      workgroupFromRows(rowFixture(), members).members.map((member) => member.displayName),
    ).toEqual(['Zulu'])
    expect(
      rowToWorkgroup(rowFixture(), members).members.map((member) => member.displayName),
    ).toEqual(['Alpha'])
    expect(members[0]?.displayName).toBe('Lead')
  })

  test('member projection still completes before reading group row fields', () => {
    for (const load of [rowToWorkgroup, workgroupFromRows]) {
      const row = rowFixture()
      const member = memberFixtures()[0]!
      const rowFailure = new Error('row must be evaluated later')
      const memberFailure = new Error('member evaluated first')
      Object.defineProperty(row, 'id', {
        get() {
          throw rowFailure
        },
      })
      Object.defineProperty(member, 'id', {
        get() {
          throw memberFailure
        },
      })
      expect(thrownBy(() => load(row, [member]))).toBe(memberFailure)
    }
  })

  test('detail spreads the document before evaluating the editable snapshot', () => {
    const group: Workgroup = rowToWorkgroup(rowFixture(), memberFixtures())
    const spreadFailure = new Error('name spread first')
    const snapshotFailure = new Error('members snapshot later')
    Object.defineProperty(group, 'name', {
      get() {
        throw spreadFailure
      },
    })
    Object.defineProperty(group, 'members', {
      get() {
        throw snapshotFailure
      },
    })
    expect(thrownBy(() => workgroupToDetail(group))).toBe(spreadFailure)
  })
})
