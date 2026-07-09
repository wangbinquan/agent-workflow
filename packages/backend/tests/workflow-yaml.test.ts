import { rimrafDir } from './helpers/cleanup'
// P-4-08: workflow YAML import / export.

import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { parse as parseYaml } from 'yaml'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createWorkflow } from '../src/services/workflow'

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
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedWorkflow(db: DbClient): Promise<string> {
  const wf = await createWorkflow(db, {
    name: 'Audit Pipeline',
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

describe('GET /api/workflows/:id/export', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('returns YAML with the workflow id, name, definition', async () => {
    const id = await seedWorkflow(h.db)
    const res = await h.app.fetch(
      new Request(`http://localhost/api/workflows/${id}/export`, { headers: HEADERS }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/yaml')
    const yaml = await res.text()
    const parsed = parseYaml(yaml) as Record<string, unknown>
    expect(parsed.id).toBe(id)
    expect(parsed.name).toBe('Audit Pipeline')
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
})

describe('POST /api/workflows/import', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('creates a new workflow when no id is provided', async () => {
    const yaml = `name: Imported
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
        headers: { ...HEADERS, 'content-type': 'text/yaml' },
        body: yaml,
      }),
    )
    expect(res.status).toBe(201)
    const wf = (await res.json()) as { id: string; name: string }
    expect(wf.name).toBe('Imported')
    expect(wf.id).toBeTruthy()
  })

  test('conflict on existing id returns 409 with workflow-import-conflict', async () => {
    const id = await seedWorkflow(h.db)
    // First export, then re-import the same payload.
    const exportRes = await h.app.fetch(
      new Request(`http://localhost/api/workflows/${id}/export`, { headers: HEADERS }),
    )
    const yaml = await exportRes.text()
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'text/yaml' },
        body: yaml,
      }),
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string; details?: Record<string, unknown> }
    expect(body.code).toBe('workflow-import-conflict')
    expect(body.details?.workflowId).toBe(id)
  })

  test('?onConflict=overwrite updates the existing workflow', async () => {
    const id = await seedWorkflow(h.db)
    const exportRes = await h.app.fetch(
      new Request(`http://localhost/api/workflows/${id}/export`, { headers: HEADERS }),
    )
    const yaml = (await exportRes.text()).replace('Audit Pipeline', 'Renamed')
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import?onConflict=overwrite', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'text/yaml' },
        body: yaml,
      }),
    )
    expect(res.status).toBe(201)
    const wf = (await res.json()) as { id: string; name: string; version: number }
    expect(wf.id).toBe(id)
    expect(wf.name).toBe('Renamed')
    expect(wf.version).toBe(2)
  })

  test('?onConflict=new inserts a duplicate with a fresh id', async () => {
    const id = await seedWorkflow(h.db)
    const exportRes = await h.app.fetch(
      new Request(`http://localhost/api/workflows/${id}/export`, { headers: HEADERS }),
    )
    const yaml = await exportRes.text()
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import?onConflict=new', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'text/yaml' },
        body: yaml,
      }),
    )
    expect(res.status).toBe(201)
    const wf = (await res.json()) as { id: string }
    expect(wf.id).not.toBe(id)
  })

  test('bad YAML => 422', async () => {
    const res = await h.app.fetch(
      new Request('http://localhost/api/workflows/import', {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'text/yaml' },
        body: 'name: missing-definition',
      }),
    )
    expect(res.status).toBe(422)
  })
})
