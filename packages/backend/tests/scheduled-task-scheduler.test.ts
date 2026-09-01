// RFC-159 T3 (PR-3c) — background scheduler loop.
//
// Drives runDueSchedulesOnce (poll+claim+fire, awaiting fires) with an injected
// fake launch, so we lock the loop semantics without spawning opencode:
//   - poll selects only due+enabled rows; CAS-advances next_run_at BEFORE firing
//   - success records launched + last_task_id + cf=0; owner-actor + scheduledTaskId
//   - each failure path (owner inactive / workflow gone) records failed + cf++
//   - consecutive failures cross the threshold → auto-disable EXACTLY once
//   - corrupt spec disables instead of hot-looping
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { StartTask } from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks, users, workflows } from '../src/db/schema'
import type { BuildScheduleLaunch } from '../src/services/scheduledTasks'
import { runDueSchedulesOnce } from './helpers/scheduledTaskScheduler'
import { createUser } from '../src/services/users'
import { createWorkflow } from '../src/services/workflow'
import { createIdentityAccessRuntime } from '../src/modules/identity-access/composition'
import { withIntegrationTriggerResources } from './helpers/integrationTriggerResourceBinding'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAILY = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const
const BODY = {
  workflowId: '',
  name: 'nightly',
  repoUrl: 'https://git.invalid/r.git',
  ref: 'main',
  inputs: {},
}

interface LaunchCall {
  ownerUserId: string
  scheduledTaskId: string
  body: StartTask
}

/** Records every launch; optionally throws to simulate a launch-time failure. */
function fakeLaunch(
  calls: LaunchCall[],
  opts: { throwFor?: Set<string> } = {},
): BuildScheduleLaunch {
  // RFC-165 §9b: the closure now receives (kind, payload, actor); these
  // scheduler tests only exercise workflow rows.
  return (ownerUserId, scheduledTaskId) => async (_kind, payload) => {
    calls.push({ ownerUserId, scheduledTaskId, body: payload as unknown as StartTask })
    if (opts.throwFor?.has(scheduledTaskId)) throw new Error('boom')
    return { id: `task-${calls.length}` }
  }
}

