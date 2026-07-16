// RFC-199 B3 regression locks for exact persisted-revision consumers.
//
// Why this file exists: a version/hash check followed by a second workflow
// lookup is still a TOCTOU bug. These route-level tests insert a real writer
// after the guard and require Validate/Export to consume the immutable detail
// captured before that writer committed.

import {
  WorkflowValidationReceiptSchema,
  type WorkflowDefinition,
  type WorkflowDetail,
} from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp, type AppDeps } from '../src/server'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowDraftSnapshotOf,
} from '../src/services/workflow'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const ROUTE_SOURCE = resolve(import.meta.dir, '..', 'src', 'routes', 'workflows.ts')
const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}
const SYSTEM = { kind: 'system', reason: 'rfc199-exact-operation-test' } as const

function buildHarness(
  hook?: AppDeps['workflowExactOperationHook'],
  existingDb?: DbClient,
): {
  db: DbClient
  app: ReturnType<typeof createApp>
} {
  const db = existingDb ?? createInMemoryDb(MIGRATIONS)
  return {
    db,
    app: createApp({
      token: TOKEN,
      configPath: '/tmp/aw-rfc199-exact-never-used.json',
      opencodeVersion: '1.15.0',
      dbVersion: 1,
      db,
      workflowExactOperationHook: hook,
    }),
  }
}

async function seed(db: DbClient, name: string): Promise<WorkflowDetail> {
  return createWorkflow(db, {
    name,
    description: 'captured-description',
    definition: EMPTY_DEFINITION,
  })
}

