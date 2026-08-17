// RFC-304 T40 — a merged merge request closes its capability work, from the
// real webhook dispatcher.
//
// This file exists because of a pattern that has repeated through this RFC:
// both halves correct, no join. `closeMonitorItem` and `closeCapabilitiesFor-
// Delivery` can each be complete, unit-tested and green while nothing in
// production ever calls them — and an absent mechanism never errors, so no test
// anywhere goes red. So this drives `dispatcher.dispatch()`, the same entry the
// ingress route uses, and checks the row.
//
// The failure it guards is not cosmetic. A work item left open on a merged
// merge request is not inert: a pipeline finishing after the merge is an
// ordinary event, and it would wake the item and start work on a branch whose
// changes are already in.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { resolve, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { remoteUrlFor, startGitHttpRemote, stopGitHttpRemote } from './helpers/gitHttpRemote'
import { gitUrlCacheKeyWith, parseGitUrl } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { upsertCapabilityCell } from '../src/modules/code-capability/infrastructure/sqliteCapabilityMatrix'
import {
  codeWorkItems,
  codeWorkRounds,
  repoCapabilityConfig,
  tasks,
  webhookDeliveries,
  webhookEndpoints,
  cachedRepos,
} from '../src/db/schema'
import {
  createWebhookDispatcher,
  type WebhookDispatchDeps,
} from '../src/services/webhook/webhookDispatch'
import type { WebhookEndpointRow } from '../src/services/webhook/dispatcherTypes'
import { ensureWorkItem } from '../src/modules/code-capability/infrastructure/sqliteMonitorStore'
import {
  lookupProducedMr,
  registerProducedMr,
} from '../src/modules/code-capability/application/producedMrIndex'
import { isTerminalTaskStatus, type CodeHostEvent } from '@agent-workflow/shared'

