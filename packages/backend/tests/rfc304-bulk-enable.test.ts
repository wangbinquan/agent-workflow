// RFC-304 §11.6 T63 — enabling a capability across many repositories.
//
// `domain/configScale.ts` settled the shape and rejected the obvious one: a bulk
// change is an EXPLICIT WRITE TO EACH CELL rather than an inherited value,
// because with inheritance "why is this repository doing that?" has no local
// answer — the cell shows nothing and the value lives somewhere the reader has
// to go find. The matrix stays the single source of truth and "bulk" is a
// property of the editing tool.
//
// The price of that decision is that a bulk edit is a REAL edit, several hundred
// of them at once, and these cases pin the three things that makes necessary:
//
//   · a preview that distinguishes "will change 12" from "matched 200, 188
//     already set" — the second is what tells the author their selector is
//     wider than they meant;
//   · a revert built from what ACTUALLY landed;
//   · failures collected and named, never a half-applied batch that reports
//     success.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  capabilityBindings,
  capabilityFrameworks,
  webhookEndpoints,
} from '../src/db/schema'
import {
  BULK_REPO_LIMIT,
  createBulkEnableCommand,
} from '../src/modules/code-capability/application/bulkEnableCommand'
import { createCodeMatrixQuery } from '../src/modules/code-capability/application/codeMatrixQuery'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

