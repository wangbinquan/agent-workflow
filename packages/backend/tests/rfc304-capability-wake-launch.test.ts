// RFC-304 §3.1 — a delivery becoming code-round tasks, against a real database
// and the real launch path.
//
// This is the last link of the chain, and the one whose absence was invisible:
// every stage was built and tested, the matrix was built and tested, and
// nothing joined them — `wantsCapability` existed and no caller ever asked it.
// A missing join produces no failing test anywhere, because each half is
// individually correct.
//
// What is locked here:
//   - a ready cell turns a delivery into a real task, carrying the frozen
//     trigger context the round reads its target from;
//   - a not-ready cell does not, so a half-configured repository stays silent
//     rather than posting a round that fails on the MR;
//   - one task PER capability, because `mr-review` and `mr-monitor` are separate
//     work items and sharing a task would let one settle the other's round;
//   - one cell failing to launch does not swallow the others.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { tasks } from '../src/db/schema'
import { wakeCapabilitiesForDelivery } from '../src/services/codeCapabilityWake'
import { upsertCapabilityCell } from '../src/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { capabilityBindings, capabilityFrameworks } from '../src/db/schema'
import type { TriggerContext } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const REPO = 'repo-1'

const readyFacts = {
  hasBinding: true,
  frameworkExists: true,
  hasTrigger: true,
  codeHostConfigured: true,
  invisibleAgentSlots: [] as string[],
  requiresWakeSource: false,
  hasWakeSource: false,
}

const triggerContext: TriggerContext = {
  trigger: {
    webhook: {
      event_type: 'mr_opened',
      provider: 'gitlab',
      project_id: '41823',
      mr_iid: '412',
      commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      repo_path: 'group/project',
    },
  },
}

