// RFC-309 T16 — the T64 upstream link, connected to a caller at last.
//
// `domain/templateUpstream.ts` shipped with RFC-304, was unit-tested, and had
// ZERO production imports until this RFC. Its unit tests proved the four states
// and the three-way merge are computed correctly from their inputs; what they
// could not prove is that anything ever supplies those inputs. That is the gap
// these cases close, and the reason each one starts from real rows rather than
// from a hand-built `UpstreamInput`.
//
// The load-bearing case is the last one: a copy with NO recorded base. Every
// copy made before migration 0175 is in that state, and the tempting shortcut —
// stand the local values in for the missing base — reads every difference as
// `take-upstream` and silently overwrites the local edits that were the entire
// reason somebody copied. So the absence of a base has to make the merge do
// LESS, not guess.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { capabilityTemplates } from '../src/db/schema'
import {
  mergeFromUpstream as mergeFromUpstreamWithPort,
  readUpstreamReport as readUpstreamReportWithPort,
} from '../src/modules/code-capability/application/templateUpstreamStatus'
import { composeSqliteCodeHistoryQueries } from '../src/modules/code-capability/composition/historyQueries'
import {
  composeSqliteCapabilityTemplateOperations,
  createSqliteCapabilityTemplatePersistence,
} from '../src/modules/code-capability/composition/capabilityTemplateOperations'
import { createSqliteTemplateUpstreamPersistence } from '../src/modules/code-capability/infrastructure/sqliteTemplateUpstreamPersistence'
import {
  mountCapabilityTemplateRoutes,
  type CapabilityTemplateRouteDeps,
} from '../src/routes/capabilityTemplates'
import { resetRouteMetaRegistry } from '../src/routes/registry'
import {
  copyTemplate as copyTemplateWithPersistence,
  mergeableSnapshot,
  templateDigest,
} from '../src/services/capabilityTemplates'
import {
  assertNameUnchangedForEditor,
  canViewResource,
  filterVisibleRows,
  getResourceAcl,
  requireResourceEdit,
  requireResourceGovern,
  updateResourceAcl,
} from '../src/services/resourceAcl'
import type { Permission } from '@agent-workflow/shared'
import { errorHandler } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000

const readUpstreamReport = async (db: DbClient, row: typeof capabilityTemplates.$inferSelect) => {
  const report = await readUpstreamReportWithPort(
    createSqliteTemplateUpstreamPersistence(db),
    row.id,
  )
  if (report === null) throw new Error(`no template ${row.id}`)
  return report
}
const mergeFromUpstream = (
  db: DbClient,
  row: typeof capabilityTemplates.$inferSelect,
  actor: Actor,
  now?: number,
) => mergeFromUpstreamWithPort(createSqliteTemplateUpstreamPersistence(db), row.id, actor, now)

const copyTemplate = (
  db: DbClient,
  source: typeof capabilityTemplates.$inferSelect,
  actor: Actor,
  name: string | undefined,
  now?: number,
) =>
  copyTemplateWithPersistence(
    createSqliteCapabilityTemplatePersistence(db),
    source,
    actor,
    name,
    now,
  )

const COPIER = {
  user: { id: 'u-copier', name: 'copier', role: 'user' },
  permissions: new Set<Permission>(['capability-templates:create']),
  source: 'session',
} as unknown as Actor

/** May author scripts, so a merge that carries one across is allowed. */
const AUTHOR = {
  user: { id: 'u-author', name: 'author', role: 'admin' },
  permissions: new Set<Permission>(['capability-templates:update', 'scripts:author']),
  source: 'session',
} as unknown as Actor

let db: DbClient

beforeEach(async () => {
  db = await createInMemoryDb(MIGRATIONS)
  await db.insert(capabilityTemplates).values({
    id: 'up-1',
    name: 'department review',
    capability: 'mr-review',
    scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v1' } }),
    paramsJson: JSON.stringify({ maxFindings: 20 }),
    agentBySlotJson: JSON.stringify({ reviewer: 'agent-dept' }),
    visibility: 'public',
    createdAt: NOW,
    updatedAt: NOW,
  })
})

async function row(id: string) {
  const found = (
    await db.select().from(capabilityTemplates).where(eq(capabilityTemplates.id, id))
  )[0]
  if (found === undefined) throw new Error(`no template ${id}`)
  return found
}

/** Move upstream on, the way a department fixing a script would. */
async function moveUpstream(patch: Partial<typeof capabilityTemplates.$inferInsert>) {
  await db
    .update(capabilityTemplates)
    .set({ updatedAt: NOW + 5_000, ...patch })
    .where(eq(capabilityTemplates.id, 'up-1'))
}