describe('RFC-304 T63 — bulk enable', () => {
  let db: DbClient

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(webhookEndpoints).values({
      id: 'ep-1',
      name: 'gl',
      provider: 'gitlab',
      urlToken: 'aw_whk_bulk',
      secretEnc: 'sealed',
      enabled: true,
    })
    await db.insert(agents).values({
      id: 'agent-1',
      name: 'reviewer',
      bodyMd: 'x',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityFrameworks).values({
      id: 'fw-1',
      name: 'f',
      capability: 'mr-review',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(capabilityBindings).values({
      id: 'binding-1',
      name: 'b',
      frameworkId: 'fw-1',
      agentBySlotJson: JSON.stringify({ reviewer: 'agent-1' }),
      createdAt: NOW,
      updatedAt: NOW,
    })
  })
  afterEach(() => db.$client.close())

  const command = () => createBulkEnableCommand(db, () => NOW)

  const run = async (over: Partial<Parameters<ReturnType<typeof command>['run']>[0]> = {}) =>
    await command().run({
      repoIds: ['repo-a', 'repo-b', 'repo-c'],
      capability: 'mr-review',
      enabled: true,
      bindingId: 'binding-1',
      actorUserId: 'user-1',
      preview: false,
      ...over,
    })

  test('a preview writes NOTHING — that is the whole point of previewing', async () => {
    const result = await run({ preview: true })
    expect(result.ok).toBe(true)

    // Not one cell created. A "preview" that writes is a bulk edit with extra
    // steps, and the author's chance to notice a too-wide selector is gone.
    expect(await createCodeMatrixQuery(db).forRepo('repo-a')).toEqual([])
  })

  test('the preview counts creates, updates and no-ops SEPARATELY', async () => {
    // "This will change 12 repositories" vs "this matched 200, 188 already set".
    // Folding them into one number hides the case the author most needs to see.
    await run() // three creates

    const second = await command().run({
      repoIds: ['repo-a', 'repo-b', 'repo-new'],
      capability: 'mr-review',
      enabled: true,
      bindingId: 'binding-1',
      actorUserId: 'user-1',
      preview: true,
    })

    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.preview.creates.map((c) => c.repoId)).toEqual(['repo-new'])
    expect(second.preview.noOps.map((c) => c.repoId).sort()).toEqual(['repo-a', 'repo-b'])
    expect(second.preview.message).toContain('already set')
  })

  test('applying writes each cell explicitly — the matrix still answers locally', async () => {
    // The design's reason for rejecting inheritance: every cell keeps saying
    // what it does, so a person looking at one repository gets an answer without
    // going to find a level they cannot see.
    const result = await run()
    expect(result.ok).toBe(true)

    for (const repoId of ['repo-a', 'repo-b', 'repo-c']) {
      const [row] = await createCodeMatrixQuery(db).forRepo(repoId)
      expect(row?.capability).toBe('mr-review')
      expect(row?.enabled).toBe(true)
      expect(row?.bindingId).toBe('binding-1')
    }
  })

  test('a second identical apply changes nothing, and says so', async () => {
    await run()
    const again = await run()
    expect(again.ok).toBe(true)
    if (!again.ok) return
    // All three are no-ops, so nothing is re-written — an "edit" that stamps
    // every unchanged row makes the audit trail useless for finding what moved.
    expect(again.preview.noOps).toHaveLength(3)
    expect(again.undo).toEqual([])
  })

  test('the undo restores what the batch changed, and nothing else', async () => {
    const applied = await run()
    expect(applied.ok).toBe(true)
    if (!applied.ok || applied.undo === undefined) return

    // Someone edits one of them by hand afterwards, to a DIFFERENT binding.
    await command().run({
      repoIds: ['repo-c'],
      capability: 'mr-review',
      enabled: false,
      bindingId: null,
      actorUserId: 'user-2',
      preview: false,
    })

    // The undo is built from each cell's recorded `before`, so it restores the
    // pre-batch state rather than re-deriving from whatever is there now.
    expect(applied.undo.map((c) => c.repoId).sort()).toEqual(['repo-a', 'repo-b', 'repo-c'])
    for (const change of applied.undo) {
      // A cell that did not exist before is reverted by DISABLING it, not by
      // deleting it — deletion would also discard the trigger configuration the
      // create brought along, and a revert that destroys more than it reverses
      // is not one.
      expect(change.after).toEqual({ enabled: false, bindingId: null })
    }
  })

  test('a repository whose endpoint cannot be resolved is NAMED, not silently skipped', async () => {
    // A bulk tool that reports success over a partial write is how 200
    // repositories end up in a state nobody can describe. Every repository that
    // did not get written comes back with its reason.
    //
    // Induced by removing the only code-host endpoint, because endpoint
    // resolution is per-deployment rather than per-repository — with no
    // endpoint, no repository resolves.
    await db.delete(webhookEndpoints)

    const result = await run()
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.failures.map((f) => f.repoId).sort()).toEqual(['repo-a', 'repo-b', 'repo-c'])
    // With a reason each — "failed" alone moves the question rather than
    // answering it.
    expect(result.failures[0]?.message.length).toBeGreaterThan(0)
    // And nothing was half-written.
    expect(await createCodeMatrixQuery(db).forRepo('repo-a')).toEqual([])
    // The undo covers only what landed, which here is nothing — offering to
    // revert an empty batch would suggest something happened.
    expect(result.undo).toEqual([])
  })

  test('a capability the platform does not ship is refused before anything is written', async () => {
    const result = await command().run({
      repoIds: ['repo-a'],
      capability: 'mr-invented',
      enabled: true,
      actorUserId: 'user-1',
      preview: false,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('unknown-capability')
    expect(await createCodeMatrixQuery(db).forRepo('repo-a')).toEqual([])
  })

  test('a request naming more repositories than the limit is refused, not truncated', async () => {
    // Truncation would apply to some and silently drop the rest, which is the
    // worst outcome available: the caller believes all 600 are configured.
    const result = await command().run({
      repoIds: Array.from({ length: BULK_REPO_LIMIT + 1 }, (_, i) => `repo-${String(i)}`),
      capability: 'mr-review',
      enabled: true,
      actorUserId: 'user-1',
      preview: true,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.code).toBe('too-many-repos')
  })

  test('the same repository named twice is one cell, not two writes', async () => {
    const result = await command().run({
      repoIds: ['repo-a', 'repo-a', 'repo-a'],
      capability: 'mr-review',
      enabled: true,
      bindingId: 'binding-1',
      actorUserId: 'user-1',
      preview: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preview.creates).toHaveLength(1)
  })

  test('disabling in bulk is the same path, so it is equally previewable', async () => {
    await run()
    const off = await command().run({
      repoIds: ['repo-a', 'repo-b', 'repo-c'],
      capability: 'mr-review',
      enabled: false,
      bindingId: 'binding-1',
      actorUserId: 'user-1',
      preview: true,
    })
    expect(off.ok).toBe(true)
    if (!off.ok) return
    expect(off.preview.updates).toHaveLength(3)
    expect(off.preview.creates).toEqual([])
  })
})
