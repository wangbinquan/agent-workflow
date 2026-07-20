// RFC-211 — guided onboarding sandbox.
//
// What each block is here to stop from regressing:
//
//  1. "the guide built it" must mean "it actually runs". The previous demo
//     fixture referenced an agent named `coder` that was never created, so the
//     one-click import succeeded and then died with agent-not-found at launch.
//     Asserting `ok: true` from the real validator (not "the row was inserted")
//     is the whole point.
//  2. Cleanup must survive the guard maze. `countReferencingTasksInTx` counts
//     task rows regardless of status, so a workflow that ever ran is
//     permanently undeletable unless the task rows go first.
//  3. Ownership must be filtered in SQL. `isResourceOwner` returns true for any
//     admin, so an ACL-only implementation quietly turns an admin's personal
//     "clean up my practice stuff" into an instance-wide purge.
//  4. The two marker sources (onboarding_artifacts / per-row `example`) must
//     converge — nothing in the schema enforces that.

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { validateWorkflowDefinition } from '../src/services/workflow.validator'
import { CreateAgentSchema, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, skills, tasks, users, workflows, workgroups } from '../src/db/schema'
import type { Actor } from '../src/auth/actor'
import type { Hono } from 'hono'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { createSession } from '../src/auth/sessionStore'
import {
  adoptResource,
  diffExampleMarkers,
  listRuns,
  provisionStep,
  releaseArtifact,
  startRun,
  suffixFromRunId,
} from '../src/services/onboarding'
import { cleanupExamples, collectExamples } from '../src/services/exampleCleanup'
import { createAgent, deleteAgent, getAgent, listAgents } from '../src/services/agent'
import { createWorkflow, getWorkflow } from '../src/services/workflow'
import { getWorkgroup } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function mkActor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return {
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
    permissions: new Set(),
  }
}

function skillFs(): { appHome: string } {
  return { appHome: mkdtempSync(join(tmpdir(), 'aw-rfc211-')) }
}

/**
 * onboarding_runs.user_id has a real FK (a deleted user takes their guide state
 * with them), so every test actor needs a row.
 */