describe('RFC-304 — a delivery wakes the capabilities a repo switched on', () => {
  let db: DbClient
  let appHome: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc304-wake-'))
  })
  afterEach(() => {
    db.$client.close()
    rmSync(appHome, { recursive: true, force: true })
  })

  const enable = (capability: string, over: Record<string, unknown> = {}) =>
    upsertCapabilityCell(db, {
      repoId: REPO,
      capability,
      bindingId: 'binding-1',
      enabled: true,
      facts: readyFacts,
      dependencyRevision: 1,
      now: NOW,
      ...over,
    })

  /** A real framework + binding, so script resolution has something to read. */
  const seedTemplate = async (scriptsJson: string): Promise<void> => {
    await db
      .insert(capabilityFrameworks)
      .values({
        id: 'framework-1',
        name: 'framework-1',
        capability: 'mr-monitor',
        scriptsJson,
        createdAt: NOW,
        updatedAt: NOW,
      })
      .onConflictDoNothing()
    await db
      .insert(capabilityBindings)
      .values({
        id: 'binding-1',
        name: 'binding-1',
        frameworkId: 'framework-1',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .onConflictDoNothing()
  }

  const deliver = (over: Record<string, unknown> = {}) =>
    wakeCapabilitiesForDelivery({
      db,
      repoId: REPO,
      eventType: 'mr_opened',
      mrIid: '412',
      triggerContext,
      webhookTriggerId: 'trigger-1',
      webhookFireId: 'fire-1',
      launchDeps: { db, appHome } as never,
      ...over,
    })

  test('a ready cell turns the delivery into a real code-round task', async () => {
    await enable('mr-review')
    const result = await deliver()

    expect(result.failed).toEqual([])
    expect(result.started).toHaveLength(1)
    expect(result.started[0]?.capability).toBe('mr-review')

    const [row] = await db.select().from(tasks).where(eq(tasks.id, result.started[0]!.taskId))
    expect(row?.codeRoundId).toBe(result.started[0]!.roundId)
  })

  test('the task carries the frozen trigger context the round reads its target from', async () => {
    // Without it `resolve-target` has nothing to read and the round refuses —
    // so the launch has to thread it, not just record that a webhook happened.
    await enable('mr-review')
    const result = await deliver()
    const [row] = await db.select().from(tasks).where(eq(tasks.id, result.started[0]!.taskId))
    expect(String(row?.triggerContextJson ?? '')).toContain('41823')
    expect(String(row?.triggerContextJson ?? '')).toContain('412')
  })

  test('a repository with nothing switched on stays silent', async () => {
    // The default. A platform that commented on repos nobody configured would
    // be worse than one that never commented.
    expect((await deliver()).started).toEqual([])
  })

  test('a MISCONFIGURED cell does not start a round', async () => {
    // It would run several stages and fail on the MR, in front of the author,
    // when the honest answer was available before anything started.
    await enable('mr-review', { facts: { ...readyFacts, codeHostConfigured: false } })
    expect((await deliver()).started).toEqual([])
  })

  test('an unsubscribed event starts nothing', async () => {
    await enable('mr-review')
    expect((await deliver({ eventType: 'push' })).started).toEqual([])
  })

  test('two capabilities on one MR get two SEPARATE tasks', async () => {
    // They are two work items with separate ledgers; sharing a task would let
    // one capability's failure settle the other's round.
    //
    // Deliberately NOT `mr-monitor` as the second capability, which is what
    // this test used before T36: the monitor is the top-level claimant of an
    // event (T10e) and suppresses the others by design, so pairing it here
    // would test the claim rule rather than the separation it is named for.
    await enable('mr-review')
    await enable('ci-fix')
    const result = await deliver()
    expect(result.started).toHaveLength(2)
    const ids = new Set(result.started.map((s) => s.taskId))
    expect(ids.size).toBe(2)
  })

  test('each round gets its own round id', async () => {
    await enable('mr-review')
    await enable('ci-fix')
    const result = await deliver()
    expect(new Set(result.started.map((s) => s.roundId)).size).toBe(2)
  })

  test('T10e — a live monitor claims the event instead of the other cells', async () => {
    // The rule from design §11.1: one ingress event, one top-level capability.
    // Without it the same note both triggers a review and wakes the monitor
    // into an independent reaction, and the merge request gets two answers to
    // one comment — the pattern that gets a bot muted, taking the reports that
    // actually matter with it.
    // A framework with hooks but no scripts — a real and easy misconfiguration,
    // and the one that proves the monitor got as far as resolving its own
    // configuration rather than being skipped.
    await seedTemplate('{}')
    await enable('mr-review')
    await enable('mr-monitor')
    const result = await deliver({ codeHostEndpointId: 'ep-1' })

    expect(result.started).toEqual([])
    // The monitor is the one that reacted. It cannot get far here (this cell's
    // framework has no `collect` script), and saying so is the point: the
    // failure is reported against the monitor, not silently turned back into a
    // review.
    expect(result.failed.map((f) => f.capability)).toEqual(['mr-monitor'])
    expect(result.failed[0]?.error).toContain('collect')
  })

  test('the bot’s own event wakes nothing', async () => {
    // The loop guard, at the launch boundary: without it the round's own
    // published comments start the next round, continuously.
    await enable('mr-review', { triggerConfig: { events: ['mr_note'] } })
    const result = await deliver({
      eventType: 'mr_note',
      authorUsername: 'aw-bot',
      botUsername: 'aw-bot',
    })
    expect(result.started).toEqual([])
  })

  test('a launch failure is reported, not swallowed, and does not stop the others', async () => {
    // A delivery that woke two cells and failed on the first must still start
    // the second — and the failure has to surface, because a launch that
    // vanished with no row is exactly what this RFC exists to prevent.
    await enable('mr-review')
    await enable('ci-fix')
    const result = await wakeCapabilitiesForDelivery({
      db,
      repoId: REPO,
      eventType: 'mr_opened',
      mrIid: '412',
      triggerContext,
      // Missing fire id: RFC-301 refuses a webhook launch that cannot point at
      // the delivery it claims to come from.
      webhookTriggerId: 'trigger-1',
      webhookFireId: '',
      launchDeps: { db, appHome } as never,
    })
    expect(result.started).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]?.error.length).toBeGreaterThan(0)
  })

  test('a malformed trigger config falls back to the default events', async () => {
    // A repository must not go silent because one JSON column was hand-edited.
    await enable('mr-review')
    await db.run(
      `UPDATE repo_capability_config SET trigger_config_json = '{not json' WHERE repo_id = '${REPO}'`,
    )
    expect((await deliver()).started).toHaveLength(1)
  })
})
