// RFC-045 — patchMemory unit tests.
//
// Scope:
//   * candidate / approved / archived rows are editable
//   * superseded / rejected → 409 memory-terminal-status
//   * unknown id → 404 memory-not-found
//   * synth-then-MemorySchema rejects "change scopeType to global without
//     clearing scopeId"
//   * version bumps only when ≥1 field actually changes (idempotent re-save)
//   * WS publish carries changedFields + version
//   * source_* / approved_* / supersedes_* columns frozen
//   * tag order changes alone are NOT a "change" (tags are a set)

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { memories } from '../src/db/schema'
import {
  createManualCandidate,
  patchMemory,
  promoteCandidate,
  archiveMemory,
} from '../src/services/memory'
import { MEMORY_CHANNEL, memoryBroadcaster, resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { MemoryWsMessage } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function captureBroadcasts(): { msgs: MemoryWsMessage[]; stop: () => void } {
  const msgs: MemoryWsMessage[] = []
  const stop = memoryBroadcaster.subscribe(MEMORY_CHANNEL, (m) => {
    msgs.push(m)
  })
  return { msgs, stop }
}

async function seedCandidate(
  db: DbClient,
  overrides: Partial<{
    scopeType: 'agent' | 'workflow' | 'repo' | 'global'
    scopeId: string | null
    title: string
    bodyMd: string
    tags: string[]
  }> = {},
) {
  return createManualCandidate(db, {
    scopeType: overrides.scopeType ?? 'agent',
    scopeId: overrides.scopeId !== undefined ? overrides.scopeId : 'agent-a',
    title: overrides.title ?? 'initial title',
    bodyMd: overrides.bodyMd ?? 'initial body',
    tags: overrides.tags,
  })
}

describe('patchMemory — RFC-045', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('candidate row: title-only patch → version 1→2 + WS', async () => {
    const seed = await seedCandidate(db)
    const cap = captureBroadcasts()
    const result = await patchMemory(db, seed.id, { title: 'renamed' }, 'admin-u1')
    cap.stop()
    expect(result.memory.title).toBe('renamed')
    expect(result.memory.version).toBe(2)
    expect(result.changedFields).toEqual(['title'])
    const editedWs = cap.msgs.find((m) => m.type === 'memory.updated')
    expect(editedWs).toBeDefined()
    if (editedWs && editedWs.type === 'memory.updated') {
      expect(editedWs.memoryId).toBe(seed.id)
      expect(editedWs.changedFields).toEqual(['title'])
      expect(editedWs.version).toBe(2)
    }
  })

  test('approved row: bodyMd patch bumps version + approved_* frozen', async () => {
    const seed = await seedCandidate(db, { bodyMd: 'v1 body' })
    const approved = await promoteCandidate(db, seed.id, { action: 'approve' }, 'admin-u1')
    expect(approved.status).toBe('approved')
    const approvedAtBefore = approved.approvedAt
    const approverBefore = approved.approvedByUserId
    expect(approvedAtBefore).not.toBeNull()
    const result = await patchMemory(db, seed.id, { bodyMd: 'v2 body' }, 'admin-other')
    expect(result.memory.bodyMd).toBe('v2 body')
    expect(result.memory.status).toBe('approved')
    expect(result.memory.version).toBeGreaterThanOrEqual(2)
    expect(result.memory.approvedAt).toBe(approvedAtBefore)
    expect(result.memory.approvedByUserId).toBe(approverBefore)
  })

  test('archived row is editable; status preserved', async () => {
    const seed = await seedCandidate(db)
    await promoteCandidate(db, seed.id, { action: 'approve' }, 'admin')
    await archiveMemory(db, seed.id)
    const result = await patchMemory(db, seed.id, { title: 'edited while archived' })
    expect(result.memory.status).toBe('archived')
    expect(result.memory.title).toBe('edited while archived')
  })

  test('idempotent: re-save unchanged fields → version unchanged + no WS event', async () => {
    const seed = await seedCandidate(db, { title: 'same', bodyMd: 'same body' })
    const cap = captureBroadcasts()
    const result = await patchMemory(db, seed.id, { title: 'same', bodyMd: 'same body' })
    cap.stop()
    expect(result.memory.version).toBe(seed.version)
    expect(result.changedFields).toEqual([])
    expect(cap.msgs.some((m) => m.type === 'memory.updated')).toBe(false)
  })

  test('tag reorder alone is NOT a change (tags are a set)', async () => {
    const seed = await seedCandidate(db, { tags: ['a', 'b', 'c'] })
    const result = await patchMemory(db, seed.id, { tags: ['c', 'b', 'a'] })
    expect(result.changedFields).toEqual([])
    expect(result.memory.version).toBe(seed.version)
  })

  test('superseded row → 409 memory-terminal-status', async () => {
    // Build a supersede chain: approve A, promote B with action=supersede A.
    const a = await seedCandidate(db, { title: 'A' })
    await promoteCandidate(db, a.id, { action: 'approve' }, 'admin')
    const b = await seedCandidate(db, { title: 'B' })
    await promoteCandidate(
      db,
      b.id,
      { action: 'approve_and_supersede', supersedeIds: [a.id] },
      'admin',
    )
    // A is now superseded.
    await expect(patchMemory(db, a.id, { title: 'cannot' })).rejects.toMatchObject({
      code: 'memory-terminal-status',
    })
  })

  test('rejected row → 409 memory-terminal-status', async () => {
    const seed = await seedCandidate(db, { title: 'doomed' })
    await promoteCandidate(db, seed.id, { action: 'reject' }, 'admin')
    await expect(patchMemory(db, seed.id, { title: 'cannot' })).rejects.toMatchObject({
      code: 'memory-terminal-status',
    })
  })

  test('unknown id → 404 memory-not-found', async () => {
    await expect(patchMemory(db, '01HXX-nonexistent', { title: 'x' })).rejects.toMatchObject({
      code: 'memory-not-found',
    })
  })

  test('scopeType→global without clearing scopeId → 422 invalid-body', async () => {
    const seed = await seedCandidate(db, { scopeType: 'agent', scopeId: 'agent-a' })
    await expect(patchMemory(db, seed.id, { scopeType: 'global' })).rejects.toMatchObject({
      code: 'invalid-body',
    })
  })

  test('scopeType→global with explicit scopeId=null succeeds', async () => {
    const seed = await seedCandidate(db, { scopeType: 'agent', scopeId: 'agent-a' })
    const result = await patchMemory(db, seed.id, { scopeType: 'global', scopeId: null })
    expect(result.memory.scopeType).toBe('global')
    expect(result.memory.scopeId).toBeNull()
    expect(new Set(result.changedFields)).toEqual(new Set(['scopeType', 'scopeId']))
  })

  test('source_* + distill_* + supersedes_id columns are frozen across PATCH', async () => {
    const seed = await seedCandidate(db, { title: 'orig' })
    const beforeRows = (await db.select().from(memories).where(eq(memories.id, seed.id))) as Array<{
      sourceKind: string
      sourceEventId: string | null
      sourceTaskId: string | null
      distillJobId: string | null
      distillAction: string | null
      supersedesId: string | null
      supersededById: string | null
    }>
    expect(beforeRows.length).toBe(1)
    const before = beforeRows[0]!
    await patchMemory(db, seed.id, { title: 'new', bodyMd: 'new body' })
    const afterRows = (await db.select().from(memories).where(eq(memories.id, seed.id))) as Array<{
      sourceKind: string
      sourceEventId: string | null
      sourceTaskId: string | null
      distillJobId: string | null
      distillAction: string | null
      supersedesId: string | null
      supersededById: string | null
    }>
    const after = afterRows[0]!
    expect(after.sourceKind).toBe(before.sourceKind)
    expect(after.sourceEventId).toBe(before.sourceEventId)
    expect(after.sourceTaskId).toBe(before.sourceTaskId)
    expect(after.distillJobId).toBe(before.distillJobId)
    expect(after.distillAction).toBe(before.distillAction)
    expect(after.supersedesId).toBe(before.supersedesId)
    expect(after.supersededById).toBe(before.supersededById)
  })

  test('multi-field patch reports the full changedFields set', async () => {
    const seed = await seedCandidate(db, {
      scopeType: 'agent',
      scopeId: 'agent-a',
      title: 't1',
      bodyMd: 'b1',
      tags: ['x'],
    })
    const result = await patchMemory(db, seed.id, {
      scopeType: 'workflow',
      scopeId: 'wf-1',
      title: 't2',
      bodyMd: 'b2',
      tags: ['y'],
    })
    expect(new Set(result.changedFields)).toEqual(
      new Set(['scopeType', 'scopeId', 'title', 'bodyMd', 'tags']),
    )
    expect(result.memory.version).toBe(2)
  })
})
