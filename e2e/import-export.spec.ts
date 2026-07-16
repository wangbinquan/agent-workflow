// RFC-054 W2-7 — import / export real-file round-trip e2e.
//
// LOCKS the YAML import + export contracts at the HTTP boundary, using a
// real committed fixture file (e2e/fixtures/import-files/sample-workflow.yaml).
//
// Why bother with fixture files when the API endpoint is what matters:
//   * A committed YAML fixture pins the EXTERNAL shape of an exportable
//     workflow definition. A future PR that adds a required field or
//     renames `$schema_version` would break user-facing import — this
//     test catches that before users hit it.
//   * Round-trip parity (export-then-reimport equals original) is the
//     contract every config tool implicitly relies on (git diff,
//     copy-paste between environments, copy-paste from docs). If any
//     field is lost or renamed in the export path, the round-trip fails.
//
// RFC-199: import is a structured JSON request. Overwrite is bound to the
// exact revision the user saw; delete is revision-fenced too. Each mode gets
// its own test below so the removed raw-YAML/query fallback cannot return.

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, 'fixtures', 'import-files')
const SAMPLE_YAML = readFileSync(join(FIXTURES_DIR, 'sample-workflow.yaml'), 'utf-8')
let mutationSequence = 0

function nextClientMutationId(): string {
  mutationSequence += 1
  return String(mutationSequence).padStart(26, '0')
}

test.setTimeout(120_000)

