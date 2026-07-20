import {
  WorkflowDraftValidationReceiptSchema,
  serializeWorkflowDefinitionCandidateV1,
  type WorkflowCandidateHash,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createWorkflow, getWorkflow } from '../src/services/workflow'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'd'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [],
  edges: [],
}

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string }
  bob: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc199-draft-validation-never-used.json',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  async function user(username: string) {
    const created = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: created.id })
    return { id: created.id, token }
  }
  return { db, app, alice: await user('draft-alice'), bob: await user('draft-bob') }
}

async function request(app: Hono, token: string, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

function candidateHash(definition: WorkflowDefinition): WorkflowCandidateHash {
  return createHash('sha256')
    .update(serializeWorkflowDefinitionCandidateV1(definition), 'utf8')
    .digest('hex') as WorkflowCandidateHash
}

describe('RFC-199 T11.4 — POST /api/workflows/:id/validate-draft', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })

  test('returns a candidate/context-bound receipt without mutating the stored workflow', async () => {
    const workflow = await createWorkflow(
      h.db,
      { name: 'draft-safe', description: 'stored', definition: EMPTY_DEFINITION },
      { ownerUserId: h.bob.id },
    )
    const candidate: WorkflowDefinition = {
      ...EMPTY_DEFINITION,
      nodes: [{ id: 'missing', kind: 'agent-single', agentName: 'not-installed' }],
    }
    const before = await getWorkflow(h.db, workflow.id)
    const validatedBefore = Date.now()
    const response = await request(
      h.app,
      h.bob.token,
      `/api/workflows/${workflow.id}/validate-draft`,
      { definition: candidate, claimedCandidateHash: candidateHash(candidate) },
    )

    expect(response.status).toBe(200)
    const receipt = WorkflowDraftValidationReceiptSchema.parse(await response.json())
    expect(receipt.candidateHash).toBe(candidateHash(candidate))
    expect(receipt.validationContextHash).toMatch(/^[0-9a-f]{64}$/)
    expect(receipt.validatedAt).toBeGreaterThanOrEqual(validatedBefore)
    expect(receipt.validatedAt).toBeLessThanOrEqual(Date.now())
    expect(receipt.ok).toBe(false)
    expect(receipt.issues.some((issue) => issue.code === 'agent-not-found')).toBe(true)
    expect(await getWorkflow(h.db, workflow.id)).toEqual(before)
  })

  test('rejects a client-claimed hash mismatch with 422', async () => {
    const workflow = await createWorkflow(
      h.db,
      { name: 'draft-hash', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: h.bob.id },
    )
    const response = await request(
      h.app,
      h.bob.token,
      `/api/workflows/${workflow.id}/validate-draft`,
      { definition: EMPTY_DEFINITION, claimedCandidateHash: '0'.repeat(64) },
    )

    expect(response.status).toBe(422)
    expect(((await response.json()) as { code: string }).code).toBe(
      'workflow-candidate-hash-mismatch',
    )
  })

  test('runs the same stored-to-candidate new-reference ACL gate as save', async () => {
    const createAgent = await request(h.app, h.alice.token, '/api/agents', {
      name: 'private-starter-agent',
      description: '',
      outputs: ['result'],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    expect(createAgent.status).toBe(201)
    const privateAcl = await h.app.request('/api/agents/private-starter-agent/acl', {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${h.alice.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(privateAcl.status).toBe(200)
    const workflow = await createWorkflow(
      h.db,
      { name: 'draft-acl', description: '', definition: EMPTY_DEFINITION },
      { ownerUserId: h.bob.id },
    )
    const candidate: WorkflowDefinition = {
      ...EMPTY_DEFINITION,
      nodes: [
        {
          id: 'private',
          kind: 'agent-single',
          agentName: 'private-starter-agent',
        },
      ],
    }
    const response = await request(
      h.app,
      h.bob.token,
      `/api/workflows/${workflow.id}/validate-draft`,
      { definition: candidate, claimedCandidateHash: candidateHash(candidate) },
    )

    expect(response.status).toBe(422)
    const payload = (await response.json()) as {
      code: string
      details?: { missing?: Array<{ type: string; name: string }> }
    }
    expect(payload.code).toBe('acl-missing-refs')
    expect(payload.details?.missing).toEqual([{ type: 'agent', name: 'private-starter-agent' }])
  })
})
