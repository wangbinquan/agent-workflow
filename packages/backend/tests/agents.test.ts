// Service + HTTP coverage for Agents CRUD (P-1-08).
// In-memory SQLite via createInMemoryDb — no daemon spawn needed.

import { buildActor } from '../src/auth/actor'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  renameAgent,
  updateAgent,
} from '../src/services/agent'
import { ConflictError, NotFoundError } from '../src/util/errors'
import { createRuntime } from '../src/services/runtimeRegistry'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildHarness(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

function samplePayload(name: string): Record<string, unknown> {
  return {
    name,
    description: 'sample',
    outputs: ['out1', 'out2'],
    syncOutputsOnIterate: true,
    model: 'anthropic/claude-opus-4-7',
    permission: { edit: 'deny' },
    // RFC-223 (PR-1): typed skill refs. No managed skill row named s1 exists →
    // a repo-local (project) skill.
    skills: [{ kind: 'project', name: 's1' }],
    dependsOn: [],
    mcp: [],
    plugins: [],
    bodyMd: '# hello',
  }
}

function servicePayload(name: string): Parameters<typeof createAgent>[1] {
  return {
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
  }
}

describe('agent service', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('list/empty -> []', async () => {
    expect(await listAgents(db)).toEqual([])
  })

  test('create round-trips JSON fields and bodyMd', async () => {
    const created = await createAgent(db, {
      name: 'auditor',
      description: 'audits code',
      outputs: ['findings', 'summary'],
      syncOutputsOnIterate: true,
      permission: { edit: 'deny', bash: 'deny' },
      skills: [{ kind: 'project', name: 'go-conventions' }],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: { custom: 'value' },
      bodyMd: '# System prompt\nDo the thing.',
    })
    expect(created.id).toBeTruthy()
    expect(created.outputs).toEqual(['findings', 'summary'])
    expect(created.permission).toEqual({ edit: 'deny', bash: 'deny' })
    expect(created.skills).toEqual([{ kind: 'project', name: 'go-conventions' }])
    expect(created.frontmatterExtra).toEqual({ custom: 'value' })
    expect(created.bodyMd).toContain('System prompt')

    const fetched = await getAgent(db, 'auditor')
    expect(fetched).toEqual(created)
  })

  test('create rejects duplicate name', async () => {
    await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await expect(
      createAgent(db, {
        name: 'a',
        description: '',
        outputs: [],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: '',
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('RFC-223 scopes create and rename conflicts to the owner bucket', async () => {
    const source = await createAgent(db, servicePayload('source'), { ownerUserId: 'owner-a' })
    await createAgent(db, servicePayload('shared'), { ownerUserId: 'owner-b' })

    const crossOwnerRename = await renameAgent(db, source.id, { newName: 'shared' })
    expect(crossOwnerRename.name).toBe('shared')

    await createAgent(db, servicePayload('taken'), { ownerUserId: 'owner-a' })
    await expect(renameAgent(db, source.id, { newName: 'taken' })).rejects.toMatchObject({
      code: 'agent-name-in-use',
    })
    await expect(
      createAgent(db, servicePayload('taken'), { ownerUserId: 'owner-a' }),
    ).rejects.toMatchObject({ code: 'agent-name-in-use' })

    await expect(
      createAgent(db, servicePayload('shared'), { ownerUserId: 'owner-c' }),
    ).resolves.toMatchObject({ name: 'shared', ownerUserId: 'owner-c' })
    await expect(renameAgent(db, source.id, { newName: 'shared' })).resolves.toMatchObject({
      id: source.id,
      name: 'shared',
    })
  })

  test('RFC-223 maps a same-owner create race to one stable 409 conflict', async () => {
    const results = await Promise.allSettled([
      createAgent(db, servicePayload('raced'), { ownerUserId: 'owner-a' }),
      createAgent(db, servicePayload('raced'), { ownerUserId: 'owner-a' }),
    ])

    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(rejected?.reason).toMatchObject({ code: 'agent-name-in-use', status: 409 })
  })

  test('update partial patch preserves other fields', async () => {
    const created = await createAgent(db, {
      name: 'a',
      description: 'orig',
      outputs: ['x'],
      syncOutputsOnIterate: true,
      permission: { edit: 'allow' },
      skills: [{ kind: 'project', name: 's1' }],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: 'body',
    })
    const updated = await updateAgent(db, created.id, { description: 'new desc' })
    expect(updated.description).toBe('new desc')
    expect(updated.outputs).toEqual(['x']) // preserved
    expect(updated.permission).toEqual({ edit: 'allow' }) // preserved
    expect(updated.skills).toEqual([{ kind: 'project', name: 's1' }]) // preserved
    expect(updated.bodyMd).toBe('body') // preserved
  })

  // RFC-115: updateAgent must WRITE the runtime column — pin, preserve, AND clear.
  // The bug: the set-builder handled model/variant/temperature/steps/maxSteps but
  // skipped runtime, so the edit form (PUT) could neither repoint nor un-pin an
  // agent — invisible because the RFC-113 migration had pinned every user agent.
  test('update writes runtime: pin, preserve on unrelated patch, clear to inherit', async () => {
    // RFC-111/F6: a pinned runtime must resolve to a runtimes row
    // (validateRuntimeReference) — seed the registry row this test pins to.
    await createRuntime(db, { name: 'opencode-1', protocol: 'opencode', binaryPath: null })
    const created = await createAgent(db, {
      name: 'rt',
      description: 'orig',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    // starts unpinned (inherits config.defaultRuntime → absent on the view)
    expect((await getAgent(db, 'rt'))?.runtime).toBeUndefined()
    // pin to a registry name
    expect((await updateAgent(db, created.id, { runtime: 'opencode-1' })).runtime).toBe(
      'opencode-1',
    )
    // an unrelated patch leaves the pin untouched (sparse-patch semantics)
    expect((await updateAgent(db, created.id, { description: 'x' })).runtime).toBe('opencode-1')
    // explicit null clears back to inherit (absent on the Agent view again)
    expect((await updateAgent(db, created.id, { runtime: null })).runtime).toBeUndefined()
  })

  test('update on missing agent throws NotFoundError', async () => {
    await expect(updateAgent(db, 'missing', { description: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('delete removes; missing throws NotFoundError', async () => {
    const created = await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await deleteAgent(db, created.id, T6_ACTOR)
    expect(await getAgent(db, 'a')).toBeNull()
    await expect(deleteAgent(db, created.id, T6_ACTOR)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete refuses when a workflow references the agent', async () => {
    const created = await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    // Insert a workflow whose node references the canonical agent id.
    await db.insert(workflows).values({
      id: ulid(),
      name: 'wf1',
      definition: JSON.stringify({
        $schema_version: 1,
        nodes: [{ id: 'n1', kind: 'agent-single', agentId: created.id, agentName: 'a' }],
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(deleteAgent(db, created.id, T6_ACTOR)).rejects.toBeInstanceOf(ConflictError)
  })

  test('rename succeeds; renaming to existing name rejected', async () => {
    const agentA = await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'b',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const renamed = await renameAgent(db, agentA.id, { newName: 'c' })
    expect(renamed.name).toBe('c')
    expect(await getAgent(db, 'a')).toBeNull()
    expect(await getAgent(db, 'c')).not.toBeNull()
    await expect(renameAgent(db, agentA.id, { newName: 'b' })).rejects.toBeInstanceOf(ConflictError)
  })

  test('rename preserves id-based workflow references', async () => {
    const created = await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await db.insert(workflows).values({
      id: ulid(),
      name: 'wf',
      definition: JSON.stringify({ nodes: [{ agentId: created.id, agentName: 'a' }] }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(renameAgent(db, created.id, { newName: 'b' })).resolves.toMatchObject({
      id: created.id,
      name: 'b',
    })
  })

  // RFC-022 T1: `dependsOn` is a JSON string[] column with default `[]`; CRUD
  // must round-trip the value and tolerate legacy rows that pre-date the
  // migration (depends_on absent or malformed → []). Red here means the
  // column wiring drifted — agent.skills round-trip already covers the JSON
  // path; this case watches the new column specifically.
  test('RFC-022 dependsOn round-trips and defaults to []', async () => {
    // Seed the two referenced agents first so the save-time guard accepts
    // the orchestrator's dependsOn closure (RFC-022 §2.1 #5).
    const leafSeed = {
      description: '',
      outputs: [] as string[],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [] as string[],
      mcp: [] as string[],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    }
    // RFC-223 (PR-1): dependsOn stores agent IDS — capture the seeded ids so the
    // assertions compare against the resolved (name → id) references.
    const codeAuditor = await createAgent(db, { name: 'code-auditor', ...leafSeed })
    const unitTestRunner = await createAgent(db, { name: 'unit-test-runner', ...leafSeed })

    const a = await createAgent(db, {
      name: 'orchestrator',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: ['code-auditor', 'unit-test-runner'],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(a.dependsOn).toEqual([codeAuditor.id, unitTestRunner.id])

    const b = await createAgent(db, {
      name: 'lonely',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(b.dependsOn).toEqual([])

    // Dupes deduped while preserving order. Seed referenced leaves first.
    const agA = await createAgent(db, { name: 'a', ...leafSeed })
    const agB = await createAgent(db, { name: 'b', ...leafSeed })
    const agC = await createAgent(db, { name: 'c', ...leafSeed })
    const c = await createAgent(db, {
      name: 'dupes',
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: ['a', 'b', 'a', 'c', 'b'],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(c.dependsOn).toEqual([agA.id, agB.id, agC.id])

    // Patch via updateAgent.
    const updated = await updateAgent(db, a.id, { dependsOn: ['code-auditor'] })
    expect(updated.dependsOn).toEqual([codeAuditor.id])

    // Legacy row whose depends_on JSON is malformed → exposed as [] (defensive
    // parser). Simulate by raw UPDATE.
    const { sql } = await import('drizzle-orm')
    await db.run(sql`UPDATE agents SET depends_on = '{not-an-array}' WHERE name = 'orchestrator'`)
    const reread = await getAgent(db, 'orchestrator')
    expect(reread?.dependsOn).toEqual([])
  })
})

describe('agent HTTP routes', () => {
  let app: Hono

  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('POST /api/agents creates and returns 201', async () => {
    const res = await req(app, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(samplePayload('a1')),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('a1')
    expect(body.outputs).toEqual(['out1', 'out2'])
    expect(typeof body.id).toBe('string')
  })

  test('POST rejects invalid name with 422 + standard error schema', async () => {
    const res = await req(app, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ ...samplePayload('Bad Name!'), name: 'Bad Name!' }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.code).toBe('agent-invalid')
  })

  test('GET /api/agents lists; GET /:id 200; legacy name URL 404', async () => {
    const createdRes = await req(app, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(samplePayload('a1')),
    })
    const created = (await createdRes.json()) as { id: string; name: string }
    await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a2')) })

    const list = (await (await req(app, '/api/agents')).json()) as Array<{ name: string }>
    expect(list.map((a) => a.name).sort()).toEqual(['a1', 'a2'])

    const got = await req(app, `/api/agents/${created.id}`)
    expect(got.status).toBe(200)
    expect(((await got.json()) as { name: string }).name).toBe('a1')

    const legacy = await req(app, '/api/agents/a1')
    expect(legacy.status).toBe(404)
    const miss = await req(app, '/api/agents/not-an-id')
    expect(miss.status).toBe(404)
    const missBody = (await miss.json()) as Record<string, unknown>
    expect(missBody.code).toBe('agent-not-found')
  })

  test('PUT partial update preserves other fields; 404 on missing', async () => {
    const created = (await (
      await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    ).json()) as { id: string; updatedAt: number; aclRevision?: number }
    const res = await req(app, `/api/agents/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: 'updated',
        expectedUpdatedAt: created.updatedAt,
        expectedAclRevision: created.aclRevision ?? 0,
      }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as Record<string, unknown>
    expect(updated.description).toBe('updated')
    expect(updated.outputs).toEqual(['out1', 'out2'])

    const miss = await req(app, '/api/agents/nope', {
      method: 'PUT',
      body: JSON.stringify({
        description: 'x',
        expectedUpdatedAt: 0,
        expectedAclRevision: 0,
      }),
    })
    expect(miss.status).toBe(404)
  })

  test('DELETE returns 204 and the agent is gone', async () => {
    const created = (await (
      await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    ).json()) as { id: string; updatedAt: number; aclRevision?: number }
    // RFC-222 (D5): DELETE now requires a { confirm } body echoing the name.
    const delRes = await req(app, `/api/agents/${created.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        confirm: 'a1',
        expectedUpdatedAt: created.updatedAt,
        expectedAclRevision: created.aclRevision ?? 0,
      }),
    })
    expect(delRes.status).toBe(204)
    const after = await req(app, `/api/agents/${created.id}`)
    expect(after.status).toBe(404)
  })

  test('DELETE requires the mutation revision fence', async () => {
    const created = (await (
      await req(app, '/api/agents', {
        method: 'POST',
        body: JSON.stringify(samplePayload('delete-without-fence')),
      })
    ).json()) as { id: string }
    const res = await req(app, `/api/agents/${created.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'delete-without-fence' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('agent-delete-invalid')
  })

  test('POST /:id/rename keeps the same detail URL', async () => {
    const created = (await (
      await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    ).json()) as { id: string; updatedAt: number; aclRevision?: number }
    const res = await req(app, `/api/agents/${created.id}/rename`, {
      method: 'POST',
      body: JSON.stringify({
        newName: 'a2',
        expectedUpdatedAt: created.updatedAt,
        expectedAclRevision: created.aclRevision ?? 0,
      }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('a2')
    const oldNameUrl = await req(app, '/api/agents/a1')
    expect(oldNameUrl.status).toBe(404)
    const renamed = await req(app, `/api/agents/${created.id}`)
    expect(renamed.status).toBe(200)
  })

  test('same-name rename still enforces the exact mutation revision', async () => {
    const created = (await (
      await req(app, '/api/agents', {
        method: 'POST',
        body: JSON.stringify(samplePayload('same-name-fence')),
      })
    ).json()) as { id: string; updatedAt: number; aclRevision?: number }
    const changed = await req(app, `/api/agents/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: 'new revision',
        expectedUpdatedAt: created.updatedAt,
        expectedAclRevision: created.aclRevision ?? 0,
      }),
    })
    expect(changed.status).toBe(200)

    const staleNoOp = await req(app, `/api/agents/${created.id}/rename`, {
      method: 'POST',
      body: JSON.stringify({
        newName: 'same-name-fence',
        expectedUpdatedAt: created.updatedAt,
        expectedAclRevision: created.aclRevision ?? 0,
      }),
    })
    expect(staleNoOp.status).toBe(409)
    expect(((await staleNoOp.json()) as { code: string }).code).toBe('resource-operation-stale')
  })

  test('all /api/agents/* require token', async () => {
    const res = await app.request('/api/agents')
    expect(res.status).toBe(401)
  })
})
