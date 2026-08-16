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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import {
  codeWorkItems,
  repoCapabilityConfig,
  webhookDeliveries,
  webhookEndpoints,
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
import type { CodeHostEvent } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ENDPOINT = 'ep-1'
const PROJECT = '41823'
const MR = '412'

/** Every capability cell is keyed by this; the resolver must return it. */
const REPO_ID = 'repo-1'

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

    expect(await itemStatus()).toBe('idle')
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