describe('RFC-309 T16 — reading where a copy stands', () => {
  test('a template authored here reports no upstream at all — not an error', async () => {
    // The common case for an original. Making the caller handle a failure for
    // it would put an error path on the majority of rows.
    const report = await readUpstreamReport(db, await row('up-1'))
    expect(report.link).toBeNull()
    expect(report.status).toBeNull()
    expect(report.fields).toEqual([])
  })

  test('a fresh copy is `current`, and names the template it came from', async () => {
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    const report = await readUpstreamReport(db, await row(copy.id))
    expect(report.status?.state).toBe('current')
    // The NAME, not the id: a badge reading `01JD…` sends the reader to another
    // page to find out what their own template descends from.
    expect(report.upstreamName).toBe('department review')
  })

  test('upstream moves and the copy is untouched ⇒ `update-available`', async () => {
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const report = await readUpstreamReport(db, await row(copy.id))
    expect(report.status?.state).toBe('update-available')
    expect(report.fields.find((f) => f.field === 'scripts')?.action).toBe('take-upstream')
  })

  test('both sides moved DIFFERENT fields ⇒ still cleanly mergeable, not a conflict', async () => {
    // The case the three-way diff exists for. A two-way comparison sees "these
    // rows differ" and has to ask a person about a change nobody disputes.
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db
      .update(capabilityTemplates)
      .set({ agentBySlotJson: JSON.stringify({ reviewer: 'agent-ours' }), updatedAt: NOW + 2_000 })
      .where(eq(capabilityTemplates.id, copy.id))
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const report = await readUpstreamReport(db, await row(copy.id))
    expect(report.status?.state).toBe('conflicted')
    expect(report.fields.find((f) => f.field === 'scripts')?.action).toBe('take-upstream')
    expect(report.fields.find((f) => f.field === 'agentBySlot')?.action).toBe('keep-local')
    expect(report.fields.find((f) => f.field === 'params')?.action).toBe('unchanged')
  })

  test('both sides moved the SAME field ⇒ a real conflict', async () => {
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db
      .update(capabilityTemplates)
      .set({
        scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo ours' } }),
        updatedAt: NOW + 2_000,
      })
      .where(eq(capabilityTemplates.id, copy.id))
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const report = await readUpstreamReport(db, await row(copy.id))
    expect(report.fields.find((f) => f.field === 'scripts')?.action).toBe('conflict')
  })

  test('the upstream being deleted reads `orphaned`, not `current`', async () => {
    // `current` would say "nothing to do" about a link that can never be
    // followed again — the most misleading of the four states.
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db.delete(capabilityTemplates).where(eq(capabilityTemplates.id, 'up-1'))

    const report = await readUpstreamReport(db, await row(copy.id))
    expect(report.status?.state).toBe('orphaned')
    expect(report.fields).toEqual([])
  })
})