async function seedUser(db: DbClient, id: string, role: 'admin' | 'user' = 'user'): Promise<Actor> {
  const now = Date.now()
  await db
    .insert(users)
    .values({
      id,
      username: id,
      displayName: id,
      role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
  return mkActor(id, role)
}

describe('RFC-211 — run lifecycle', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('the name suffix is lowercase — uppercase would 422 against every name regex', () => {
    // ULID is uppercase Crockford base32; all four resource-name schemas are
    // /^[a-z0-9][a-z0-9_-]*$/. Taking the tail without lowercasing produces a
    // name the API rejects, which would only surface at provision time.
    const id = ulid()
    const suffix = suffixFromRunId(id)
    expect(suffix).toBe(suffix.toLowerCase())
    expect(/^[a-z0-9][a-z0-9_-]*$/.test(`guide-coder-${suffix}`)).toBe(true)
  })

  test('starting the same track twice reuses the active run instead of forking a second set', async () => {
    const actor = await seedUser(db, 'u1')
    const first = await startRun(db, actor, 'agent')
    const second = await startRun(db, actor, 'agent')
    expect(second.id).toBe(first.id)
    expect((await listRuns(db, actor)).length).toBe(1)
  })

  test("another user's run is 404, not 403", async () => {
    const run = await startRun(db, await seedUser(db, 'u1'), 'agent')
    await expect(
      provisionStep(db, await seedUser(db, 'u2'), run.id, 'agent.create', { skillFs: skillFs() }),
    ).rejects.toThrow(/not found/i)
  })

  test('two users walking the same track do not collide on globally unique names', async () => {
    const fs = skillFs()
    const a = await startRun(db, await seedUser(db, 'alice'), 'agent')
    const b = await startRun(db, await seedUser(db, 'bob'), 'agent')
    const ra = await provisionStep(db, await seedUser(db, 'alice'), a.id, 'agent.create', {
      skillFs: fs,
    })
    const rb = await provisionStep(db, await seedUser(db, 'bob'), b.id, 'agent.create', {
      skillFs: fs,
    })
    expect(ra.resourceName).not.toBe(rb.resourceName)
  })
})

describe('RFC-211 — provisioned examples are actually runnable', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('the example agent declares an output port', async () => {
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'agent')
    const res = await provisionStep(db, actor, run.id, 'agent.create', { skillFs: skillFs() })
    const agent = await getAgent(db, res.resourceName)
    // An agent with zero declared ports still gets the "you MUST end your reply
    // with a block listing these ports:" protocol block appended — with an empty
    // list. That reliably ends in envelope-missing, i.e. the guide's very first
    // run fails.
    expect(agent?.outputs.length).toBeGreaterThan(0)
    expect(agent?.bodyMd.length).toBeGreaterThan(0)
  })

  test('the example agent + skill are private and owned by the learner', async () => {
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'skill')
    await provisionStep(db, actor, run.id, 'skill.create', { skillFs: skillFs() })
    const rows = await db.select().from(skills)
    expect(rows.length).toBe(1)
    expect(rows[0]?.visibility).toBe('private')
    expect(rows[0]?.ownerUserId).toBe('u1')
    expect(rows[0]?.example).toBe(true)
    // opencode drops skills without a description from `available_skills`
    // entirely — an empty one would be installed, attached, and invisible.
    expect((rows[0]?.description ?? '').length).toBeGreaterThan(0)
  })

  test('the example workflow passes the real validator with zero issues', async () => {
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'workflow')
    const res = await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: skillFs() })
    const wf = await getWorkflow(db, res.resourceId)
    expect(wf).not.toBeNull()
    // Feed the validator the same mapped DTOs the production launch path uses,
    // not hand-rebuilt rows — otherwise the test can pass on a shape the real
    // caller never produces.
    const verdict = validateWorkflowDefinition(wf!.definition, {
      agents: await listAgents(db),
      skills: [],
      plugins: [],
    } as never)
    expect(verdict.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(verdict.ok).toBe(true)
  })

  test('the example workgroup passes launch readiness with a real worker, not just a leader', async () => {
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'workgroup')
    const res = await provisionStep(db, actor, run.id, 'workgroup.create', { skillFs: skillFs() })
    const group = await getWorkgroup(db, res.resourceName)
    expect(group).not.toBeNull()
    const readiness = workgroupLaunchReadiness({
      mode: group!.mode,
      leaderMemberId: group!.leaderMemberId ?? null,
      members: group!.members.map((m) => ({ id: m.id, memberType: m.memberType })),
    } as never)
    expect(readiness.ready).toBe(true)
    // A leader-only group is "ready" but has nobody to delegate to: it runs
    // green and does nothing, which is a worse first impression than an error.
    expect(readiness.warnings).toEqual([])
  })

  test('provisioning the same step twice reuses the resource', async () => {
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'agent')
    const first = await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })
    const second = await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })
    expect(second.reused).toBe(true)
    expect(second.resourceId).toBe(first.resourceId)
    expect((await db.select().from(agents)).length).toBe(1)
  })
})

