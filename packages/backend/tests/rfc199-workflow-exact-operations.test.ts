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
              nodes: [
                {
                  id: 'newer-node',
                  kind: 'agent-single',
                  agentId: 'missing-agent-id',
                  agentName: 'missing-agent',
                },
              ],
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

// RFC-271 C1 显式改判：`GET /api/workflows/:id/export` 已下线，本组针对它的
// exact-revision 断言随之退场。**契约本身没有作废**——「只加载一次可见详情、
// 守卫通过之后才序列化、漂移返回 workflow-version-mismatch」这几条搬到了配置包
// 导出（AC-12 仅根），见 `rfc271-export-package.test.ts` 与 `rfc271-export-gates.test.ts`。
describe('RFC-199 route source lock', () => {
  test('Validate loads one visible detail and consumes that captured object（Export 半边随 C1 退场）', () => {
    const source = readFileSync(ROUTE_SOURCE, 'utf8')
    // RFC-247 T3 moved these routes from `app.<verb>('/path', …)` to
    // `registerRoute(app, { …, path: '/path', … }, …)`, so the block boundaries
    // are now the path literal inside the declaration. Anchoring on the path
    // (rather than on the registration form) keeps this lock working across
    // both shapes — the property it guards is about the HANDLER body, and that
    // property did not change.
    const at = (path: string): number => source.indexOf(`path: '${path}'`)
    const validateBlock = source.slice(
      at('/api/workflows/:id/validate'),
      at('/api/workflows/:id/validate-draft'),
    )

    expect(validateBlock.match(/loadVisibleWorkflow\(/g)).toHaveLength(1)
    expect(validateBlock).toContain('module.validationQueries.validateStored(')
    expect(validateBlock).not.toMatch(/\bvalidateWorkflowById\s*\(/)
  })
})