describe('RFC-309 T16 — merging only what was not overridden', () => {
  test('takes upstream’s change, keeps ours, and rebases the link', async () => {
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db
      .update(capabilityTemplates)
      .set({ agentBySlotJson: JSON.stringify({ reviewer: 'agent-ours' }), updatedAt: NOW + 2_000 })
      .where(eq(capabilityTemplates.id, copy.id))
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const outcome = await mergeFromUpstream(db, await row(copy.id), AUTHOR, NOW + 9_000)
    expect(outcome).toMatchObject({ ok: true, applied: ['scripts'], keptLocal: ['agentBySlot'] })

    const after = await row(copy.id)
    expect(JSON.parse(after.scriptsJson)).toMatchObject({ collect: { script: 'echo v2' } })
    // The local edit survived the update. Without this the merge is just
    // "discard my work and take theirs", which is what people do NOT want when
    // they press a button labelled "keep my changes".
    expect(JSON.parse(after.agentBySlotJson)).toEqual({ reviewer: 'agent-ours' })

    // Rebased: asked again, there is nothing left to take. Omitting this is the
    // classic bug — the same update is offered forever and the badge never
    // clears, so people learn to ignore it.
    const again = await readUpstreamReport(db, await row(copy.id))
    expect(again.status?.state).toBe('current')
    expect(again.fields.some((f) => f.action === 'take-upstream')).toBe(false)
  })

  test('a genuine conflict is left ALONE — the merge never picks a side', async () => {
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db
      .update(capabilityTemplates)
      .set({
        scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo ours' } }),
        updatedAt: NOW + 2_000,
      })
      .where(eq(capabilityTemplates.id, copy.id))
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const outcome = await mergeFromUpstream(db, await row(copy.id), AUTHOR, NOW + 9_000)
    expect(outcome).toMatchObject({ ok: true, applied: [], stillConflicted: ['scripts'] })
    expect(JSON.parse((await row(copy.id)).scriptsJson)).toMatchObject({
      collect: { script: 'echo ours' },
    })
  })

  test('a partial merge does NOT quietly resolve what it could not merge', async () => {
    // The subtle one, and the reason the new base is taken per field rather
    // than wholesale. Advancing the base on a conflicted field would record
    // upstream's value as the common ancestor — so the next read sees our value
    // as the only change and reports `keep-local`, retiring a disagreement
    // nobody settled.
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db
      .update(capabilityTemplates)
      .set({
        scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo ours' } }),
        updatedAt: NOW + 2_000,
      })
      .where(eq(capabilityTemplates.id, copy.id))
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
      paramsJson: JSON.stringify({ maxFindings: 50 }),
    })

    const outcome = await mergeFromUpstream(db, await row(copy.id), AUTHOR, NOW + 9_000)
    expect(outcome).toMatchObject({ ok: true, applied: ['params'], stillConflicted: ['scripts'] })

    const again = await readUpstreamReport(db, await row(copy.id))
    expect(again.fields.find((f) => f.field === 'scripts')?.action).toBe('conflict')
    expect(again.fields.find((f) => f.field === 'params')?.action).toBe('unchanged')
    // Still not up to date: something is outstanding, so the badge stays.
    expect(again.status?.state).toBe('conflicted')
  })

  test('a merge with nothing to take writes nothing at all', async () => {
    // Including `updatedAt`. A no-op that bumped the timestamp would make every
    // template DOWNSTREAM of this one report `update-available` for a change
    // that never happened.
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    const before = await row(copy.id)
    expect(await mergeFromUpstream(db, before, AUTHOR, NOW + 9_000)).toMatchObject({
      ok: true,
      applied: [],
    })
    expect(await row(copy.id)).toEqual(before)
  })

  test('without scripts:author the merge is refused BEFORE anything is read', async () => {
    // AC-6's shape applied to the merge: a person who cannot author a script
    // must not be able to install one by pressing "update from upstream". The
    // check lives in the command rather than the route so a second caller
    // cannot become a way around it.
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const outcome = await mergeFromUpstream(db, await row(copy.id), COPIER, NOW + 9_000)
    expect(outcome).toEqual({ ok: false, code: 'scripts-forbidden' })
    // And nothing moved.
    expect(JSON.parse((await row(copy.id)).scriptsJson)).toMatchObject({
      collect: { script: 'echo v1' },
    })
  })

  test('a template with no upstream refuses rather than doing nothing quietly', async () => {
    const outcome = await mergeFromUpstream(db, await row('up-1'), AUTHOR, NOW + 9_000)
    expect(outcome).toEqual({ ok: false, code: 'no-upstream' })
  })

  test('an orphaned copy refuses with its own code, not the same one', async () => {
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'our review', NOW + 1_000)
    await db.delete(capabilityTemplates).where(eq(capabilityTemplates.id, 'up-1'))
    expect(await mergeFromUpstream(db, await row(copy.id), AUTHOR, NOW + 9_000)).toEqual({
      ok: false,
      code: 'upstream-gone',
    })
  })
})

describe('RFC-309 T16 — a copy with no recorded base (everything made before 0175)', () => {
  /** A copy exactly as RFC-304 wrote them: link and digest, no base values. */
  async function legacyCopy(): Promise<string> {
    const source = await row('up-1')
    await db.insert(capabilityTemplates).values({
      ...source,
      id: 'legacy-1',
      name: 'legacy copy',
      ownerUserId: 'u-copier',
      upstreamId: 'up-1',
      upstreamVersion: source.updatedAt,
      baseDigest: templateDigest(source),
      baseSnapshotJson: null,
      createdAt: NOW + 1_000,
      updatedAt: NOW + 1_000,
    })
    return 'legacy-1'
  }

  test('says so, so the interface can stop offering a merge it cannot predict', async () => {
    const id = await legacyCopy()
    expect((await readUpstreamReport(db, await row(id))).baseRecorded).toBe(false)
  })

  test('every difference is a CONFLICT — never a silent take-upstream', async () => {
    // The whole point. With local standing in for the missing base, `scripts`
    // below would read `take-upstream` and the merge would overwrite a script
    // this copy may well have edited — and there is no record either way.
    const id = await legacyCopy()
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const report = await readUpstreamReport(db, await row(id))
    expect(report.fields.find((f) => f.field === 'scripts')?.action).toBe('conflict')
    // Fields the two sides already agree on are still `unchanged`: refusing to
    // guess must not turn into flagging everything.
    expect(report.fields.find((f) => f.field === 'params')?.action).toBe('unchanged')
  })

  test('so its merge applies NOTHING', async () => {
    const id = await legacyCopy()
    await moveUpstream({
      scriptsJson: JSON.stringify({ collect: { language: 'bash', script: 'echo v2' } }),
    })

    const outcome = await mergeFromUpstream(db, await row(id), AUTHOR, NOW + 9_000)
    expect(outcome).toMatchObject({ ok: true, applied: [], stillConflicted: ['scripts'] })
  })

  test('but a copy made TODAY records one', async () => {
    // The forward guarantee that makes the degradation above temporary rather
    // than permanent.
    const copy = await copyTemplate(db, await row('up-1'), COPIER, 'fresh', NOW + 1_000)
    const stored = await row(copy.id)
    expect(stored.baseSnapshotJson).not.toBeNull()
    expect(JSON.parse(stored.baseSnapshotJson ?? 'null')).toEqual(
      mergeableSnapshot(await row('up-1')) as Record<string, unknown>,
    )
  })
})