test.beforeAll(async () => {
  daemon = await startDaemon()
  // Pre-create the agent the workflow references so import won't fail
  // on missing-agent validation.
  await fetch(`${daemon.baseUrl}/api/agents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'w2-7-sample-agent',
      description: 'sample agent for W2-7 import/export fixture',
      outputs: ['answer'],
      readonly: true,
      bodyMd: '',
    }),
  })
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function importYaml(
  yaml: string,
  mode: 'fail' | 'overwrite' | 'new' = 'fail',
  overwrite?: { workflowId: string; expectedVersion: number; clientMutationId: string },
): Promise<Response> {
  return fetch(`${daemon.baseUrl}/api/workflows/import`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      mode === 'overwrite' ? { yamlText: yaml, mode, overwrite } : { yamlText: yaml, mode },
    ),
  })
}

async function exportYaml(workflow: WorkflowRow): Promise<string> {
  const query = new URLSearchParams({
    expectedVersion: String(workflow.version),
    expectedSnapshotHash: workflow.snapshotHash,
  })
  const res = await fetch(`${daemon.baseUrl}/api/workflows/${workflow.id}/export?${query}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  if (!res.ok) throw new Error(`export: ${res.status}`)
  return res.text()
}

async function deleteWorkflow(id: string): Promise<void> {
  const detail = await fetch(`${daemon.baseUrl}/api/workflows/${id}`, {
    headers: { Authorization: `Bearer ${daemon.token}` },
  })
  if (!detail.ok) throw new Error(`delete preflight: ${detail.status}`)
  const { version } = (await detail.json()) as { version: number }
  const deleted = await fetch(`${daemon.baseUrl}/api/workflows/${id}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: version, clientMutationId: nextClientMutationId() }),
  })
  if (deleted.status !== 204) throw new Error(`delete: ${deleted.status}`)
}

interface WorkflowRow {
  id: string
  name: string
  description: string
  version: number
  snapshotHash: string
  definition: unknown
}

type ImportResult =
  | { outcome: 'created'; workflow: WorkflowRow }
  | {
      outcome: 'overwritten'
      receipt: {
        revision: { workflowId: string; version: number }
        snapshot: { name: string; description: string; definition: unknown }
      }
    }

async function createdWorkflow(res: Response): Promise<WorkflowRow> {
  const result = (await res.json()) as ImportResult
  expect(result.outcome).toBe('created')
  if (result.outcome !== 'created') throw new Error('expected created import result')
  return result.workflow
}

test.describe('RFC-054 W2-7 — YAML import / export', () => {
  test('fixture imports cleanly (HTTP 201) and produces a workflow row', async () => {
    const res = await importYaml(SAMPLE_YAML, 'fail')
    expect(res.status).toBe(201)
    const wf = await createdWorkflow(res)
    expect(wf.name).toBe('rfc054-w2-7-sample')
    expect(wf.id).toBeTruthy()
    expect(wf.definition).toBeTruthy()
    await deleteWorkflow(wf.id)
  })

  test('round-trip: imported YAML, exported, re-imported yields equivalent workflow definition', async () => {
    // 1. Import the fixture.
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    expect(r1.status).toBe(201)
    const wf1 = await createdWorkflow(r1)

    // 2. Export and snapshot the YAML.
    const yamlExported = await exportYaml(wf1)
    expect(yamlExported.length).toBeGreaterThan(0)
    // Sanity — exported YAML mentions the canonical name.
    expect(yamlExported).toContain('rfc054-w2-7-sample')

    // 3. Delete original.
    await deleteWorkflow(wf1.id)

    // 4. Re-import the EXPORTED YAML (not the original fixture) — locks
    //    that export → import is a closed loop. A drift in either
    //    direction (export drops a field / import requires a different
    //    shape) fails here.
    const r2 = await importYaml(yamlExported, 'fail')
    expect(r2.status).toBe(201)
    const wf2 = await createdWorkflow(r2)
    expect(wf2.name).toBe('rfc054-w2-7-sample')

    // 5. The two definitions must be structurally equivalent. We do a
    //    JSON deep-compare ignoring auto-assigned fields (id, internal
    //    timestamps). Drizzle definition is JSON-encoded text so the
    //    server-side store path doesn't matter.
    const def1 = typeof wf1.definition === 'string' ? JSON.parse(wf1.definition) : wf1.definition
    const def2 = typeof wf2.definition === 'string' ? JSON.parse(wf2.definition) : wf2.definition
    expect(def2).toEqual(def1)

    await deleteWorkflow(wf2.id)
  })

  // Conflict-resolution tests use the EXPORTED yaml (which includes the
  // server-assigned id) so mode=fail actually triggers. The base fixture
  // intentionally omits `id` so it can be imported repeatedly without
  // conflict — these tests grab the assigned id post-import and inject
  // it into the second YAML payload.
  test('mode=fail: re-importing with the same id returns the current revision', async () => {
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    expect(r1.status).toBe(201)
    const wf1 = await createdWorkflow(r1)

    // Export yields YAML with the id baked in — that's the artifact a
    // user would actually paste back to migrate between environments.
    const exported = await exportYaml(wf1)
    expect(exported).toContain(`id: ${wf1.id}`)

    const r2 = await importYaml(exported, 'fail')
    expect(r2.status).toBe(409)
    const conflict = (await r2.json()) as {
      code: string
      details?: { workflowId?: string; current?: { workflowId: string; version: number } }
    }
    expect(conflict.code).toBe('workflow-import-conflict')
    expect(conflict.details?.workflowId).toBe(wf1.id)
    expect(conflict.details?.current).toMatchObject({
      workflowId: wf1.id,
      version: wf1.version,
    })

    await deleteWorkflow(wf1.id)
  })

  test('mode=overwrite: existing workflow is updated at the confirmed revision', async () => {
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    expect(r1.status).toBe(201)
    const wf1 = await createdWorkflow(r1)

    const exported = await exportYaml(wf1)
    const mutationId = nextClientMutationId()
    const r2 = await importYaml(exported, 'overwrite', {
      workflowId: wf1.id,
      expectedVersion: wf1.version,
      clientMutationId: mutationId,
    })
    expect(r2.status).toBe(200)
    const result = (await r2.json()) as ImportResult
    expect(result.outcome).toBe('overwritten')
    if (result.outcome !== 'overwritten') throw new Error('expected overwritten import result')

    // Same ID — overwrite preserves identity.
    expect(result.receipt.revision.workflowId).toBe(wf1.id)
    // Exact same YAML is a canonical no-op; the receipt still identifies the
    // confirmed revision without minting a fake successor.
    expect(result.receipt.revision.version).toBe(wf1.version)
    expect(result.receipt.snapshot.definition).toEqual(wf1.definition)

    await deleteWorkflow(wf1.id)
  })

  test('mode=new: re-importing with the same id produces a fresh row (id discarded)', async () => {
    const r1 = await importYaml(SAMPLE_YAML, 'fail')
    expect(r1.status).toBe(201)
    const wf1 = await createdWorkflow(r1)

    const exported = await exportYaml(wf1)
    const r2 = await importYaml(exported, 'new')
    expect(r2.status).toBe(201)
    const wf2 = await createdWorkflow(r2)

    // Different ID — `new` discarded the imported id and minted a new one.
    expect(wf2.id).not.toBe(wf1.id)

    await deleteWorkflow(wf1.id)
    await deleteWorkflow(wf2.id)
  })

  test('empty YAML body is rejected with 4xx', async () => {
    const res = await importYaml('', 'fail')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('malformed YAML is rejected with 4xx (does not crash daemon)', async () => {
    const res = await importYaml('this is: not\n  a: valid\n: workflow', 'fail')
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
