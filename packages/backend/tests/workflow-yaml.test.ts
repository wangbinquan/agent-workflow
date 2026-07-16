// P-4-08: workflow YAML import / export.

import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { parse as parseYaml } from 'yaml'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createWorkflow, getWorkflow } from '../src/services/workflow'
import { stringifyWorkflowYaml } from '../src/services/workflow.yaml'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  app: ReturnType<typeof createApp>
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-yaml-'))
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: 'tok',
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return {
    db,
    appHome,
    app,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedWorkflow(db: DbClient): Promise<string> {
  // Slug name on purpose: several tests below EXPORT this workflow and feed
  // the YAML back through /import, which enforces the 2026-07-10 unified
  // naming rules (workflow-name-invalid on free-form names).
  const wf = await createWorkflow(db, {
    name: 'audit-pipeline',
    description: 'tests',
    definition: {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'a', kind: 'input', inputKey: 'req' }],
      edges: [],
    },
  })
  return wf.id
}

const HEADERS = { Authorization: 'Bearer tok' }

async function exactExport(h: Harness, id: string): Promise<Response> {
  const workflow = await getWorkflow(h.db, id)
  if (workflow === null) throw new Error(`missing workflow ${id}`)
  const query = new URLSearchParams({
    expectedVersion: String(workflow.version),
    expectedSnapshotHash: workflow.snapshotHash,
  })
  return h.app.fetch(
    new Request(`http://localhost/api/workflows/${id}/export?${query}`, { headers: HEADERS }),
  )
}

describe('GET /api/workflows/:id/export', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('returns YAML with the workflow id, name, definition', async () => {
    const id = await seedWorkflow(h.db)
    const res = await exactExport(h, id)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/yaml')
    const yaml = await res.text()
    const parsed = parseYaml(yaml) as Record<string, unknown>
    expect(parsed.id).toBe(id)
    expect(parsed.name).toBe('audit-pipeline')
    const def = parsed.definition as Record<string, unknown>
    // RFC-005 / RFC-023 / RFC-056: createWorkflow normalizes incoming v1 →
    // latest on write, so the YAML export reflects the latest schema even
    // when the fixture posted v1. Latest tracks WORKFLOW_SCHEMA_VERSION.
    expect(def.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
  })

  test('404 for unknown workflow', async () => {
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/nope/export', { headers: HEADERS }),
    )
    expect(res.status).toBe(404)
  })

  test('pure stringify keeps the exact captured revision after a later DB write', async () => {
    const id = await seedWorkflow(h.db)
    const captured = await getWorkflow(h.db, id)
    expect(captured).not.toBeNull()

    await h.db
      .update(workflows)
      .set({ name: 'later-name', version: 2, updatedAt: Date.now() + 1 })
      .where(eq(workflows.id, id))

    const parsed = parseYaml(stringifyWorkflowYaml(captured!)) as Record<string, unknown>
    expect(parsed.name).toBe('audit-pipeline')
  })
})