describe('RFC-211 — adoption ("我自己来")', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('adopting marks the row without touching the ACL the user chose', async () => {
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'agent')
    const created = await createAgent(
      db,
      CreateAgentSchema.parse({ name: 'my-own-agent', outputs: ['result'] }),
      {
        ownerUserId: 'u1',
      },
    )
    expect(created.visibility).toBe('public')
    const before = await db.select().from(agents).where(eq(agents.id, created.id)).get()

    await adoptResource(db, actor, run.id, {
      step: 'agent.create',
      resourceType: 'agent',
      resourceKey: 'my-own-agent',
    })

    const after = await db.select().from(agents).where(eq(agents.id, created.id)).get()
    expect(after?.example).toBe(true)
    // Adoption marks; it does not re-classify. Flipping this to private would
    // remove the resource from every other user's list and break their saves
    // with acl-missing-refs — silently, on both sides.
    expect(after?.visibility).toBe(before?.visibility)
    expect(after?.aclRevision).toBe(before?.aclRevision ?? 0)
  })

  test("adopting somebody else's resource is refused", async () => {
    const run = await startRun(db, await seedUser(db, 'u1'), 'agent')
    await createAgent(db, CreateAgentSchema.parse({ name: 'bobs-agent', outputs: ['result'] }), {
      ownerUserId: 'bob',
    })
    await expect(
      adoptResource(db, await seedUser(db, 'u1'), run.id, {
        step: 'agent.create',
        resourceType: 'agent',
        resourceKey: 'bobs-agent',
      }),
    ).rejects.toThrow(/not found/i)
    const row = await db.select().from(agents).where(eq(agents.name, 'bobs-agent')).get()
    expect(row?.example).toBe(false)
  })

  test("an admin cannot adopt another user's resource either", async () => {
    // The admin CAN see it, so this must be an explicit refusal rather than the
    // D1 404 — adopting would silently privatise and later delete their row.
    const run = await startRun(db, await seedUser(db, 'root', 'admin'), 'agent')
    await createAgent(db, CreateAgentSchema.parse({ name: 'bobs-agent', outputs: ['result'] }), {
      ownerUserId: 'bob',
    })
    await expect(
      adoptResource(db, await seedUser(db, 'root', 'admin'), run.id, {
        step: 'agent.create',
        resourceType: 'agent',
        resourceKey: 'bobs-agent',
      }),
    ).rejects.toThrow(/owner/i)
  })
})

describe('RFC-211 — one-click cleanup', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  async function seedRunTask(workflowId: string, owner: string, example: boolean): Promise<string> {
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: `task-${taskId}`,
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      ownerUserId: owner,
      spaceKind: 'scratch',
      example,
    })
    return taskId
  }

  test('a workflow that already ran is still deletable — tasks go first', async () => {
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'workflow')
    const res = await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: skillFs() })
    await seedRunTask(res.resourceId, 'u1', true)

    // Without the task delete this is a permanent 409 workflow-in-use: the
    // reference count ignores task status, so even a finished run pins it.
    const result = await cleanupExamples(db, actor, 'mine', { skillFs: skillFs() })
    const wfItem = result.items.find((i) => i.resourceType === 'workflow')
    expect(wfItem?.outcome).toBe('deleted')
    expect((await db.select().from(workflows)).length).toBe(0)
    expect((await db.select().from(tasks)).length).toBe(0)
  })

  test('cleanup deletes agents, skills, workflows and workgroups in dependency order', async () => {
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    for (const track of ['agent', 'skill', 'workflow', 'workgroup'] as const) {
      const run = await startRun(db, actor, track)
      const first = {
        agent: 'agent.create',
        skill: 'skill.attach',
        workflow: 'workflow.create',
        workgroup: 'workgroup.create',
      } as const
      await provisionStep(db, actor, run.id, first[track], { skillFs: fs })
    }
    expect((await collectExamples(db, actor, 'mine')).entries.length).toBeGreaterThan(3)

    const result = await cleanupExamples(db, actor, 'mine', { skillFs: fs })
    expect(result.items.every((i) => i.outcome === 'deleted')).toBe(true)
    expect(result.complete).toBe(true)
    expect((await db.select().from(agents)).length).toBe(0)
    expect((await db.select().from(skills)).length).toBe(0)
    expect((await db.select().from(workflows)).length).toBe(0)
    expect((await db.select().from(workgroups)).length).toBe(0)
  })

  test('cleanup never touches non-example resources or their tasks', async () => {
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'agent')
    await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })

    const keptAgent = await createAgent(
      db,
      CreateAgentSchema.parse({ name: 'real-agent', outputs: ['x'] }),
      {
        ownerUserId: 'u1',
      },
    )
    const keptWf = await createWorkflow(
      db,
      { name: 'real-wf', description: '', definition: { $schema_version: 4 } as never },
      { ownerUserId: 'u1' },
    )
    const keptTask = await seedRunTask(keptWf.id, 'u1', false)

    await cleanupExamples(db, actor, 'mine', { skillFs: fs })

    expect(await db.select().from(agents).where(eq(agents.id, keptAgent.id)).get()).toBeDefined()
    expect(await db.select().from(workflows).where(eq(workflows.id, keptWf.id)).get()).toBeDefined()
    expect(await db.select().from(tasks).where(eq(tasks.id, keptTask)).get()).toBeDefined()
  })

  test("an admin's own cleanup does NOT wipe other users' guided tours", async () => {
    // isResourceOwner returns true for any admin, so an implementation that
    // leans on requireResourceOwner instead of filtering owner in SQL turns
    // this button into an instance-wide purge.
    const fs = skillFs()
    const admin = await seedUser(db, 'root', 'admin')
    const learner = await seedUser(db, 'bob')
    const adminRun = await startRun(db, admin, 'agent')
    const learnerRun = await startRun(db, learner, 'agent')
    await provisionStep(db, admin, adminRun.id, 'agent.create', { skillFs: fs })
    await provisionStep(db, learner, learnerRun.id, 'agent.create', { skillFs: fs })
    expect((await db.select().from(agents)).length).toBe(2)

    const mine = await collectExamples(db, admin, 'mine')
    expect(mine.entries.length).toBe(1)
    expect(mine.entries[0]?.ownerUserId).toBe('root')

    await cleanupExamples(db, admin, 'mine', { skillFs: fs })
    const left = await db.select().from(agents)
    expect(left.length).toBe(1)
    expect(left[0]?.ownerUserId).toBe('bob')
  })

  test('admin scope=all sees and sweeps every learner', async () => {
    const fs = skillFs()
    const admin = await seedUser(db, 'root', 'admin')
    const learner = await seedUser(db, 'bob')
    await provisionStep(db, learner, (await startRun(db, learner, 'agent')).id, 'agent.create', {
      skillFs: fs,
    })
    expect((await collectExamples(db, admin, 'all')).entries.length).toBe(1)
    await cleanupExamples(db, admin, 'all', { skillFs: fs })
    expect((await db.select().from(agents)).length).toBe(0)
  })

  test('cleanup is idempotent — pressing it twice is not an error', async () => {
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'agent')
    await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })
    await cleanupExamples(db, actor, 'mine', { skillFs: fs })
    const second = await cleanupExamples(db, actor, 'mine', { skillFs: fs })
    expect(second.items).toEqual([])
    expect(second.complete).toBe(true)
  })

  test('the two marker sources converge back to empty together', async () => {
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'workflow')
    await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: fs })
    await cleanupExamples(db, actor, 'mine', { skillFs: fs })

    const runs = await listRuns(db, actor)
    expect(runs[0]?.artifacts).toEqual([])
    expect((await collectExamples(db, actor, 'mine')).entries).toEqual([])
  })
})