async function api(
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${TOKEN}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function exactBody(workflow: WorkflowDetail) {
  return {
    expectedVersion: workflow.version,
    expectedSnapshotHash: workflow.snapshotHash,
  }
}

function exactExportPath(workflow: WorkflowDetail): string {
  const query = new URLSearchParams({
    expectedVersion: String(workflow.version),
    expectedSnapshotHash: workflow.snapshotHash,
  })
  return `/api/workflows/${workflow.id}/export?${query}`
}

describe('RFC-199 exact workflow Validate', () => {
  test('returns a schema-valid receipt bound to the captured revision and live context', async () => {
    const { db, app } = buildHarness()
    const workflow = await seed(db, 'exact-validate')
    const before = Date.now()
    const response = await api(app, `/api/workflows/${workflow.id}/validate`, {
      method: 'POST',
      body: JSON.stringify(exactBody(workflow)),
    })
    const after = Date.now()

    expect(response.status).toBe(200)
    const receipt = WorkflowValidationReceiptSchema.parse(await response.json())
    expect(receipt.revision).toEqual({
      workflowId: workflow.id,
      version: workflow.version,
      snapshotHash: workflow.snapshotHash,
      updatedAt: workflow.updatedAt,
    })
    expect(receipt.validationContextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.validatedAt).toBeGreaterThanOrEqual(before)
    expect(receipt.validatedAt).toBeLessThanOrEqual(after)
    expect(receipt).toMatchObject({ ok: true, issues: [] })
  })

  test('rejects missing/malformed fences and reports version or hash drift as validation stale', async () => {
    const { db, app } = buildHarness()
    const workflow = await seed(db, 'validate-stale')

    const missing = await api(app, `/api/workflows/${workflow.id}/validate`, {
      method: 'POST',
      body: '{}',
    })
    expect(missing.status).toBe(422)
    expect(((await missing.json()) as { code: string }).code).toBe('workflow-validation-invalid')

    for (const body of [
      { ...exactBody(workflow), unexpected: true },
      { ...exactBody(workflow), expectedSnapshotHash: 'A'.repeat(64) },
      { ...exactBody(workflow), expectedVersion: workflow.version + 0.5 },
    ]) {
      const malformed = await api(app, `/api/workflows/${workflow.id}/validate`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(malformed.status).toBe(422)
      expect(((await malformed.json()) as { code: string }).code).toBe(
        'workflow-validation-invalid',
      )
    }

    for (const body of [
      { ...exactBody(workflow), expectedVersion: workflow.version + 1 },
      { ...exactBody(workflow), expectedSnapshotHash: '0'.repeat(64) },
    ]) {
      const stale = await api(app, `/api/workflows/${workflow.id}/validate`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      expect(stale.status).toBe(409)
      const payload = (await stale.json()) as {
        code: string
        details?: { current?: { version: number; snapshotHash: string } }
      }
      expect(payload.code).toBe('workflow-validation-stale')
      expect(payload.details?.current).toMatchObject({
        version: workflow.version,
        snapshotHash: workflow.snapshotHash,
      })
    }
  })

  test('writer after guard cannot switch validation to the newer definition', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db, 'validate-captured')
    let hookCalls = 0
    const { app } = buildHarness(async ({ operation, revision }) => {
      if (operation !== 'validate') return
      hookCalls += 1
      expect(revision).toMatchObject({
        workflowId: workflow.id,
        version: workflow.version,
        snapshotHash: workflow.snapshotHash,
      })
      await updateWorkflow(
        db,
        workflow.id,
        {
          expectedVersion: workflow.version,
          clientMutationId: ulid(),
          snapshot: {
            ...workflowDraftSnapshotOf(workflow),
            definition: {
              ...EMPTY_DEFINITION,
              nodes: [{ id: 'newer-node', kind: 'agent-single', agentName: 'missing-agent' }],
            },
          },
        },
        SYSTEM,
      )
    }, db)

    const response = await api(app, `/api/workflows/${workflow.id}/validate`, {
      method: 'POST',
      body: JSON.stringify(exactBody(workflow)),
    })
    expect(response.status).toBe(200)
    const receipt = WorkflowValidationReceiptSchema.parse(await response.json())
    expect(hookCalls).toBe(1)
    expect(receipt).toMatchObject({
      revision: { version: 1, snapshotHash: workflow.snapshotHash },
      ok: true,
      issues: [],
    })
    const current = await getWorkflow(db, workflow.id)
    expect(current?.version).toBe(2)
    expect(current?.snapshotHash).not.toBe(workflow.snapshotHash)
  })

  test('delete after guard still validates the captured revision without a latest-row reread', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db, 'validate-delete-captured')
    const { app } = buildHarness(async ({ operation }) => {
      if (operation !== 'validate') return
      await deleteWorkflow(
        db,
        workflow.id,
        { expectedVersion: workflow.version, clientMutationId: ulid() },
        SYSTEM,
      )
    }, db)

    const response = await api(app, `/api/workflows/${workflow.id}/validate`, {
      method: 'POST',
      body: JSON.stringify(exactBody(workflow)),
    })
    expect(response.status).toBe(200)
    expect(WorkflowValidationReceiptSchema.parse(await response.json())).toMatchObject({
      revision: {
        workflowId: workflow.id,
        version: workflow.version,
        snapshotHash: workflow.snapshotHash,
      },
      ok: true,
      issues: [],
    })
    expect(await getWorkflow(db, workflow.id)).toBeNull()
  })
})