describe('RFC-159 scheduled-task scheduler', () => {
  let db: DbClient
  let wfId = ''
  let ownerId = ''
  let identityAccess: ReturnType<typeof withIntegrationTriggerResources>

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    identityAccess = withIntegrationTriggerResources(db, createIdentityAccessRuntime({ db }))
    const owner = await createUser(db, {
      username: 'owner',
      displayName: 'O',
      role: 'user',
      password: 'longEnoughPassword',
    })
    ownerId = owner.id
    const wf = await createWorkflow(
      db,
      {
        name: 'wf',
        description: '',
        definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] },
      },
      {
        ownerUserId: owner.id,
        actor: buildActor({ user: owner, source: 'session' }),
      },
    )
    wfId = wf.id
  })

  async function seed(
    id: string,
    over: Partial<typeof scheduledTasks.$inferInsert> = {},
  ): Promise<void> {
    const now = Date.now()
    await db.insert(scheduledTasks).values({
      id,
      name: id,
      ownerUserId: ownerId,
      launchPayload: JSON.stringify({ ...BODY, workflowId: wfId }),
      scheduleSpec: JSON.stringify(DAILY),
      enabled: true,
      nextRunAt: now - 1000, // due
      consecutiveFailures: 0,
      createdAt: now,
      updatedAt: now,
      ...over,
    })
  }

  const rowOf = async (id: string) =>
    (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1))[0]!

  test('fires a due schedule: success recorded, owner+scheduledTaskId+decorated name passed, next_run_at advanced', async () => {
    await seed('s1')
    const calls: LaunchCall[] = []
    const now = Date.now()
    const claimed = await runDueSchedulesOnce(db, {
      buildLaunch: fakeLaunch(calls),
      identityAccess,
      now,
    })

    expect(claimed.map((r) => r.id)).toEqual(['s1'])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ownerUserId).toBe(ownerId)
    expect(calls[0]!.scheduledTaskId).toBe('s1')
    expect(calls[0]!.body.name).toMatch(/nightly · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/) // decorated

    const row = await rowOf('s1')
    expect(row.lastStatus).toBe('launched')
    expect(row.lastTaskId).toBe('task-1')
    expect(row.consecutiveFailures).toBe(0)
    expect(row.nextRunAt).toBeGreaterThan(now) // CAS-advanced to a future slot
  })

  test('ignores disabled + not-yet-due schedules', async () => {
    await seed('due')
    await seed('disabled', { enabled: false })
    await seed('future', { nextRunAt: Date.now() + 60 * 60 * 1000 })
    const calls: LaunchCall[] = []
    const claimed = await runDueSchedulesOnce(db, {
      buildLaunch: fakeLaunch(calls),
      identityAccess,
    })
    expect(claimed.map((r) => r.id)).toEqual(['due'])
    expect(calls.map((c) => c.scheduledTaskId)).toEqual(['due'])
  })

  test('CAS-advances next_run_at even when the launch FAILS (advance precedes fire)', async () => {
    await seed('s1')
    const before = await rowOf('s1')
    const calls: LaunchCall[] = []
    await runDueSchedulesOnce(db, {
      buildLaunch: fakeLaunch(calls, { throwFor: new Set(['s1']) }),
      identityAccess,
      now: Date.now(),
    })
    const after = await rowOf('s1')
    expect(after.nextRunAt).not.toBe(before.nextRunAt) // claimed regardless of fire outcome
    expect(after.lastStatus).toBe('failed')
    expect(after.consecutiveFailures).toBe(1)
  })

  test('owner inactive → failure, no launch', async () => {
    await seed('s1')
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, ownerId))
    const calls: LaunchCall[] = []
    await runDueSchedulesOnce(db, { buildLaunch: fakeLaunch(calls), identityAccess })
    expect(calls).toHaveLength(0)
    const row = await rowOf('s1')
    expect(row.lastStatus).toBe('failed')
    expect(row.lastError).toContain('active')
    expect(row.consecutiveFailures).toBe(1)
  })

  test('workflow deleted → failure recorded', async () => {
    await seed('s1')
    await db.delete(workflows).where(eq(workflows.id, wfId))
    const calls: LaunchCall[] = []
    await runDueSchedulesOnce(db, { buildLaunch: fakeLaunch(calls), identityAccess })
    expect(calls).toHaveLength(0)
    expect((await rowOf('s1')).lastStatus).toBe('failed')
  })

  test('crosses maxFailures → auto-disable EXACTLY once (WHERE enabled=1 RETURNING)', async () => {
    await seed('s1', { consecutiveFailures: 2 })
    const disabled: string[] = []
    const calls: LaunchCall[] = []
    // maxFailures=3: this failing fire takes cf 2→3 ⇒ auto-disable, event once.
    await runDueSchedulesOnce(db, {
      buildLaunch: fakeLaunch(calls, { throwFor: new Set(['s1']) }),
      identityAccess,
      maxFailures: 3,
      onAutoDisable: (id) => disabled.push(id),
    })
    const row = await rowOf('s1')
    expect(row.consecutiveFailures).toBe(3)
    expect(row.enabled).toBe(false)
    expect(disabled).toEqual(['s1']) // exactly once
    expect(row.nextRunAt).not.toBeNull() // still advanced; just no longer polled (enabled=0)
  })

  test('corrupt schedule_spec → disabled, not hot-looped', async () => {
    await seed('s1', { scheduleSpec: '{bad json' })
    const calls: LaunchCall[] = []
    const claimed = await runDueSchedulesOnce(db, {
      buildLaunch: fakeLaunch(calls),
      identityAccess,
    })
    expect(claimed).toHaveLength(0)
    expect(calls).toHaveLength(0)
    const row = await rowOf('s1')
    expect(row.enabled).toBe(false)
    expect(row.lastError).toContain('schedule-spec-invalid')
  })

  test('source lock: claim CAS-advances next_run_at but never writes last_run_at (R4-1)', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduledTaskScheduler.ts'),
      'utf-8',
    )
    // The claim UPDATE sets next_run_at + updated_at only — last_run_at is owned by
    // the firedAt-guarded display writes.
    const claimBlock = src.slice(
      src.indexOf('.set({ nextRunAt: next'),
      src.indexOf('.returning({ id'),
    )
    expect(claimBlock).not.toContain('lastRunAt')
  })
})