describe('RFC-211 — diffExampleMarkers (pure oracle)', () => {
  test('agreement produces an empty diff', () => {
    expect(
      diffExampleMarkers(
        [{ resourceType: 'agent', resourceId: 'a1' }],
        [{ resourceType: 'agent', id: 'a1', example: true }],
      ),
    ).toEqual({ markedWithoutArtifact: [], artifactWithoutMark: [] })
  })

  test('a flagged row with no bookkeeping row is reported', () => {
    expect(diffExampleMarkers([], [{ resourceType: 'agent', id: 'a1', example: true }])).toEqual({
      markedWithoutArtifact: ['agent:a1'],
      artifactWithoutMark: [],
    })
  })

  test('a bookkeeping row whose resource lost the flag is reported', () => {
    expect(
      diffExampleMarkers(
        [{ resourceType: 'skill', resourceId: 's1' }],
        [{ resourceType: 'skill', id: 's1', example: false }],
      ),
    ).toEqual({ markedWithoutArtifact: [], artifactWithoutMark: ['skill:s1'] })
  })

  test('unflagged rows are ignored entirely', () => {
    expect(diffExampleMarkers([], [{ resourceType: 'agent', id: 'real', example: false }])).toEqual(
      { markedWithoutArtifact: [], artifactWithoutMark: [] },
    )
  })
})

// ---------------------------------------------------------------------------
// HTTP surface. The 4xx half is the point here: the route-error-code ratchet
// (route-error-code-coverage.test.ts) exists because rejection branches get
// written and then never exercised, so a guard can be deleted with every test
// still green. Each case below names the exact code, not a status range.
// ---------------------------------------------------------------------------

