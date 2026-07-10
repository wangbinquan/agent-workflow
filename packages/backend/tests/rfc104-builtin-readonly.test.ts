// RFC-104 — built-in resource read-only lock.
//
// Locks the guarantee that the two framework-seeded DB rows (agent
// `aw-skill-merger`, workflow `aw-skill-fusion`) are read-only: no mutate /
// delete / rename / ACL-change / manual launch / import-overwrite, refused even
// for the strongest actor (the daemon `__system__` ADMIN token — if it's
// blocked, every lesser actor is too, since `assertNotBuiltin` is actor-blind
// and runs BEFORE the owner check). Closes the footgun from the design Q&A:
// changing a built-in's owner/visibility used to un-hide AND unlock it.
//
// The framework-INTERNAL path (fusion → service `startTask`, + seed self-heal)
// is intentionally NOT locked; fusion-engine.test.ts proves it still runs the
// built-ins end to end. Here we pin: the route guards (403 `builtin-readonly`),
// the drift-proof column discriminator, deterministic seed self-heal, and the
// DB-level "≤1 built-in per name" guarantee that de-ambiguates fusionWorkflowId.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, workflows } from '../src/db/schema'
import {
  SKILL_FUSION_WORKFLOW_NAME,
  SKILL_MERGER_AGENT_NAME,
  seedFusionResources,
} from '../src/services/fusion'
import { assertNotBuiltin, isBuiltinRow } from '../src/services/systemResources'
import { createRuntime } from '../src/services/runtimeRegistry'
import { listWorkflows } from '../src/services/workflow'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { ForbiddenError } from '../src/util/errors'