// File-level: BOTH describe blocks seed a cached repo, and the remote has to be
// up before either of them runs.
beforeAll(async () => {
  await startGitHttpRemote()
})
afterAll(() => {
  stopGitHttpRemote()
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
/**
 * RFC-304 2ter.1: a reuse-by-id launch unseals the cached repo's URL.
 *
 * Same key the dispatcher fixtures below use. A different one seals a URL this
 * file's own dispatcher cannot read, and the launch fails with "sealed with a
 * different secret.key?" — which is the correct error for the wrong reason.
 */
const TEST_SECRET_BOX = createSecretBoxFromKey(Buffer.alloc(32, 9))
const ENDPOINT = 'ep-1'
const PROJECT = '41823'
const MR = '412'

/** Every capability cell is keyed by this; the resolver must return it. */
const REPO_ID = 'repo-1'
const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc304-wake-join-'))

const eventOf = (over: Partial<CodeHostEvent> = {}): CodeHostEvent =>
  ({
    provider: 'gitlab',
    eventUuid: ulid(),
    eventType: 'mr_merged',
    repoPath: 'group/project',
    repoHttpUrl: 'https://gitlab.example.com/group/project.git',
    repoSshUrl: 'git@gitlab.example.com:group/project.git',
    mrIid: MR,
    projectId: PROJECT,
    author: {},
    raw: {},
    ...over,
  }) as CodeHostEvent

describe('RFC-304 T40 — the dispatcher closes capability work items', () => {
  let db: DbClient
  let deps: WebhookDispatchDeps
  let endpoint: WebhookEndpointRow

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedCachedRepo(db, REPO_ID)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 9))
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'gitlab',
      provider: 'gitlab',
      urlToken: 'aw_whk_tok1',
      secretEnc: box.seal('s'),
      enabled: true,
    })
    endpoint = (
      await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, ENDPOINT)).limit(1)
    )[0]!

    deps = {
      db,
      configPath: '/nonexistent/config.json',
      secretBox: box,
      getDefaultRuntime: async () => null,
      // The repo resolver is stubbed rather than seeded through the git-url
      // cache: what is under test is whether the close is CALLED, not how a
      // URL maps to a row.
      resolveRepo: async () => ({ kind: 'cached', cachedRepoId: REPO_ID }),
      launch: async () => ulid(),
      cancel: async () => undefined,
    }

    await db.insert(repoCapabilityConfig).values({
      id: ulid(),
      repoId: REPO_ID,
      capability: 'mr-review',
      enabled: true,
      readiness: 'ready',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  })
  afterEach(() => {
    db.$client.close()
  })

  const deliver = async (event: CodeHostEvent): Promise<void> => {
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: ENDPOINT,
      eventType: event.eventType,
      status: 'received',
      receivedAt: Date.now(),
    })
    await createWebhookDispatcher(deps).dispatch({ deliveryId, endpoint, event })
  }

  const itemStatus = async (): Promise<string | undefined> => {
    const [row] = await db
      .select({ status: codeWorkItems.status })
      .from(codeWorkItems)
      .where(eq(codeWorkItems.anchorId, MR))
      .limit(1)
    return row?.status
  }

  test('a merged merge request closes the work item — with no trigger involved', async () => {
    // No trigger row exists in this database at all. That is the normal state
    // of a repository that switched on a capability, and it is exactly the case
    // the old code path could not serve: dispatch would find no trigger hits,
    // mark the delivery `ignored`, and return.
    await ensureWorkItem({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: MR,
    })
    expect(await itemStatus()).toBe('idle')

    await deliver(eventOf())

    expect(await itemStatus()).toBe('closed')
  })

  test('an mr_closed event closes it too', async () => {
    await ensureWorkItem({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: MR,
    })

    await deliver(eventOf({ eventType: 'mr_closed' }))

    expect(await itemStatus()).toBe('closed')
  })

  test('an ordinary update does NOT close anything', async () => {
    // The other half of the rule. A close on every delivery would end a merge
    // request's automated work the first time anyone commented on it.
    await ensureWorkItem({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: MR,
    })

    await deliver(eventOf({ eventType: 'mr_updated' }))

    // NOT closed — that is what this test is about. It no longer asserts
    // `idle`: since the work-item state machine was wired (§2.2), an ordinary
    // update legitimately advances the item through `queued` → `running`,
    // because a round really is opened and dispatched for it. `idle` was a
    // proxy for "nothing happened", and now something does.
    const status = await itemStatus()
    expect(status).not.toBe('closed')
    expect(status).not.toBe('closing')
    expect(status).toBe('running')
  })

  test("a merge on a DIFFERENT instance's project leaves this item alone", async () => {
    // The endpoint is part of a work item's identity. Closing by project id
    // alone would let one GitLab instance's merge close another's item, which
    // in a two-instance deployment means work silently stopping on a merge
    // request nobody touched.
    await ensureWorkItem({
      db,
      codeHostEndpointId: 'ep-other',
      stableProjectId: PROJECT,
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: MR,
    })

    await deliver(eventOf())

    const [row] = await db
      .select({ status: codeWorkItems.status })
      .from(codeWorkItems)
      .where(eq(codeWorkItems.codeHostEndpointId, 'ep-other'))
      .limit(1)
    expect(row?.status).toBe('idle')
  })

  test('a delivery whose repository is unregistered is a no-op, not a crash', async () => {
    deps = { ...deps, resolveRepo: async () => ({ kind: 'unregistered' }) }
    await ensureWorkItem({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: MR,
    })

    await deliver(eventOf())

    expect(await itemStatus()).toBe('idle')
  })

  test('T50b — merging a produced MR closes the REQUIREMENT that produced it', async () => {
    // The requirement's work item is anchored to an issue, so the per-capability
    // loop above cannot reach it: its identity has a different anchor entirely.
    // The produced-MR index is the only path from the merged MR back to it, and
    // without this the requirement stays open after its code has shipped —
    // visible forever in the activity view as work in progress.
    const requirement = await ensureWorkItem({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      capability: 'requirement',
      anchorKind: 'issue',
      anchorId: '88',
    })
    await registerProducedMr({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      mrIid: MR,
      workItemId: requirement.id,
    })

    await deliver(eventOf())

    const [row] = await db
      .select({ status: codeWorkItems.status })
      .from(codeWorkItems)
      .where(eq(codeWorkItems.id, requirement.id))
    expect(row?.status).toBe('closed')
    // …and the index row is claimed, so a second delivery of the same merge
    // does not close it again.
    const indexed = await lookupProducedMr(db, {
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      mrIid: MR,
    })
    expect(indexed?.closedAt).not.toBeNull()
  })

  test('T50b — an ordinary merge closes no requirement', async () => {
    // Most merges in a repository have nothing to do with this platform.
    const requirement = await ensureWorkItem({
      db,
      codeHostEndpointId: ENDPOINT,
      stableProjectId: PROJECT,
      capability: 'requirement',
      anchorKind: 'issue',
      anchorId: '88',
    })

    await deliver(eventOf())

    const [row] = await db
      .select({ status: codeWorkItems.status })
      .from(codeWorkItems)
      .where(eq(codeWorkItems.id, requirement.id))
    expect(row?.status).toBe('idle')
  })

  test('a repo-resolution failure does not fail the delivery', async () => {
    // Closing is bookkeeping. Letting it throw would trade a stale row for a
    // lost event, which is the worse of the two.
    deps = {
      ...deps,
      resolveRepo: async () => {
        throw new Error('the credential store is unreachable')
      },
    }

    await deliver(eventOf())
    // Reaching here without throwing IS the assertion; the explicit check keeps
    // the intent visible.
    expect(true).toBe(true)
  })
})