describe('RFC-211 — onboarding HTTP routes', () => {
  let db: DbClient
  let app: Hono
  let userToken: string
  let adminToken: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: 'daemon-token-never-used',
      configPath: '/tmp/aw-rfc211-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const u = await createUser(db, {
      username: 'learner',
      displayName: 'learner',
      role: 'user',
      password: 'longEnoughPassword',
    })
    userToken = (await createSession({ db, userId: u.id })).token
    const a = await createUser(db, {
      username: 'root',
      displayName: 'root',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    adminToken = (await createSession({ db, userId: a.id })).token
  })

  async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    return app.request(path, { ...init, headers })
  }

  test('POST /api/onboarding/runs rejects an unknown track with onboarding-run-invalid', async () => {
    const res = await call(userToken, '/api/onboarding/runs', {
      method: 'POST',
      body: JSON.stringify({ track: 'not-a-track' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('onboarding-run-invalid')
  })

  test('PATCH /api/onboarding/runs/:id rejects an unknown status with onboarding-run-invalid', async () => {
    const created = await call(userToken, '/api/onboarding/runs', {
      method: 'POST',
      body: JSON.stringify({ track: 'agent' }),
    })
    const run = (await created.json()) as { id: string }
    const res = await call(userToken, `/api/onboarding/runs/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'nonsense' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('onboarding-run-invalid')
  })

  test('provision rejects an unknown step with onboarding-step-invalid', async () => {
    const created = await call(userToken, '/api/onboarding/runs', {
      method: 'POST',
      body: JSON.stringify({ track: 'agent' }),
    })
    const run = (await created.json()) as { id: string }
    const res = await call(userToken, `/api/onboarding/runs/${run.id}/provision`, {
      method: 'POST',
      body: JSON.stringify({ step: 'agent.not-a-step' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('onboarding-step-invalid')
  })

  test('adopt rejects a malformed body with onboarding-adopt-invalid', async () => {
    const created = await call(userToken, '/api/onboarding/runs', {
      method: 'POST',
      body: JSON.stringify({ track: 'agent' }),
    })
    const run = (await created.json()) as { id: string }
    const res = await call(userToken, `/api/onboarding/runs/${run.id}/adopt`, {
      method: 'POST',
      // resourceKey missing — the guide must not silently adopt "something".
      body: JSON.stringify({ step: 'agent.create', resourceType: 'agent' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('onboarding-adopt-invalid')
  })

  test('a run belonging to somebody else is 404, byte-identical to a missing one', async () => {
    const mine = await call(userToken, '/api/onboarding/runs', {
      method: 'POST',
      body: JSON.stringify({ track: 'agent' }),
    })
    const run = (await mine.json()) as { id: string }

    const stranger = await createUser(db, {
      username: 'stranger',
      displayName: 'stranger',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const strangerToken = (await createSession({ db, userId: stranger.id })).token

    const foreign = await call(strangerToken, `/api/onboarding/runs/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'abandoned' }),
    })
    const missing = await call(strangerToken, '/api/onboarding/runs/01KZZZZZZZZZZZZZZZZZZZZZZZ', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'abandoned' }),
    })
    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    // RFC-099 D1: an error shape must never reveal that someone else's thing exists.
    const a = (await foreign.json()) as { code: string }
    const b = (await missing.json()) as { code: string }
    expect(a.code).toBe(b.code)
  })

  test('scope=all is admin-only on both the preview and the sweep', async () => {
    for (const [method, path] of [
      ['GET', '/api/onboarding/examples?scope=all'],
      ['DELETE', '/api/onboarding/examples?scope=all'],
    ] as const) {
      const denied = await call(userToken, path, { method })
      expect({ method, status: denied.status }).toEqual({ method, status: 403 })
      const allowed = await call(adminToken, path, { method })
      expect({ method, status: allowed.status }).toEqual({ method, status: 200 })
    }
  })

  test('a regular user can preview and sweep their own scope', async () => {
    const res = await call(userToken, '/api/onboarding/examples', { method: 'GET' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { scope: string }).scope).toBe('mine')
  })
})

// ---------------------------------------------------------------------------
// Regressions found by the RFC-211 implementation-gate adversarial review.
// Each of these was a real wedge or a real irreversible side effect.
// ---------------------------------------------------------------------------

