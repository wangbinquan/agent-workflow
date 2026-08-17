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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'
import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { cachedRepos, tasks } from '../src/db/schema'
import { wakeCapabilitiesForDelivery } from '../src/services/codeCapabilityWake'
import { upsertCapabilityCell } from '../src/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import { capabilityBindings, capabilityFrameworks } from '../src/db/schema'
import type { TriggerContext } from '@agent-workflow/shared'
import { isTaskActive } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
/** RFC-304 2ter.1: a reuse-by-id launch unseals the cached repo's URL. */
const TEST_SECRET_BOX = createSecretBoxFromKey(Buffer.alloc(32, 7))
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

  beforeAll(async () => {
    await startGitHttpRemote()
  })
  afterAll(() => {
    stopGitHttpRemote()
  })

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc304-wake-'))
    await seedCachedRepo(db, REPO)
  })
  afterEach(async () => {
    const launched = await db.select({ id: tasks.id }).from(tasks)
    for (
      let attempt = 0;
      attempt < 500 && launched.some((row) => isTaskActive(row.id));
      attempt++
    ) {
      await Bun.sleep(10)
    }
    expect(launched.filter((row) => isTaskActive(row.id)).map((row) => row.id)).toEqual([])
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
      launchDeps: { db, appHome, secretBox: TEST_SECRET_BOX } as never,
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
    // Explicitly widened: since T46b each capability has its OWN default event
    // set, and `ci-fix` defaults to `pipeline_failed` only. A team widening a
    // capability's set is a supported case, and saying so here keeps this test
    // about SEPARATION rather than about which defaults happen to overlap.
    await enable('ci-fix', { triggerConfig: { events: ['mr_opened'] } })
    const result = await deliver()
    expect(result.started).toHaveLength(2)
    const ids = new Set(result.started.map((s) => s.taskId))
    expect(ids.size).toBe(2)
  })

  test('each round gets its own round id', async () => {
    await enable('mr-review')
    await enable('ci-fix', { triggerConfig: { events: ['mr_opened'] } })
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

  test('a capability round launches with NO trigger or fire id', async () => {
    // This test used to assert the opposite, and the change is deliberate.
    //
    // RFC-301 required a webhook-origin launch to carry both a trigger id and a
    // fire id. A capability has neither and correctly so: it is not a trigger,
    // the repository wrote none, and there is no `webhook_triggers` row to point
    // at. The requirement being enforced is that a root task is ATTRIBUTABLE,
    // and a capability round is — by its round row. So the admission check now
    // accepts either anchor (`hasCodeRound`), and an ordinary trigger launch
    // still needs both ids.
    await enable('mr-review')
    await enable('ci-fix', { triggerConfig: { events: ['mr_opened'] } })
    const result = await wakeCapabilitiesForDelivery({
      db,
      repoId: REPO,
      eventType: 'mr_opened',
      mrIid: '412',
      triggerContext,
      webhookTriggerId: '',
      webhookFireId: '',
      launchDeps: { db, appHome, secretBox: TEST_SECRET_BOX } as never,
    })
    expect(result.failed).toEqual([])
    expect(result.started).toHaveLength(2)
  })

  test('a launch failure is reported, not swallowed, and does not stop the others', async () => {
    // A delivery that woke two cells and failed on the first must still start
    // the second — and the failure has to surface, because a launch that
    // vanished with no row is exactly what this RFC exists to prevent.
    await enable('mr-review')
    await enable('ci-fix', { triggerConfig: { events: ['mr_opened'] } })
    const result = await wakeCapabilitiesForDelivery({
      db,
      repoId: REPO,
      eventType: 'mr_opened',
      mrIid: '412',
      triggerContext,
      webhookTriggerId: 'trigger-1',
      webhookFireId: 'fire-1',
      // Deps with no database: `startCodeRoundTask` throws, which is what a
      // real launch failure looks like from here.
      launchDeps: {} as never,
    })
    expect(result.started).toEqual([])
    expect(result.failed).toHaveLength(2)
    expect(result.failed[0]?.error.length).toBeGreaterThan(0)
  })

  test('a malformed trigger context does not crash the delivery', async () => {
    // This function is documented as never throwing, and the webhook dispatcher
    // now calls it on live deliveries — so a context that is absent or the
    // wrong shape must be reported, not thrown. It previously crashed here,
    // taking down a delivery that had other work to do.
    await enable('mr-review')
    const result = await wakeCapabilitiesForDelivery({
      db,
      repoId: REPO,
      eventType: 'mr_opened',
      mrIid: '412',
      triggerContext: undefined as never,
      webhookTriggerId: '',
      webhookFireId: '',
      launchDeps: { db, appHome, secretBox: TEST_SECRET_BOX } as never,
    })
    // Reported, not thrown. The launch itself is still refused — a
    // webhook-origin round with no canonical context has nothing for
    // `resolve-target` to read, and would fail on the merge request in front of
    // the author. Both halves matter: no crash, and no silent start either.
    expect(result.started).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.capability).toBe('mr-review')
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

/**
 * A real `cached_repos` row whose mirror can actually be launched from.
 *
 * Required since RFC-304 2ter.1: a capability round is launched with
 * `cachedRepoId` rather than into a scratch space, because `prepare-worktree`
 * fetches the merge-request head from `origin` of the round's repository. A
 * fixture naming a repo id with nothing behind it now fails at launch — which
 * is correct, since in production the delivery resolved the repository before
 * anything woke.
 *
 * The remote is the shared smart-HTTP fixture rather than a `file://` URL: the
 * product deliberately refuses local paths as remotes (`file:// repositories
 * cannot be launched`), and the launcher re-fetches on reuse, so nothing short
 * of a real remote gets through. Same reasoning as `helpers/gitHttpRemote.ts`
 * itself — the alternative is a test-only bypass in production code, which
 * would dismantle the rule it is meant to respect.
 */
async function seedCachedRepo(db: DbClient, id: string): Promise<void> {
  const source = mkdtempSync(join(tmpdir(), 'aw-rfc304-remote-'))
  makeRepoAt(source)
  const url = remoteUrlFor(source)

  await db.insert(cachedRepos).values({
    id,
    urlHash: gitUrlCacheKeyWith(parseGitUrl(url)!, (value: string) =>
      createHash('sha1').update(value).digest('hex'),
    ).hash,
    urlEnc: TEST_SECRET_BOX.seal(url),
    urlRedacted: url,
    localPath: join(source, '..', `${id}-mirror`),
    defaultBranch: 'main',
    lastFetchedAt: Date.now(),
    createdAt: Date.now(),
  })
}

/** A minimal repository with one commit on `main`, for `seedCachedRepo`. */
function makeRepoAt(dir: string): void {
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]): void => {
    const out = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' })
    if (out.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr}`)
  }
  spawnSync('git', ['init', '-b', 'main', dir], { encoding: 'utf8' })
  git('config', 'user.email', 'e2e@example.invalid')
  git('config', 'user.name', 'RFC-304 fixture')
  writeFileSync(join(dir, 'README.md'), 'rfc304 fixture\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
}