// The HTTP face. Kept in this file rather than a separate one because the codes
// below only make sense next to the states above — and the guard that requires
// every route-thrown error code to be NAMED by a test reads this file for them.
describe('RFC-309 T16 — the merge endpoint says which thing went wrong', () => {
  const TOKEN = 'aw-fixture-upstream-token'
  let app: Hono

  beforeEach(() => {
    resetRouteMetaRegistry()
    app = new Hono()
    const actor = buildActor({
      user: {
        id: 'rfc309-template-upstream-user',
        username: 'rfc309-template-upstream-user',
        displayName: 'RFC-309 Template Upstream User',
        role: 'admin',
        status: 'active',
      },
      source: 'daemon',
    })
    const injectActor: MiddlewareHandler = async (context, next) => {
      context.set('actor', actor)
      await next()
    }
    app.use('*', injectActor)
    app.onError(errorHandler)
    const persistence = createSqliteCapabilityTemplatePersistence(db)
    const capabilityTemplateAcl: CapabilityTemplateRouteDeps['capabilityTemplateAcl'] = {
      load: (id) => persistence.load(id),
      canView: async (routeActor, resource) =>
        canViewResource(db, routeActor, 'capability_template', resource),
      read: async (routeActor, resource) =>
        getResourceAcl(db, routeActor, 'capability_template', resource),
      update: async (routeActor, resource, body, updatedAt) =>
        updateResourceAcl(db, routeActor, 'capability_template', resource, body, {
          ...(updatedAt === undefined ? {} : { updatedAt }),
        }),
    }
    mountCapabilityTemplateRoutes(app, {
      codeHistoryQueries: composeSqliteCodeHistoryQueries(db),
      capabilityTemplates: composeSqliteCapabilityTemplateOperations({
        db,
        access: {
          filterVisible: async (routeActor, rows) =>
            filterVisibleRows(db, routeActor, 'capability_template', rows),
          canView: async (routeActor, resource) =>
            canViewResource(db, routeActor, 'capability_template', resource),
          requireEdit: async (routeActor, resource) =>
            requireResourceEdit(db, routeActor, 'capability_template', resource),
          requireGovern: async (routeActor, resource) =>
            requireResourceGovern(db, routeActor, 'capability_template', resource),
          assertNameUnchangedForEditor,
        },
      }),
      capabilityTemplateAcl,
    })
  })
  afterEach(() => {
    db.$client.close()
    resetRouteMetaRegistry()
  })

  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const merge = async (id: string) =>
    await app.request(`/api/capability-templates/${id}/upstream/merge`, {
      method: 'POST',
      headers,
      body: '{}',
    })

  test('an original: `capability-template-no-upstream`, not a silent success', async () => {
    // A 200 here would tell the caller the merge happened. Nothing did, and
    // nothing could — this template was authored, not copied.
    const res = await merge('up-1')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('capability-template-no-upstream')
  })

  test('a copy whose original is gone: `capability-template-upstream-gone`', async () => {
    // A distinct code from the one above, on purpose: "there was never an
    // upstream" and "the upstream was deleted" send the reader to different
    // places, and one code for both sends half of them to the wrong one.
    const source = await row('up-1')
    await db.insert(capabilityTemplates).values({
      ...source,
      id: 'orphan-1',
      name: 'orphan copy',
      upstreamId: 'up-gone',
      upstreamVersion: NOW,
      baseDigest: 'd0',
    })
    const res = await merge('orphan-1')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(await res.json())).toContain('capability-template-upstream-gone')
  })
})