describe('RFC-211 — review regressions', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('deleting a guide resource by hand does not wedge the run', async () => {
    // The ordinary DELETE endpoints do not touch onboarding_artifacts (there is
    // no FK by design), so a stale row is the NORMAL state after any manual
    // cleanup. If provisioning trusted it, every later attempt would re-create
    // under the same name — a permanent 409 for agents (globally unique names).
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'agent')
    const first = await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })
    await deleteAgent(db, first.resourceName, actor)

    const second = await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })
    expect(second.reused).toBe(false)
    expect((await db.select().from(agents)).length).toBe(1)
    // And the dead bookkeeping row is gone rather than piling up.
    const rows = await listRuns(db, actor)
    expect(rows[0]?.artifacts.filter((a) => a.resourceType === 'agent').length).toBe(1)
  })

  test('a hand-deleted example workflow does not spawn duplicates on retry', async () => {
    // workflows.name is NOT unique, so the same bug shows up as silent
    // duplication instead of a 409.
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'workflow')
    const first = await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: fs })
    await db.delete(workflows).where(eq(workflows.id, first.resourceId))

    await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: fs })
    await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: fs })
    expect((await db.select().from(workflows)).length).toBe(1)
  })

  test('adoption marks but never re-classifies, and is reversible', async () => {
    // Flipping an adopted resource to private would make it vanish from every
    // other user's list and break their saves with acl-missing-refs — with no
    // notice on either side, and (before releaseArtifact) no way back.
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'agent')
    const created = await createAgent(
      db,
      CreateAgentSchema.parse({ name: 'my-real-agent', outputs: ['result'] }),
      { ownerUserId: 'u1' },
    )

    await adoptResource(db, actor, run.id, {
      step: 'agent.create',
      resourceType: 'agent',
      resourceKey: 'my-real-agent',
    })
    const adopted = await db.select().from(agents).where(eq(agents.id, created.id)).get()
    expect(adopted?.example).toBe(true)
    expect(adopted?.visibility).toBe('public') // untouched

    const runs = await listRuns(db, actor)
    const artifact = runs[0]!.artifacts.find((a) => a.resourceId === created.id)!
    await releaseArtifact(db, actor, run.id, artifact.id)

    const released = await db.select().from(agents).where(eq(agents.id, created.id)).get()
    expect(released?.example).toBe(false)
    // …and it is out of the sweep entirely.
    expect((await collectExamples(db, actor, 'mine')).entries).toEqual([])
  })

  test('provisioning steps aside instead of colliding with a hand-made same-name agent', async () => {
    // The run suffix is visible to its owner, so they can build an agent with
    // exactly the name the workflow track wants. Adopting it would enrol a
    // resource the tour never made; colliding would 409 and wedge the step.
    const actor = await seedUser(db, 'u1')
    const run = await startRun(db, actor, 'workflow')
    const suffix = suffixFromRunId(run.id)
    await createAgent(
      db,
      CreateAgentSchema.parse({ name: `guide-auditor-${suffix}`, outputs: ['mine'] }),
      { ownerUserId: 'u1' },
    )

    const res = await provisionStep(db, actor, run.id, 'workflow.create', { skillFs: skillFs() })
    expect(res.resourceType).toBe('workflow')
    const squatter = await db
      .select()
      .from(agents)
      .where(eq(agents.name, `guide-auditor-${suffix}`))
      .get()
    // The user's own agent is untouched — not marked, not re-owned.
    expect(squatter?.example).toBe(false)
  })

  test('cleanup collects bookkeeping rows whose resource is already gone', async () => {
    const actor = await seedUser(db, 'u1')
    const fs = skillFs()
    const run = await startRun(db, actor, 'agent')
    const made = await provisionStep(db, actor, run.id, 'agent.create', { skillFs: fs })
    await deleteAgent(db, made.resourceName, actor)

    const result = await cleanupExamples(db, actor, 'mine', { skillFs: fs })
    expect(result.complete).toBe(true)
    const rows = await listRuns(db, actor)
    expect(rows[0]?.artifacts).toEqual([])
  })
})
