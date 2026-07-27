// RFC-159 T2 — assertWorkflowLaunchable parity lock.
//
// This shared gate replaces the byte-identical inline gates the JSON
// (routes/tasks.ts POST /api/tasks) and multipart launch paths used, and is
// reused by the scheduled-task scheduler. Locks the three outcomes so any future
// drift in one of the three call sites is caught: missing/invisible → 404
// workflow-not-found; built-in → 403; visible non-builtin → returns the row.
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import type { CreateWorkflow } from '@agent-workflow/shared'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { assertWorkflowLaunchable } from '../src/services/taskLaunchGate'
import { createWorkflow } from '../src/services/workflow'
import { ForbiddenError, NotFoundError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
// Annotated (not a bare const) so `$schema_version`/`inputs` don't widen to
// number/never[] — matches the contextual typing inline literals get.
const DEF: CreateWorkflow['definition'] = { $schema_version: 1, inputs: [], nodes: [], edges: [] }

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

async function makePrivate(db: DbClient, id: string) {
  await db.update(workflows).set({ visibility: 'private' }).where(eq(workflows.id, id))
}

describe('assertWorkflowLaunchable — shared launch gate (RFC-159 T2 parity)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('missing workflow → NotFoundError workflow-not-found', async () => {
    let err: unknown
    try {
      await assertWorkflowLaunchable(db, actor('alice'), 'nope')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NotFoundError)
    expect((err as NotFoundError).code).toBe('workflow-not-found')
  })

  test('private workflow owned by another → 404 (invisible == missing)', async () => {
    const wf = await createWorkflow(
      db,
      { name: 'p', description: '', definition: DEF },
      { ownerUserId: 'bob' },
    )
    await makePrivate(db, wf.id)
    let err: unknown
    try {
      await assertWorkflowLaunchable(db, actor('alice'), wf.id)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(NotFoundError)
    expect((err as NotFoundError).code).toBe('workflow-not-found')
  })

  test('built-in workflow → ForbiddenError (row IS visible → 403, not 404)', async () => {
    const wf = await createWorkflow(
      db,
      { name: 'aw-x', description: '', definition: DEF },
      { builtin: true },
    )
    let err: unknown
    try {
      await assertWorkflowLaunchable(db, actor('alice'), wf.id)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ForbiddenError)
  })

  test('public non-builtin → returns the workflow (with parsed .definition.inputs)', async () => {
    const wf = await createWorkflow(db, { name: 'pub', description: '', definition: DEF })
    await db.update(workflows).set({ visibility: 'public' }).where(eq(workflows.id, wf.id))
    const got = await assertWorkflowLaunchable(db, actor('alice'), wf.id)
    expect(got.id).toBe(wf.id)
    expect(got.definition.inputs).toEqual([]) // multipart path reads .definition.inputs
  })

  test('owner can launch own private workflow', async () => {
    const wf = await createWorkflow(
      db,
      { name: 'mine', description: '', definition: DEF },
      { ownerUserId: 'alice' },
    )
    await makePrivate(db, wf.id)
    const got = await assertWorkflowLaunchable(db, actor('alice'), wf.id)
    expect(got.id).toBe(wf.id)
  })

  test('admin bypasses visibility', async () => {
    const wf = await createWorkflow(
      db,
      { name: 'p2', description: '', definition: DEF },
      { ownerUserId: 'bob' },
    )
    await makePrivate(db, wf.id)
    const got = await assertWorkflowLaunchable(db, actor('admin', 'admin'), wf.id)
    expect(got.id).toBe(wf.id)
  })
})