describe('RFC-199 exact workflow Export', () => {
  test('requires both exact query members and returns workflow-version-mismatch on drift', async () => {
    const { db, app } = buildHarness()
    const workflow = await seed(db, 'exact-export')

    const missing = await api(app, `/api/workflows/${workflow.id}/export`)
    expect(missing.status).toBe(422)
    expect(((await missing.json()) as { code: string }).code).toBe('workflow-export-invalid')

    const malformed = await api(
      app,
      `/api/workflows/${workflow.id}/export?expectedVersion=1.5&expectedSnapshotHash=${workflow.snapshotHash}`,
    )
    expect(malformed.status).toBe(422)

    const extra = await api(app, `${exactExportPath(workflow)}&unexpected=ignored-before-rfc199`)
    expect(extra.status).toBe(422)

    const duplicate = await api(
      app,
      `${exactExportPath(workflow)}&expectedVersion=${workflow.version}`,
    )
    expect(duplicate.status).toBe(422)

    const duplicateHash = await api(
      app,
      `${exactExportPath(workflow)}&expectedSnapshotHash=${workflow.snapshotHash}`,
    )
    expect(duplicateHash.status).toBe(422)

    const overflowVersion = await api(
      app,
      `/api/workflows/${workflow.id}/export?expectedVersion=9007199254740992&expectedSnapshotHash=${workflow.snapshotHash}`,
    )
    expect(overflowVersion.status).toBe(422)

    for (const query of [
      new URLSearchParams({
        expectedVersion: String(workflow.version + 1),
        expectedSnapshotHash: workflow.snapshotHash,
      }),
      new URLSearchParams({
        expectedVersion: String(workflow.version),
        expectedSnapshotHash: '0'.repeat(64),
      }),
    ]) {
      const stale = await api(app, `/api/workflows/${workflow.id}/export?${query}`)
      expect(stale.status).toBe(409)
      expect(((await stale.json()) as { code: string }).code).toBe('workflow-version-mismatch')
    }
  })

  test('writer after guard cannot switch YAML serialization to the newer snapshot', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db, 'export-captured')
    let hookCalls = 0
    const { app } = buildHarness(async ({ operation, revision }) => {
      if (operation !== 'export') return
      hookCalls += 1
      expect(revision.snapshotHash).toBe(workflow.snapshotHash)
      await updateWorkflow(
        db,
        workflow.id,
        {
          expectedVersion: workflow.version,
          clientMutationId: ulid(),
          snapshot: {
            ...workflowDraftSnapshotOf(workflow),
            description: 'newer-description',
          },
        },
        SYSTEM,
      )
    }, db)

    const response = await api(app, exactExportPath(workflow))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/yaml')
    const yaml = await response.text()
    expect(hookCalls).toBe(1)
    expect(yaml).toContain('captured-description')
    expect(yaml).not.toContain('newer-description')
    const current = await getWorkflow(db, workflow.id)
    expect(current).toMatchObject({ version: 2, description: 'newer-description' })
  })

  test('delete after guard still serializes the captured revision without a latest-row reread', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const workflow = await seed(db, 'export-delete-captured')
    const { app } = buildHarness(async ({ operation }) => {
      if (operation !== 'export') return
      await deleteWorkflow(
        db,
        workflow.id,
        { expectedVersion: workflow.version, clientMutationId: ulid() },
        SYSTEM,
      )
    }, db)

    const response = await api(app, exactExportPath(workflow))
    expect(response.status).toBe(200)
    const yaml = await response.text()
    expect(yaml).toContain('captured-description')
    expect(await getWorkflow(db, workflow.id)).toBeNull()
  })
})

describe('RFC-199 route source lock', () => {
  test('Validate and Export each load one visible detail and consume that captured object', () => {
    const source = readFileSync(ROUTE_SOURCE, 'utf8')
    const validateBlock = source.slice(
      source.indexOf("app.post('/api/workflows/:id/validate'"),
      source.indexOf('// P-4-08: YAML export / import.'),
    )
    const exportBlock = source.slice(
      source.indexOf("app.get('/api/workflows/:id/export'"),
      source.indexOf("app.post('/api/workflows/import'"),
    )

    expect(validateBlock.match(/loadVisibleWorkflow\(/g)).toHaveLength(1)
    expect(validateBlock).toContain('validateWorkflowDefinition(workflow.definition, context)')
    expect(validateBlock).not.toMatch(/\bvalidateWorkflowById\s*\(/)
    expect(exportBlock.match(/loadVisibleWorkflow\(/g)).toHaveLength(1)
    expect(exportBlock).toContain('stringifyWorkflowYaml(workflow)')
    expect(exportBlock).not.toContain('getWorkflow(')
  })
})
