// RFC-225 T1-T3 — workgroup saves are exact version-fenced document writes.

import {
  CreateWorkgroupSchema,
  type SaveWorkgroupReceipt,
  type WorkgroupDetail,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  createWorkgroup,
  getWorkgroupById,
  saveWorkgroup,
  workgroupDraftSnapshotOf,
  workgroupSnapshotHashOf,
  type WorkgroupWritePrincipal,
} from '../src/services/workgroups'
import { DomainError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SYSTEM: WorkgroupWritePrincipal = { kind: 'system', reason: 'rfc225-test' }

async function createFixture(db: DbClient, name = 'revision-team'): Promise<WorkgroupDetail> {
  return createWorkgroup(
    db,
    CreateWorkgroupSchema.parse({
      name,
      description: '',
      instructions: 'coordinate',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 12,
      completionGate: true,
      clarifyBudget: 3,
      fanOut: false,
      members: [
        {
          memberType: 'agent',
          agentName: 'legacy-dangling-agent',
          displayName: 'lead',
          roleDesc: 'lead',
        },
      ],
    }),
  )
}

function save(
  db: DbClient,
  current: WorkgroupDetail,
  snapshot: WorkgroupDraftSnapshot,
  opts: { expectedVersion?: number; mutationId?: string } = {},
): Promise<SaveWorkgroupReceipt> {
  return saveWorkgroup(
    db,
    current.id,
    {
      expectedVersion: opts.expectedVersion ?? current.version,
      clientMutationId: opts.mutationId ?? ulid(),
      snapshot,
    },
    SYSTEM,
  )
}

function codeOf(reason: unknown): string | undefined {
  return reason instanceof DomainError ? reason.code : undefined
}

describe('RFC-225 workgroup revision fencing', () => {
  test('create returns v1 detail with a canonical hash', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const group = await createFixture(db)
    expect(group.version).toBe(1)
    expect(group.snapshotHash).toBe(workgroupSnapshotHashOf(workgroupDraftSnapshotOf(group)))
    expect(group.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('config-only save preserves member ids; exact replay is a physical no-op', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const group = await createFixture(db)
    const memberIds = group.members.map((member) => member.id)
    const mutationId = ulid()
    const snapshot = { ...workgroupDraftSnapshotOf(group), instructions: 'changed' }

    const committed = await save(db, group, snapshot, { mutationId })
    expect(committed.outcome).toBe('committed')
    expect(committed.revision.version).toBe(2)
    expect(committed.workgroup.members.map((member) => member.id)).toEqual(memberIds)

    const replay = await save(db, group, snapshot, {
      expectedVersion: 1,
      mutationId,
    })
    expect(replay.outcome).toBe('already-current')
    expect(replay.revision).toEqual(committed.revision)
    expect(replay.workgroup.members.map((member) => member.id)).toEqual(memberIds)
  })

  test('roster change replaces member rows atomically', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const group = await createFixture(db)
    const oldId = group.members[0]!.id
    const receipt = await save(db, group, {
      ...workgroupDraftSnapshotOf(group),
      leaderDisplayName: 'lead',
      members: [
        {
          memberType: 'agent',
          agentName: 'legacy-dangling-agent',
          displayName: 'lead',
          roleDesc: 'updated role',
        },
      ],
    })
    expect(receipt.workgroup.members[0]!.id).not.toBe(oldId)
    expect(receipt.workgroup.members[0]!.roleDesc).toBe('updated role')
  })

  test('two different writers from v1 cannot both commit', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const group = await createFixture(db)
    const base = workgroupDraftSnapshotOf(group)
    const first = await save(db, group, { ...base, description: 'first' })
    expect(first.revision.version).toBe(2)

    try {
      await save(db, group, { ...base, description: 'second' }, { expectedVersion: 1 })
      throw new Error('expected version conflict')
    } catch (error) {
      expect(codeOf(error)).toBe('workgroup-version-conflict')
    }
    const latest = await getWorkgroupById(db, group.id)
    expect(latest?.description).toBe('first')
    expect(latest?.version).toBe(2)
  })

  test('current-version semantic no-op does not mint a revision', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const group = await createFixture(db)
    const receipt = await save(db, group, workgroupDraftSnapshotOf(group))
    expect(receipt.outcome).toBe('already-current')
    expect(receipt.revision.version).toBe(1)
    expect((await getWorkgroupById(db, group.id))?.version).toBe(1)
  })
})
