// RFC-159 T3 (PR-3b) — scheduled-task CRUD service.
//
// Locks: create validates the launch body + gates the workflow at CREATE time
// (invisible/builtin → error) + rejects required-upload workflows + computes the
// initial next_run_at; update re-gates when the result is enabled + recomputes
// next_run_at + resets consecutive_failures; row corruption is caught.
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks, workflows } from '../src/db/schema'
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from '../src/services/scheduledTasks'
import { createWorkflow } from '../src/services/workflow'
import { NotFoundError, ValidationError } from '../src/util/errors'
import type { CreateWorkflow } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DEF: CreateWorkflow['definition'] = { $schema_version: 1, inputs: [], nodes: [], edges: [] }
const UPLOAD_DEF: CreateWorkflow['definition'] = {
  $schema_version: 1,
  inputs: [{ key: 'file', label: 'File', kind: 'upload', required: true }],
  nodes: [],
  edges: [],
}

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: `u-${id}`, displayName: 'U', role, status: 'active' },
    source: 'session',
  })
}

const SPEC = { kind: 'daily', at: '09:00', timezone: 'America/New_York' } as const

describe('RFC-159 scheduled-task CRUD', () => {
  let db: DbClient
  let wfId = ''
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const wf = await createWorkflow(db, { name: 'wf', description: '', definition: DEF })
    wfId = wf.id
  })

  function launchBody(id = wfId) {
    return { workflowId: id, name: 'nightly', repoUrl: 'file:///repo', ref: 'main', inputs: {} }
  }

  test('create: validates body, gates workflow, computes next_run_at, owner=actor', async () => {
    const created = await createScheduledTask(
      db,
      { name: 'daily audit', launchPayload: launchBody(), scheduleSpec: SPEC, enabled: true },
      { actor: actor('alice') },
    )
    expect(created.ownerUserId).toBe('alice')
    expect(created.enabled).toBe(true)
    expect(created.nextRunAt).toBeGreaterThan(Date.now())
    expect(created.consecutiveFailures).toBe(0)
    expect(created.launchPayload).not.toBe(null)
    expect(created.launchPayload!.workflowId).toBe(wfId)
  })

  test('create: disabled schedule has null next_run_at', async () => {
    const created = await createScheduledTask(
      db,
      { name: 'x', launchPayload: launchBody(), scheduleSpec: SPEC, enabled: false },
      { actor: actor('alice') },
    )
    expect(created.enabled).toBe(false)
    expect(created.nextRunAt).toBeNull()
  })

  test('create: invalid launch body → ValidationError (StartTaskSchema enforced)', async () => {
    await expect(
      createScheduledTask(
        db,
        // no repo source → StartTaskSchema superRefine fails (still invalid despite inputs)
        {
          name: 'x',
          launchPayload: { workflowId: wfId, name: 'x', inputs: {} },
          scheduleSpec: SPEC,
          enabled: true,
        },
        { actor: actor('alice') },
      ),
    ).rejects.toThrow()
  })

  test('create: create-time launch gate — invisible workflow → 404 (R2-b)', async () => {
    const priv = await createWorkflow(
      db,
      { name: 'p', description: '', definition: DEF },
      { ownerUserId: 'bob' },
    )
    await db.update(workflows).set({ visibility: 'private' }).where(eq(workflows.id, priv.id))
    await expect(
      createScheduledTask(
        db,
        { name: 'x', launchPayload: launchBody(priv.id), scheduleSpec: SPEC, enabled: true },
        { actor: actor('alice') },
      ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('create: workflow with a REQUIRED upload input → scheduled-task-upload-required', async () => {
    const up = await createWorkflow(db, { name: 'up', description: '', definition: UPLOAD_DEF })
    let err: unknown
    try {
      await createScheduledTask(
        db,
        { name: 'x', launchPayload: launchBody(up.id), scheduleSpec: SPEC, enabled: true },
        { actor: actor('alice') },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ValidationError)
    expect((err as ValidationError).code).toBe('scheduled-task-upload-required')
  })

  test('update: re-enabling recomputes next_run_at and resets consecutive_failures', async () => {
    const created = await createScheduledTask(
      db,
      { name: 'x', launchPayload: launchBody(), scheduleSpec: SPEC, enabled: false },
      { actor: actor('alice') },
    )
    // simulate a prior failure streak on the disabled row
    await db
      .update(scheduledTasks)
      .set({ consecutiveFailures: 5 })
      .where(eq(scheduledTasks.id, created.id))
    const updated = await updateScheduledTask(
      db,
      created.id,
      { enabled: true },
      { actor: actor('alice') },
    )
    expect(updated.enabled).toBe(true)
    expect(updated.nextRunAt).toBeGreaterThan(Date.now())
    expect(updated.consecutiveFailures).toBe(0)
  })

  test('update: disabling clears next_run_at', async () => {
    const created = await createScheduledTask(
      db,
      { name: 'x', launchPayload: launchBody(), scheduleSpec: SPEC, enabled: true },
      { actor: actor('alice') },
    )
    const updated = await updateScheduledTask(
      db,
      created.id,
      { enabled: false },
      { actor: actor('alice') },
    )
    expect(updated.nextRunAt).toBeNull()
  })

  test('update: unknown id → NotFoundError', async () => {
    await expect(
      updateScheduledTask(db, 'nope', { name: 'y' }, { actor: actor('alice') }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete removes the row; list reflects it', async () => {
    const created = await createScheduledTask(
      db,
      { name: 'x', launchPayload: launchBody(), scheduleSpec: SPEC, enabled: true },
      { actor: actor('alice') },
    )
    expect((await listScheduledTasks(db)).length).toBe(1)
    await deleteScheduledTask(db, created.id)
    expect(await getScheduledTask(db, created.id)).toBeNull()
    expect((await listScheduledTasks(db)).length).toBe(0)
  })

  test('corrupt JSON degrades the field instead of throwing (RFC-165 F18/N3)', async () => {
    // Pre-RFC-165 this threw `scheduled-task-row-corrupt` and ONE bad row took
    // down the whole list. Now the bad column degrades to null + a per-field
    // migrationError while the row stays readable / repairable / deletable.
    const created = await createScheduledTask(
      db,
      { name: 'x', launchPayload: launchBody(), scheduleSpec: SPEC, enabled: true },
      { actor: actor('alice') },
    )
    await db
      .update(scheduledTasks)
      .set({ scheduleSpec: '{bad json' })
      .where(eq(scheduledTasks.id, created.id))
    const got = await getScheduledTask(db, created.id)
    expect(got).not.toBe(null)
    expect(got!.scheduleSpec).toBe(null)
    expect(got!.launchPayload).not.toBe(null) // healthy column untouched
    expect(got!.migrationError?.scheduleSpec ?? '').toContain('invalid-json')
    // …and it does not take down the LIST either.
    const all = await listScheduledTasks(db)
    expect(all.some((s) => s.id === created.id)).toBe(true)
  })
})