describe('RFC-304 §3.1 — the dispatcher wakes capability cells', () => {
  // The join that did not exist. `wakeCapabilitiesForDelivery` shipped in PR-4a
  // with tests and ZERO callers: capabilities could be configured, cells could
  // report `ready`, and no webhook would ever start a round. Nothing was red,
  // because an absent join never errors.
  //
  // The case that matters is a repository with NO trigger at all, which is the
  // normal state of one whose only automation is a capability. Before this, the
  // dispatcher found no trigger hits, marked the delivery `ignored`, and
  // returned.
  let db: DbClient
  let deps: WebhookDispatchDeps
  let endpoint: WebhookEndpointRow

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedCachedRepo(db, REPO_ID)
    await seedTestDefaultOpencodeRuntime(db)
    const box = createSecretBoxFromKey(Buffer.alloc(32, 9))
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'gitlab',
      provider: 'gitlab',
      urlToken: 'aw_whk_tok1',
      secretEnc: box.seal('s'),
      enabled: true,
    })
    endpoint = (
      await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, ENDPOINT)).limit(1)
    )[0]!
    deps = {
      db,
      configPath: join(appHome, 'config.json'),
      secretBox: box,
      getDefaultRuntime: async () => null,
      resolveRepo: async () => ({ kind: 'cached', cachedRepoId: REPO_ID }),
      launch: async () => ulid(),
      cancel: async () => undefined,
    }
  })
  afterEach(async () => {
    // The dispatcher builds REAL launch deps, so a started round is a real task
    // that the driver is still finishing when the test body returns. Closing
    // the database under it throws from a background frame — which is a test
    // teardown race, not a production defect, and the honest fix is to wait
    // rather than to stop asserting that a real task was started.
    await settleTasks()
    db.$client.close()
  })

  /** Wait for every task this test started to reach a terminal status. */
  const settleTasks = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rows = await db.select({ status: tasks.status }).from(tasks)
      if (rows.every((row) => isTerminalTaskStatus(row.status))) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }

  const readyCell = async (capability: string): Promise<void> => {
    await upsertCapabilityCell(db, {
      repoId: REPO_ID,
      capability,
      templateId: 'binding-1',
      enabled: true,
      facts: {
        hasBinding: true,
        frameworkExists: true,
        hasTrigger: true,
        codeHostConfigured: true,
        invisibleAgentSlots: [],
        requiresWakeSource: false,
        hasWakeSource: false,
      },
      dependencyRevision: 1,
      now: Date.now(),
    })
  }

  const deliverUpdate = async (): Promise<void> => {
    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: ENDPOINT,
      eventType: 'mr_updated',
      status: 'received',
      receivedAt: Date.now(),
    })
    await createWebhookDispatcher(deps).dispatch({
      deliveryId,
      endpoint,
      event: eventOf({ eventType: 'mr_updated', commitSha: 'a'.repeat(40), branch: 'feature/x' }),
    })
  }

  test('a ready cell starts a round even though NO trigger matched', async () => {
    await readyCell('mr-review')

    await deliverUpdate()

    // A real work item, a real round, a real task — reached from the same
    // entry point the ingress route uses.
    const items = await db.select().from(codeWorkItems)
    expect(items.length).toBe(1)
    expect(items[0]?.capability).toBe('mr-review')
    const rounds = await db.select().from(codeWorkRounds)
    expect(rounds.length).toBe(1)
    expect(rounds[0]?.roundSeq).toBe(1)
    expect((await db.select().from(tasks)).length).toBe(1)
  })

  test('T46b — labelling an issue starts a requirement round, anchored to the ISSUE', async () => {
    // The entry point end to end: an `issue_labeled` delivery, through the real
    // dispatcher, to a work item anchored to issue 88. Anchored to `mr` it
    // would key the item to merge request 88 — a different object that happens
    // to share the number, with nothing anywhere to say so.
    await readyCell('requirement')

    const deliveryId = ulid()
    await db.insert(webhookDeliveries).values({
      id: deliveryId,
      endpointId: ENDPOINT,
      eventType: 'issue_labeled',
      status: 'received',
      receivedAt: Date.now(),
    })
    await createWebhookDispatcher(deps).dispatch({
      deliveryId,
      endpoint,
      event: eventOf({
        eventType: 'issue_labeled',
        mrIid: undefined,
        issueIid: '88',
        issueTitle: 'Retry logic drops the last attempt',
        addedLabels: ['aw:implement'],
      }),
    })

    const items = await db.select().from(codeWorkItems)
    expect(items.length).toBe(1)
    expect(items[0]?.capability).toBe('requirement')
    expect(items[0]?.anchorKind).toBe('issue')
    expect(items[0]?.anchorId).toBe('88')
    expect((await db.select().from(codeWorkRounds)).length).toBe(1)
  })

  test('a repository with no cells stays silent', async () => {
    await deliverUpdate()
    expect((await db.select().from(codeWorkItems)).length).toBe(0)
    expect((await db.select().from(tasks)).length).toBe(0)
  })

  test('the second delivery joins the SAME work item and preempts its round', async () => {
    // This used to expect rounds [1, 2] — a second round opened immediately.
    // That was the shape before the preemption effects were performed, and it
    // is the one design §2.2 不变量一 forbids: one work item may have at most
    // one running round, because two rounds on one merge request write the same
    // worktree and each publishes a review of a revision the other has already
    // replaced.
    //
    // What the second delivery does now: bumps the epoch, asks for the running
    // round to be cancelled, and registers itself as the revision the
    // REPLACEMENT round will serve once that task is genuinely terminal. No
    // task runs in this test, so the replacement correctly never starts — the
    // item is left mid-preemption, which is the state the boot sweep and the
    // next delivery both know how to resume.
    await readyCell('mr-review')

    await deliverUpdate()
    await deliverUpdate()

    // The identity assertion this test has always been about: one MR, one work
    // item, however many deliveries.
    const items = await db.select().from(codeWorkItems)
    expect(items.length).toBe(1)
    expect(items[0]?.status).toBe('superseding')
    // The epoch every stale-output check compares against moved.
    expect(items[0]?.epoch).toBe(2)
    // And the second delivery did NOT open a round beside the first.
    const rounds = await db.select().from(codeWorkRounds)
    expect(rounds.map((r) => r.roundSeq).sort()).toEqual([1])
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