describe('POST /api/workflows/import', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('creates a new workflow when no id is provided', async () => {
    const yaml = `name: imported-flow
description: ''
definition:
  $schema_version: 1
  inputs: []
  nodes: []
  edges: []
`
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: yaml, mode: 'fail' }),
      }),
    )
    expect(res.status).toBe(201)
    const result = (await res.json()) as {
      outcome: string
      workflow: { id: string; name: string; snapshotHash: string }
    }
    expect(result.outcome).toBe('created')
    const wf = result.workflow
    expect(wf.name).toBe('imported-flow')
    expect(wf.id).toBeTruthy()
    expect(wf.snapshotHash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('conflict on existing id returns 409 with workflow-import-conflict', async () => {
    const id = await seedWorkflow(h.db)
    // First export, then re-import the same payload.
    const exportRes = await exactExport(h, id)
    const yaml = await exportRes.text()
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: yaml, mode: 'fail' }),
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; details?: Record<string, unknown> }
    expect(body.code).toBe('workflow-import-conflict')
    expect(body.details?.workflowId).toBe(id)
    expect(body.details?.current).toMatchObject({ workflowId: id, version: 1 })
    expect((body.details?.current as { snapshotHash: string }).snapshotHash).toMatch(
      /^[0-9a-f]{64}$/,
    )
  })

  test('structured overwrite updates the exact confirmed workflow revision', async () => {
    const id = await seedWorkflow(h.db)
    const exportRes = await exactExport(h, id)
    const yaml = (await exportRes.text()).replace('audit-pipeline', 'renamed-flow')
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          yamlText: yaml,
          mode: 'overwrite',
          overwrite: { workflowId: id, expectedVersion: 1, clientMutationId: ulid() },
        }),
      }),
    )
    expect(res.status).toBe(200)
    const result = (await res.json()) as {
      outcome: string
      receipt: { snapshot: { name: string }; revision: { workflowId: string; version: number } }
    }
    expect(result.outcome).toBe('overwritten')
    expect(result.receipt.revision.workflowId).toBe(id)
    expect(result.receipt.snapshot.name).toBe('renamed-flow')
    expect(result.receipt.revision.version).toBe(2)
  })

  test('overwrite after preview revision drift returns 409 and does not overwrite', async () => {
    const id = await seedWorkflow(h.db)
    const detailRes = await h.app.fetch(
      new Request(`http://localhost/api/workflows/${id}`, { headers: HEADERS }),
    )
    const detail = (await detailRes.json()) as {
      name: string
      description: string
      definition: Record<string, unknown>
      version: number
    }
    const exportRes = await exactExport(h, id)
    const yaml = (await exportRes.text()).replace('audit-pipeline', 'stale-overwrite')
    const previewConflict = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: yaml, mode: 'fail' }),
      }),
    )
    expect(previewConflict.status).toBe(409)
    const previewBody = (await previewConflict.json()) as {
      details?: { current?: { version: number } }
    }
    const previewVersion = previewBody.details?.current?.version
    expect(previewVersion).toBe(1)

    const concurrent = await h.app.fetch(
      new Request(`http://localhost/api/workflows/${id}`, {
        method: 'PUT',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: previewVersion,
          clientMutationId: ulid(),
          snapshot: {
            name: detail.name,
            description: 'concurrent-writer',
            definition: detail.definition,
          },
        }),
      }),
    )
    expect(concurrent.status).toBe(200)

    const stale = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          yamlText: yaml,
          mode: 'overwrite',
          overwrite: {
            workflowId: id,
            expectedVersion: previewVersion,
            clientMutationId: ulid(),
          },
        }),
      }),
    )
    expect(stale.status).toBe(409)
    const conflict = (await stale.json()) as {
      code: string
      details?: { current?: { version: number } }
    }
    expect(conflict.code).toBe('workflow-version-conflict')
    expect(conflict.details?.current?.version).toBe(2)

    const after = (await (
      await h.app.fetch(new Request(`http://localhost/api/workflows/${id}`, { headers: HEADERS }))
    ).json()) as { name: string; description: string; version: number }
    expect(after).toMatchObject({
      name: 'audit-pipeline',
      description: 'concurrent-writer',
      version: 2,
    })
  })

  test('mode=new inserts a duplicate with a fresh id', async () => {
    const id = await seedWorkflow(h.db)
    const exportRes = await exactExport(h, id)
    const yaml = await exportRes.text()
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: yaml, mode: 'new' }),
      }),
    )
    expect(res.status).toBe(201)
    const result = (await res.json()) as { outcome: string; workflow: { id: string } }
    expect(result.outcome).toBe('created')
    expect(result.workflow.id).not.toBe(id)
  })

  test('bad YAML => 422', async () => {
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: 'name: missing-definition', mode: 'fail' }),
      }),
    )
    expect(res.status).toBe(422)
  })

  // 2026-07-10 naming unification: imports mint a new name → the workgroup
  // slug rules apply flat (explicit 422, no auto-slugging — user decision).
  test('free-form name in YAML => 422 workflow-name-invalid', async () => {
    const yaml = `name: Audit Pipeline
description: ''
definition:
  $schema_version: 1
  inputs: []
  nodes: []
  edges: []
`
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: yaml, mode: 'fail' }),
      }),
    )
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-name-invalid')
  })

  test('rejects legacy raw-YAML/query fallback and incomplete overwrite fences', async () => {
    const raw = await h.app.fetch(
      new Request('http://localhost/api/workflows/import?onConflict=new', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/yaml' },
        body: 'name: legacy-raw',
      }),
    )
    expect(raw.status).toBe(422)
    expect(((await raw.json()) as { code: string }).code).toBe('workflow-import-invalid')

    const incomplete = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ yamlText: 'name: x', mode: 'overwrite' }),
      }),
    )
    expect(incomplete.status).toBe(422)
    expect(((await incomplete.json()) as { code: string }).code).toBe('workflow-import-invalid')
  })

  test('overwrite rejects a YAML id different from the confirmed target', async () => {
    const id = await seedWorkflow(h.db)
    const yaml = `id: ${ulid()}\nname: mismatch-flow\ndescription: ''\ndefinition:\n  $schema_version: 4\n  inputs: []\n  nodes: []\n  edges: []\n`
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({
          yamlText: yaml,
          mode: 'overwrite',
          overwrite: { workflowId: id, expectedVersion: 1, clientMutationId: ulid() },
        }),
      }),
    )
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-import-target-mismatch')
  })
})
