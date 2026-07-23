// RFC-225 — workgroup WS producer and per-frame ACL regression locks.

import type { WorkgroupsWsMessage } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import { resourceGrants, users, workgroups } from '../src/db/schema'
import {
  createWorkgroup,
  deleteWorkgroup,
  saveWorkgroup,
  workgroupDraftSnapshotOf,
} from '../src/services/workgroups'
import {
  resetBroadcastersForTests,
  WORKGROUPS_CHANNEL,
  workgroupsBroadcaster,
  type WorkgroupDeletedAudienceContext,
} from '../src/ws/broadcaster'
import { WS_CHANNELS } from '../src/ws/registry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

beforeEach(() => resetBroadcastersForTests())
afterEach(() => resetBroadcastersForTests())

describe('RFC-225 workgroup broadcaster producers', () => {
  test('create/commit/delete emit exact frames; semantic replay emits nothing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const frames: WorkgroupsWsMessage[] = []
    const contexts: unknown[] = []
    workgroupsBroadcaster.subscribe(WORKGROUPS_CHANNEL, (message, context) => {
      frames.push(message)
      contexts.push(context)
    })

    const created = await createWorkgroup(db, {
      name: 'ws-team',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 20,
      completionGate: true,
      members: [],
    })
    expect(frames).toEqual([
      {
        type: 'workgroup.created',
        workgroupId: created.id,
        name: created.name,
        version: 1,
      },
    ])

    const clientMutationId = ulid()
    const committed = await saveWorkgroup(
      db,
      created.id,
      {
        expectedVersion: 1,
        clientMutationId,
        snapshot: { ...workgroupDraftSnapshotOf(created), instructions: 'changed' },
      },
      { kind: 'system', reason: 'ws-test' },
    )
    expect(frames.at(-1)).toEqual({
      type: 'workgroup.updated',
      workgroupId: created.id,
      clientMutationId,
      version: 2,
      snapshotHash: committed.revision.snapshotHash,
      updatedAt: committed.revision.updatedAt,
    })

    await saveWorkgroup(
      db,
      created.id,
      {
        expectedVersion: 1,
        clientMutationId,
        snapshot: committed.snapshot,
      },
      { kind: 'system', reason: 'ws-test-replay' },
    )
    expect(frames).toHaveLength(2)

    const deleteMutationId = ulid()
    await deleteWorkgroup(
      db,
      created.id,
      {
        expectedVersion: 2,
        clientMutationId: deleteMutationId,
        confirm: created.name,
      },
      { kind: 'system', reason: 'ws-test-delete' },
    )
    expect(frames.at(-1)).toEqual({
      type: 'workgroup.deleted',
      workgroupId: created.id,
      clientMutationId: deleteMutationId,
      deletedVersion: 2,
    })
    expect(contexts.at(-1)).toMatchObject({
      kind: 'workgroup.deleted-audience',
      workgroupId: created.id,
      visibility: 'public',
    })
  })
})

describe('RFC-225 workgroup WS frame gate', () => {
  test('private owner/grantee receive, stranger drops, ACL busts false cache', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workgroupId = ulid()
    const now = Date.now()
    await db.insert(users).values(
      ['alice', 'bob', 'carol'].map((id) => ({
        id,
        username: id,
        displayName: id,
        createdAt: now,
        updatedAt: now,
      })),
    )
    await db.insert(workgroups).values({
      id: workgroupId,
      name: 'private-team',
      ownerUserId: 'alice',
      visibility: 'private',
      version: 1,
    })
    await db.insert(resourceGrants).values({
      resourceType: 'workgroup',
      resourceId: workgroupId,
      userId: 'bob',
      addedBy: 'alice',
      addedAt: Date.now(),
    })
    const gate = WS_CHANNELS.workgroups.frameGate!
    const frame: WorkgroupsWsMessage = {
      type: 'workgroup.updated',
      workgroupId,
      clientMutationId: ulid(),
      version: 2,
      snapshotHash: '0'.repeat(64),
      updatedAt: 123,
    }
    const ctx = (id: string) => ({
      db,
      actor: actor(id),
      cache: new Map<string, boolean>(),
    })
    expect(await gate(ctx('alice'), frame)).toBe(true)
    expect(await gate(ctx('bob'), frame)).toBe(true)
    expect(await gate(ctx('carol'), frame)).toBe(false)

    const carol = ctx('carol')
    expect(await gate(carol, frame)).toBe(false)
    await db.insert(resourceGrants).values({
      resourceType: 'workgroup',
      resourceId: workgroupId,
      userId: 'carol',
      addedBy: 'alice',
      addedAt: Date.now(),
    })
    expect(await gate(carol, { type: 'workgroup.acl.updated', workgroupId })).toBe(true)
    expect(await gate(carol, frame)).toBe(true)
  })

  test('cold private delete uses captured audience and unknown variants fail closed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workgroupId = ulid()
    await db.insert(workgroups).values({
      id: workgroupId,
      name: 'deleted-team',
      ownerUserId: 'alice',
      visibility: 'private',
      version: 1,
    })
    await db.delete(workgroups).where(eq(workgroups.id, workgroupId))
    const context: WorkgroupDeletedAudienceContext = {
      kind: 'workgroup.deleted-audience',
      workgroupId,
      visibility: 'private',
      ownerUserId: 'alice',
      grantedUserIds: new Set(['bob']),
    }
    const frame: WorkgroupsWsMessage = {
      type: 'workgroup.deleted',
      workgroupId,
      clientMutationId: ulid(),
      deletedVersion: 1,
    }
    const gate = WS_CHANNELS.workgroups.frameGate!
    const ctx = (id: string) => ({
      db,
      actor: actor(id),
      cache: new Map<string, boolean>(),
    })
    expect(await gate(ctx('alice'), frame, context)).toBe(true)
    expect(await gate(ctx('bob'), frame, context)).toBe(true)
    expect(await gate(ctx('carol'), frame, context)).toBe(false)
    expect(
      await gate(ctx('alice'), {
        type: 'workgroup.future',
        workgroupId,
      } as unknown as WorkgroupsWsMessage),
    ).toBe(false)
  })
})
