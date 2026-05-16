// Service + HTTP coverage for Agents CRUD (P-1-08).
// In-memory SQLite via createInMemoryDb — no daemon spawn needed.

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
    readonly: false,
    syncOutputsOnIterate: true,
    model: 'anthropic/claude-opus-4-7',
    permission: { edit: 'deny' },
    skills: ['s1'],
    dependsOn: [],
    bodyMd: '# hello',
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
      readonly: true,
      syncOutputsOnIterate: true,
      model: 'anthropic/claude-opus-4-7',
      permission: { edit: 'deny', bash: 'deny' },
      skills: ['go-conventions'],
      dependsOn: [],
      frontmatterExtra: { custom: 'value' },
      bodyMd: '# System prompt\nDo the thing.',
    })
    expect(created.id).toBeTruthy()
    expect(created.outputs).toEqual(['findings', 'summary'])
    expect(created.readonly).toBe(true)
    expect(created.permission).toEqual({ edit: 'deny', bash: 'deny' })
    expect(created.skills).toEqual(['go-conventions'])
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
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await expect(
      createAgent(db, {
        name: 'a',
        description: '',
        outputs: [],
        readonly: false,
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        frontmatterExtra: {},
        bodyMd: '',
      }),
    ).rejects.toBeInstanceOf(ConflictError)
  })

  test('update partial patch preserves other fields', async () => {
    await createAgent(db, {
      name: 'a',
      description: 'orig',
      outputs: ['x'],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: { edit: 'allow' },
      skills: ['s1'],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: 'body',
    })
    const updated = await updateAgent(db, 'a', { description: 'new desc', readonly: true })
    expect(updated.description).toBe('new desc')
    expect(updated.readonly).toBe(true)
    expect(updated.outputs).toEqual(['x']) // preserved
    expect(updated.permission).toEqual({ edit: 'allow' }) // preserved
    expect(updated.skills).toEqual(['s1']) // preserved
    expect(updated.bodyMd).toBe('body') // preserved
  })

  test('update on missing agent throws NotFoundError', async () => {
    await expect(updateAgent(db, 'missing', { description: 'x' })).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('delete removes; missing throws NotFoundError', async () => {
    await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await deleteAgent(db, 'a')
    expect(await getAgent(db, 'a')).toBeNull()
    await expect(deleteAgent(db, 'a')).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete refuses when a workflow references the agent', async () => {
    await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    // Insert a workflow whose nodes reference agent 'a'.
    await db.insert(workflows).values({
      id: ulid(),
      name: 'wf1',
      definition: JSON.stringify({
        $schema_version: 1,
        nodes: [{ id: 'n1', kind: 'agent-single', agentName: 'a' }],
      }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(deleteAgent(db, 'a')).rejects.toBeInstanceOf(ConflictError)
  })

  test('rename succeeds; renaming to existing name rejected', async () => {
    await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'b',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const renamed = await renameAgent(db, 'a', { newName: 'c' })
    expect(renamed.name).toBe('c')
    expect(await getAgent(db, 'a')).toBeNull()
    expect(await getAgent(db, 'c')).not.toBeNull()
    await expect(renameAgent(db, 'c', { newName: 'b' })).rejects.toBeInstanceOf(ConflictError)
  })

  test('rename refuses when referenced by workflow', async () => {
    await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await db.insert(workflows).values({
      id: ulid(),
      name: 'wf',
      definition: JSON.stringify({ nodes: [{ agentName: 'a' }] }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(renameAgent(db, 'a', { newName: 'b' })).rejects.toBeInstanceOf(ConflictError)
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
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [] as string[],
      dependsOn: [] as string[],
      frontmatterExtra: {},
      bodyMd: '',
    }
    await createAgent(db, { name: 'code-auditor', ...leafSeed })
    await createAgent(db, { name: 'unit-test-runner', ...leafSeed })

    const a = await createAgent(db, {
      name: 'orchestrator',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: ['code-auditor', 'unit-test-runner'],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(a.dependsOn).toEqual(['code-auditor', 'unit-test-runner'])

    const b = await createAgent(db, {
      name: 'lonely',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(b.dependsOn).toEqual([])

    // Dupes deduped while preserving order. Seed referenced leaves first.
    await createAgent(db, { name: 'a', ...leafSeed })
    await createAgent(db, { name: 'b', ...leafSeed })
    await createAgent(db, { name: 'c', ...leafSeed })
    const c = await createAgent(db, {
      name: 'dupes',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: ['a', 'b', 'a', 'c', 'b'],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(c.dependsOn).toEqual(['a', 'b', 'c'])

    // Patch via updateAgent.
    const updated = await updateAgent(db, 'orchestrator', { dependsOn: ['code-auditor'] })
    expect(updated.dependsOn).toEqual(['code-auditor'])

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

  test('GET /api/agents lists; GET /:name 200 / 404', async () => {
    await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a2')) })

    const list = (await (await req(app, '/api/agents')).json()) as Array<{ name: string }>
    expect(list.map((a) => a.name).sort()).toEqual(['a1', 'a2'])

    const got = await req(app, '/api/agents/a1')
    expect(got.status).toBe(200)
    expect(((await got.json()) as { name: string }).name).toBe('a1')

    const miss = await req(app, '/api/agents/nope')
    expect(miss.status).toBe(404)
    const missBody = (await miss.json()) as Record<string, unknown>
    expect(missBody.code).toBe('agent-not-found')
  })

  test('PUT partial update preserves other fields; 404 on missing', async () => {
    await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    const res = await req(app, '/api/agents/a1', {
      method: 'PUT',
      body: JSON.stringify({ description: 'updated', readonly: true }),
    })
    expect(res.status).toBe(200)
    const updated = (await res.json()) as Record<string, unknown>
    expect(updated.description).toBe('updated')
    expect(updated.readonly).toBe(true)
    expect(updated.outputs).toEqual(['out1', 'out2'])

    const miss = await req(app, '/api/agents/nope', {
      method: 'PUT',
      body: JSON.stringify({ description: 'x' }),
    })
    expect(miss.status).toBe(404)
  })

  test('DELETE returns 204 and the agent is gone', async () => {
    await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    const delRes = await req(app, '/api/agents/a1', { method: 'DELETE' })
    expect(delRes.status).toBe(204)
    const after = await req(app, '/api/agents/a1')
    expect(after.status).toBe(404)
  })

  test('POST /:name/rename round-trips', async () => {
    await req(app, '/api/agents', { method: 'POST', body: JSON.stringify(samplePayload('a1')) })
    const res = await req(app, '/api/agents/a1/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'a2' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { name: string }).name).toBe('a2')
    const old = await req(app, '/api/agents/a1')
    expect(old.status).toBe(404)
    const renamed = await req(app, '/api/agents/a2')
    expect(renamed.status).toBe(200)
  })

  test('all /api/agents/* require token', async () => {
    const res = await app.request('/api/agents')
    expect(res.status).toBe(401)
  })
})