const TOKEN = 'a'.repeat(64) // 64-char hex → the __system__ ADMIN daemon actor
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function api(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

function agentPayload(name: string): Record<string, unknown> {
  return {
    name,
    description: 'sample',
    outputs: ['out1'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    bodyMd: '# hi',
  }
}

async function builtinWorkflowId(db: DbClient): Promise<string> {
  const wf = (await listWorkflows(db)).find(
    (w) => w.name === SKILL_FUSION_WORKFLOW_NAME && w.builtin,
  )
  if (!wf) throw new Error('built-in workflow not seeded')
  return wf.id
}

async function expect403Builtin(res: Response): Promise<void> {
  expect(res.status).toBe(403)
  expect(JSON.stringify(await res.json())).toContain('builtin-readonly')
}

/** Insert a task row whose workflow is the built-in (mirrors task-collab-launch). */
function seedTaskOnWorkflow(db: DbClient, wfId: string): string {
  const id = ulid()
  db.insert(tasks)
    .values({
      id,
      name: 'fixture',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      repoUrl: null,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: null,
      status: 'interrupted',
      inputs: '{}',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: 0,
      finishedAt: 0,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
      ownerUserId: SYSTEM_USER_ID,
    })
    .run()
  return id
}

describe('RFC-104 — route guards refuse mutating a built-in (even as admin)', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('agent PUT / DELETE / rename on the built-in → 403 builtin-readonly', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const base = `/api/agents/${SKILL_MERGER_AGENT_NAME}`

    await expect403Builtin(
      await api(app, base, { method: 'PUT', body: JSON.stringify({ description: 'hijack' }) }),
    )
    await expect403Builtin(await api(app, base, { method: 'DELETE' }))
    await expect403Builtin(
      await api(app, `${base}/rename`, { method: 'POST', body: JSON.stringify({ newName: 'x' }) }),
    )

    // The row survived all three attempts, unmodified.
    const row = db.select().from(agents).where(eq(agents.name, SKILL_MERGER_AGENT_NAME)).all()[0]
    expect(row?.description).toContain('skill-fusion worker')
    expect(row?.builtin).toBe(true)
  })

  // RFC-117: the built-in commit/merger agent (aw-skill-merger) gets a NARROW
  // exemption — a runtime-ONLY patch is allowed (admin) so fusion can be pointed
  // at a runtime profile (the "select a runtime" parity user agents have); any
  // other field, or a mixed patch, is still 403 (RFC-104).
  test('RFC-117: built-in agent accepts a runtime-ONLY patch; mixed/other fields still 403', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    await createRuntime(db, { name: 'oc-haiku', protocol: 'opencode', model: 'haiku' })
    const base = `/api/agents/${SKILL_MERGER_AGENT_NAME}`

    // runtime-only patch lands.
    const ok = await api(app, base, {
      method: 'PUT',
      body: JSON.stringify({ runtime: 'oc-haiku' }),
    })
    expect(ok.status).toBe(200)
    expect(
      db.select().from(agents).where(eq(agents.name, SKILL_MERGER_AGENT_NAME)).all()[0]?.runtime,
    ).toBe('oc-haiku')

    // a mixed patch (runtime + another field) is still rejected — no smuggling.
    await expect403Builtin(
      await api(app, base, {
        method: 'PUT',
        body: JSON.stringify({ runtime: 'oc-haiku', description: 'hijack' }),
      }),
    )
    // built-in description untouched (the mixed patch didn't land).
    expect(
      db.select().from(agents).where(eq(agents.name, SKILL_MERGER_AGENT_NAME)).all()[0]
        ?.description,
    ).toContain('skill-fusion worker')
  })

  test('workflow PUT / DELETE on the built-in → 403 builtin-readonly', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)

    await expect403Builtin(
      await api(app, `/api/workflows/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ description: 'hijack' }),
      }),
    )
    await expect403Builtin(await api(app, `/api/workflows/${id}`, { method: 'DELETE' }))
    expect(db.select().from(workflows).where(eq(workflows.id, id)).all()[0]?.builtin).toBe(true)
  })

  test('ACL PUT (owner/visibility/grants) on built-in agent + workflow → 403 (the footgun)', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)

    await expect403Builtin(
      await api(app, `/api/agents/${SKILL_MERGER_AGENT_NAME}/acl`, {
        method: 'PUT',
        body: JSON.stringify({ visibility: 'private' }),
      }),
    )
    await expect403Builtin(
      await api(app, `/api/workflows/${id}/acl`, {
        method: 'PUT',
        body: JSON.stringify({ ownerUserId: 'someone', visibility: 'private' }),
      }),
    )
    // Owner + visibility unchanged → still hidden + still resolvable as built-in.
    const wf = db.select().from(workflows).where(eq(workflows.id, id)).all()[0]
    expect(wf?.ownerUserId).toBe(SYSTEM_USER_ID)
    expect(wf?.visibility).toBe('public')
  })

  test('POST /api/tasks launching the built-in workflow → 403 builtin-readonly', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)
    const res = await api(app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'manual-launch-attempt',
        workflowId: id,
        repoUrl: 'file:///tmp/whatever',
        ref: 'main',
        inputs: {},
      }),
    })
    await expect403Builtin(res)
  })

  test('YAML import overwrite targeting the built-in workflow → 403 builtin-readonly', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)

    const yaml = await (await api(app, `/api/workflows/${id}/export`)).text()
    expect(yaml.length).toBeGreaterThan(0)
    const res = await api(app, '/api/workflows/import?onConflict=overwrite', {
      method: 'POST',
      headers: { 'content-type': 'application/yaml' },
      body: yaml,
    })
    await expect403Builtin(res)
  })

  test('the guard does NOT over-block normal (non-built-in) resources', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    expect(
      (
        await api(app, '/api/agents', {
          method: 'POST',
          body: JSON.stringify(agentPayload('my-coder')),
        })
      ).status,
    ).toBe(201)
    // A normal agent (builtin=false) edits fine — the lock is built-in-only.
    const put = await api(app, '/api/agents/my-coder', {
      method: 'PUT',
      body: JSON.stringify({ description: 'edited' }),
    })
    expect(put.status).toBe(200)
  })

  test('POST /api/tasks (multipart) launching the built-in workflow → 403 builtin-readonly', async () => {
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)
    const form = new FormData()
    form.append(
      'payload',
      JSON.stringify({
        name: 'mp',
        workflowId: id,
        repoUrl: 'file:///tmp/x',
        ref: 'main',
        inputs: {},
      }),
    )
    await expect403Builtin(await api(app, '/api/tasks', { method: 'POST', body: form }))
  })

  test('resume / retry of a built-in-workflow task → 403 (no manual exec via resume/retry)', async () => {
    // The only built-in-workflow tasks are fusion engine tasks; the engine drives
    // them via the SERVICE (clarify/review → resumeTask, daemon recovery), never
    // these user-facing routes — so blocking the routes is safe.
    const { db, app } = buildApp()
    await seedFusionResources(db)
    const taskId = seedTaskOnWorkflow(db, await builtinWorkflowId(db))
    await expect403Builtin(await api(app, `/api/tasks/${taskId}/resume`, { method: 'POST' }))
    await expect403Builtin(
      await api(app, `/api/tasks/${taskId}/nodes/some-node/retry`, { method: 'POST' }),
    )
  })
})

describe('RFC-104 — assertNotBuiltin / isBuiltinRow are the actor-blind single source', () => {
  test('throws builtin-readonly for builtin=true, no-op otherwise (incl. column-less rows)', () => {
    expect(isBuiltinRow({ builtin: true })).toBe(true)
    expect(isBuiltinRow({ builtin: false })).toBe(false)
    expect(isBuiltinRow({})).toBe(false) // skill/mcp/plugin rows have no column

    expect(() => assertNotBuiltin('agent', { builtin: true })).toThrow(ForbiddenError)
    try {
      assertNotBuiltin('workflow', { builtin: true })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError)
      expect((e as ForbiddenError).code).toBe('builtin-readonly')
    }
    // No-ops — these must not throw (proves skill/mcp/plugin guards are safe).
    expect(() => assertNotBuiltin('skill', {})).not.toThrow()
    expect(() => assertNotBuiltin('workflow', { builtin: false })).not.toThrow()
  })
})

describe('RFC-104 — seed self-heal & the ≤1-built-in-per-name guarantee', () => {
  beforeEach(() => resetBroadcastersForTests())

  test('owner/visibility drift on the built-in workflow is repaired on re-seed', async () => {
    const { db } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)
    // Simulate someone having moved owner + flipped visibility (builtin kept).
    db.update(workflows)
      .set({ ownerUserId: ulid(), visibility: 'private' })
      .where(eq(workflows.id, id))
      .run()

    await seedFusionResources(db)
    const wf = db.select().from(workflows).where(eq(workflows.id, id)).all()[0]
    expect(wf?.ownerUserId).toBe(SYSTEM_USER_ID)
    expect(wf?.visibility).toBe('public')
    expect(wf?.builtin).toBe(true)
  })

  test('built-in flag lost (owner still __system__) is re-adopted on re-seed', async () => {
    const { db } = buildApp()
    await seedFusionResources(db)
    const id = await builtinWorkflowId(db)
    // Migration backfill could miss a row; simulate builtin=0 with owner intact.
    db.update(workflows).set({ builtin: false }).where(eq(workflows.id, id)).run()

    await seedFusionResources(db)
    expect(db.select().from(workflows).where(eq(workflows.id, id)).all()[0]?.builtin).toBe(true)
  })

  test('agent drift with __system__ owner intact (builtin/visibility) is repaired on re-seed', async () => {
    const { db } = buildApp()
    await seedFusionResources(db)
    // builtin flag cleared + visibility flipped, but owner stays __system__ → the
    // row is recognizably the framework's → reclaimed. (A FULL owner-drift to a
    // user is intentionally left untouched — see the no-hijack test below, Codex
    // impl-gate P2: never convert a possibly-user row into a locked built-in.)
    db.update(agents)
      .set({ visibility: 'private', builtin: false })
      .where(eq(agents.name, SKILL_MERGER_AGENT_NAME))
      .run()

    await seedFusionResources(db)
    const row = db.select().from(agents).where(eq(agents.name, SKILL_MERGER_AGENT_NAME)).all()[0]
    expect(row?.builtin).toBe(true)
    expect(row?.ownerUserId).toBe(SYSTEM_USER_ID)
    expect(row?.visibility).toBe('public')
  })

  test('a user same-named workflow (builtin=false) coexists; exactly one built-in remains', async () => {
    const { db } = buildApp()
    await seedFusionResources(db)
    // A user creates/imports their own workflow reusing the reserved name.
    db.insert(workflows)
      .values({
        id: ulid(),
        name: SKILL_FUSION_WORKFLOW_NAME,
        description: 'mine',
        definition: JSON.stringify({
          $schema_version: 4,
          inputs: [],
          nodes: [],
          edges: [],
          outputs: [],
        }),
        ownerUserId: ulid(),
        builtin: false,
      })
      .run()

    const all = (await listWorkflows(db)).filter((w) => w.name === SKILL_FUSION_WORKFLOW_NAME)
    expect(all.length).toBe(2)
    // fusionWorkflowId selects by builtin=true → exactly one match, unambiguous.
    expect(all.filter((w) => w.builtin).length).toBe(1)

    // The partial unique index forbids a SECOND built-in with the same name.
    expect(() =>
      db
        .insert(workflows)
        .values({
          id: ulid(),
          name: SKILL_FUSION_WORKFLOW_NAME,
          description: 'rogue',
          definition: JSON.stringify({
            $schema_version: 4,
            inputs: [],
            nodes: [],
            edges: [],
            outputs: [],
          }),
          ownerUserId: SYSTEM_USER_ID,
          builtin: true,
        })
        .run(),
    ).toThrow()
  })

  test('seed does NOT hijack a user agent squatting the reserved name (Codex impl-gate P2)', async () => {
    const { db } = buildApp()
    // A user grabbed `aw-skill-merger` (builtin=false, user-owned) before the
    // framework's first seed. agents.name is unique, so the seed must leave it
    // alone — never silently convert user data into a locked built-in.
    const uid = ulid()
    db.insert(agents)
      .values({ id: ulid(), name: SKILL_MERGER_AGENT_NAME, ownerUserId: uid, builtin: false })
      .run()

    await seedFusionResources(db)
    const row = db.select().from(agents).where(eq(agents.name, SKILL_MERGER_AGENT_NAME)).all()[0]
    expect(row?.builtin).toBe(false)
    expect(row?.ownerUserId).toBe(uid)
  })
})

describe('RFC-104 — source-level guard anchors (regression: do not delete the guards)', () => {
  test('launch + resume/retry + YAML import + ACL guards are present in source', () => {
    const tasksSrc = readFileSync(resolve(SRC, 'routes', 'tasks.ts'), 'utf-8')
    // RFC-159 T2: the JSON + multipart launch gates were unified into the shared
    // assertWorkflowLaunchable (services/taskLaunchGate.ts) — it holds the built-in
    // guard; both launch paths call it. Guard NOT deleted, just deduped.
    const gateSrc = readFileSync(resolve(SRC, 'services', 'taskLaunchGate.ts'), 'utf-8')
    expect(gateSrc).toContain("assertNotBuiltin('workflow', wf)")
    const launchGateCalls = (tasksSrc.match(/assertWorkflowLaunchable\(/g) ?? []).length
    expect(launchGateCalls).toBeGreaterThanOrEqual(2) // JSON + multipart launch
    expect(tasksSrc).toContain('assertTaskWorkflowNotBuiltin') // resume + retry routes
    const yaml = readFileSync(resolve(SRC, 'services', 'workflow.yaml.ts'), 'utf-8')
    expect(yaml).toContain("assertNotBuiltin('workflow', existing)")
    const acl = readFileSync(resolve(SRC, 'routes', 'resourceAcl.ts'), 'utf-8')
    expect(acl).toContain('assertNotBuiltin(cfg.type, row)')
  })
})
