// RFC-099 B2 — five-resource route enforcement, end to end over the HTTP
// surface: list filtering, identical-404 for missing vs invisible (D1),
// owner-or-admin writes, creator-becomes-owner (D4/D18), ACL endpoints
// (owner transfer keeps the old owner visible), and the D15 new-reference
// usability gate on agent/workflow saves.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { WorkflowDefinition, WorkflowDetail } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string } // regular user — resource creator
  bob: { id: string; token: string } // regular user — grantee
  carol: { id: string; token: string } // regular user — stranger
  admin: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc099-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  async function mkUser(username: string, role: 'admin' | 'user') {
    const u = await createUser(db, {
      username,
      displayName: username,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return {
    db,
    app,
    alice: await mkUser('alice', 'user'),
    bob: await mkUser('bob', 'user'),
    carol: await mkUser('carol', 'user'),
    admin: await mkUser('root', 'admin'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function aclMutation(
  resourceId: string,
  body: Record<string, unknown>,
  expectedAclRevision = 0,
): Record<string, unknown> {
  return { ...body, expectedResourceId: resourceId, expectedAclRevision }
}

async function loadWorkflow(app: Hono, token: string, id: string): Promise<WorkflowDetail> {
  const res = await req(app, token, `/api/workflows/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()) as WorkflowDetail
}

async function loadAgentRevision(
  app: Hono,
  token: string,
  id: string,
): Promise<{ expectedUpdatedAt: number; expectedAclRevision: number }> {
  const res = await req(app, token, `/api/agents/${id}`)
  expect(res.status).toBe(200)
  const agent = (await res.json()) as { updatedAt: number; aclRevision?: number }
  return {
    expectedUpdatedAt: agent.updatedAt,
    expectedAclRevision: agent.aclRevision ?? 0,
  }
}

async function saveWorkflowDefinition(
  app: Hono,
  token: string,
  id: string,
  definition: WorkflowDefinition,
): Promise<Response> {
  const current = await loadWorkflow(app, token, id)
  return req(app, token, `/api/workflows/${id}`, {
    method: 'PUT',
    body: JSON.stringify({
      expectedVersion: current.version,
      clientMutationId: ulid(),
      snapshot: {
        name: current.name,
        description: current.description,
        definition,
      },
    }),
  })
}

const AGENT_BODY = {
  name: 'secret-agent',
  description: 'private things',
  outputs: ['result'],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'do secret things',
}

describe('RFC-099 — agents route ACL', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  async function createAgentAsAlice(): Promise<string> {
    const res = await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(AGENT_BODY),
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  async function setPrivate(agentId: string): Promise<void> {
    const res = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { visibility: 'private' })),
    })
    expect(res.status).toBe(200)
  }

  // D18/D20 asymmetric defaults: the five ACL'd resource types default
  // PUBLIC (this test); tasks default PRIVATE with no visibility switch
  // (locked in tasks-visibility.test.ts). 2026-06-12 user adjustment.
  test('user creates agent → becomes owner, default public, everyone sees it', async () => {
    const agentId = await createAgentAsAlice()
    const detail = await req(h.app, h.bob.token, `/api/agents/${agentId}`)
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { ownerUserId: string; visibility: string }
    expect(body.ownerUserId).toBe(h.alice.id)
    expect(body.visibility).toBe('public')
  })

  test('private agent: stranger list-excluded + detail 404 byte-identical to missing', async () => {
    const agentId = await createAgentAsAlice()
    await setPrivate(agentId)
    const list = (await (await req(h.app, h.carol.token, '/api/agents')).json()) as Array<{
      name: string
    }>
    expect(list.some((a) => a.name === 'secret-agent')).toBe(false)
    const invisible = await req(h.app, h.carol.token, `/api/agents/${agentId}`)
    const missing = await req(h.app, h.carol.token, '/api/agents/00000000000000000000000000')
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    const a = (await invisible.json()) as { code: string }
    const b = (await missing.json()) as { code: string }
    expect(a.code).toBe(b.code) // D1: existence does not leak via the error code
    // owner + admin still see it
    expect((await req(h.app, h.alice.token, `/api/agents/${agentId}`)).status).toBe(200)
    expect((await req(h.app, h.admin.token, `/api/agents/${agentId}`)).status).toBe(200)
  })

  test('grant via ACL PUT → grantee can view but not modify; owner + admin can modify', async () => {
    const agentId = await createAgentAsAlice()
    await setPrivate(agentId)
    const put = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { userIds: [h.bob.id] }, 1)),
    })
    expect(put.status).toBe(200)
    expect((await req(h.app, h.bob.token, `/api/agents/${agentId}`)).status).toBe(200)
    const revision = await loadAgentRevision(h.app, h.alice.token, agentId)
    // grantee modify → 403 (visible, so a 403 leaks nothing new)
    const bobPatch = await req(h.app, h.bob.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'bob was here', ...revision }),
    })
    expect(bobPatch.status).toBe(403)
    // stranger modify → 404 (must look like it doesn't exist)
    const carolPatch = await req(h.app, h.carol.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'carol was here', ...revision }),
    })
    expect(carolPatch.status).toBe(404)
    const ownerPatch = await req(h.app, h.alice.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'owner edit', ...revision }),
    })
    expect(ownerPatch.status).toBe(200)
    const ownerSaved = (await ownerPatch.json()) as { updatedAt: number; aclRevision?: number }
    const adminPatch = await req(h.app, h.admin.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({
        description: 'admin edit',
        expectedUpdatedAt: ownerSaved.updatedAt,
        expectedAclRevision: ownerSaved.aclRevision ?? 0,
      }),
    })
    expect(adminPatch.status).toBe(200)
  })

  test('GET acl: member list visible read-only to grantee; canManage only for owner/admin', async () => {
    const agentId = await createAgentAsAlice()
    await setPrivate(agentId)
    await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { userIds: [h.bob.id] }, 1)),
    })
    const asBob = (await (await req(h.app, h.bob.token, `/api/agents/${agentId}/acl`)).json()) as {
      ownerUserId: string
      users: Array<{ id: string }>
      canManage: boolean
    }
    expect(asBob.ownerUserId).toBe(h.alice.id)
    expect(asBob.users.map((u) => u.id)).toEqual([h.bob.id])
    expect(asBob.canManage).toBe(false)
    // grantee cannot PUT the acl
    const bobPut = await req(h.app, h.bob.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { visibility: 'public' }, 2)),
    })
    expect(bobPut.status).toBe(403)
    // stranger gets the same 404 as a missing resource
    expect((await req(h.app, h.carol.token, `/api/agents/${agentId}/acl`)).status).toBe(404)
  })

  test('owner transfer keeps the previous owner in the grant list', async () => {
    const agentId = await createAgentAsAlice()
    await setPrivate(agentId)
    const put = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { ownerUserId: h.bob.id }, 1)),
    })
    expect(put.status).toBe(200)
    const acl = (await put.json()) as {
      ownerUserId: string
      users: Array<{ id: string }>
    }
    expect(acl.ownerUserId).toBe(h.bob.id)
    expect(acl.users.map((u) => u.id)).toContain(h.alice.id)
    // alice (now a grantee) still sees it but can no longer manage
    expect((await req(h.app, h.alice.token, `/api/agents/${agentId}`)).status).toBe(200)
    const alicePut = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { visibility: 'public' }, 2)),
    })
    expect(alicePut.status).toBe(403)
    // bob (new owner) can modify the agent itself
    const revision = await loadAgentRevision(h.app, h.bob.token, agentId)
    const bobPatch = await req(h.app, h.bob.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'new owner edit', ...revision }),
    })
    expect(bobPatch.status).toBe(200)
  })

  test('owner transfer invalidates an ordinary mutation fence for admin and former owner', async () => {
    const agentId = await createAgentAsAlice()
    const staleRevision = await loadAgentRevision(h.app, h.alice.token, agentId)
    const transfer = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { ownerUserId: h.bob.id })),
    })
    expect(transfer.status).toBe(200)

    const staleAdminPatch = await req(h.app, h.admin.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'stale admin write', ...staleRevision }),
    })
    expect(staleAdminPatch.status).toBe(409)
    expect(((await staleAdminPatch.json()) as { code: string }).code).toBe(
      'resource-operation-stale',
    )

    const formerOwnerPatch = await req(h.app, h.alice.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'former owner write', ...staleRevision }),
    })
    expect(formerOwnerPatch.status).toBe(403)

    const unchanged = (await (
      await req(h.app, h.admin.token, `/api/agents/${agentId}`)
    ).json()) as { description: string }
    expect(unchanged.description).toBe(AGENT_BODY.description)

    const freshRevision = await loadAgentRevision(h.app, h.admin.token, agentId)
    const freshAdminPatch = await req(h.app, h.admin.token, `/api/agents/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify({ description: 'fresh admin write', ...freshRevision }),
    })
    expect(freshAdminPatch.status).toBe(200)
  })

  test('granting an unknown or system user → 422 acl-user-invalid', async () => {
    const agentId = await createAgentAsAlice()
    const res = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { userIds: ['01HFAKEUSERID0000000000000'] })),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('acl-user-invalid')
    const sys = await req(h.app, h.alice.token, `/api/agents/${agentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(agentId, { userIds: ['__system__'] })),
    })
    expect(sys.status).toBe(422)
  })
})

describe('RFC-099 — D15 new-reference usability gate', () => {
  let h: Harness
  let secretAgentId: string
  beforeEach(async () => {
    h = await buildHarness()
    // alice owns a PRIVATE agent.
    const created = await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(AGENT_BODY),
    })
    secretAgentId = ((await created.json()) as { id: string }).id
    await req(h.app, h.alice.token, `/api/agents/${secretAgentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(secretAgentId, { visibility: 'private' })),
    })
  })

  function wfBody(agentId: string | null, agentName = 'secret-agent'): Record<string, unknown> {
    return {
      name: 'flow',
      description: '',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: agentId === null ? [] : [{ id: 'n1', kind: 'agent-single', agentId, agentName }],
        edges: [],
      },
    }
  }

  test('creating a workflow that references an invisible agent → 422 acl-missing-refs', async () => {
    const res = await req(h.app, h.bob.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify(wfBody(secretAgentId)),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      code: string
      details?: { missing?: Array<{ type: string; name: string }> }
    }
    expect(body.code).toBe('acl-missing-refs')
    expect(body.details?.missing).toEqual([{ type: 'agent', name: secretAgentId }])
  })

  test('owner can reference their own private agent; admin can reference anything', async () => {
    expect(
      (
        await req(h.app, h.alice.token, '/api/workflows', {
          method: 'POST',
          body: JSON.stringify(wfBody(secretAgentId)),
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await req(h.app, h.admin.token, '/api/workflows', {
          method: 'POST',
          body: JSON.stringify(wfBody(secretAgentId)),
        })
      ).status,
    ).toBe(201)
  })

  test('unresolvable agent names still save (existence stays the validator’s job)', async () => {
    const res = await req(h.app, h.bob.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify(wfBody('never-heard-of-it', 'never-heard-of-it')),
    })
    expect(res.status).toBe(201)
  })

  test('grandfathered reference survives an unrelated PUT; adding a NEW invisible ref is rejected', async () => {
    // alice creates a workflow referencing her private agent, then transfers
    // the WORKFLOW (not the agent) to bob — bob now owns a workflow with a
    // reference he could not add himself.
    const created = await req(h.app, h.alice.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify(wfBody(secretAgentId)),
    })
    const wf = (await created.json()) as WorkflowDetail
    await req(h.app, h.alice.token, `/api/workflows/${wf.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(wf.id, { ownerUserId: h.bob.id })),
    })
    // bob saves with the existing reference untouched → allowed (D15).
    const keep = await saveWorkflowDefinition(h.app, h.bob.token, wf.id, wf.definition)
    expect(keep.status).toBe(200)
    // bob adds a SECOND node pointing at the same invisible agent under a new
    // node id — the agent NAME set is unchanged, so still allowed…
    const def2 = {
      ...wf.definition,
      nodes: [
        ...(wf.definition.nodes as unknown[]),
        {
          id: 'n2',
          kind: 'agent-single',
          agentId: secretAgentId,
          agentName: 'secret-agent',
        },
      ],
    }
    expect(
      (await saveWorkflowDefinition(h.app, h.bob.token, wf.id, def2 as WorkflowDefinition)).status,
    ).toBe(200)
    // …but referencing a DIFFERENT private agent he cannot see is rejected.
    const secondAgent = await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ ...AGENT_BODY, name: 'second-secret' }),
    })
    const secondAgentId = ((await secondAgent.json()) as { id: string }).id
    await req(h.app, h.alice.token, `/api/agents/${secondAgentId}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(secondAgentId, { visibility: 'private' })),
    })
    const def3 = {
      ...wf.definition,
      nodes: [
        ...(wf.definition.nodes as unknown[]),
        {
          id: 'n3',
          kind: 'agent-single',
          agentId: secondAgentId,
          agentName: 'second-secret',
        },
      ],
    }
    const rejected = await saveWorkflowDefinition(
      h.app,
      h.bob.token,
      wf.id,
      def3 as WorkflowDefinition,
    )
    expect(rejected.status).toBe(422)
    expect(((await rejected.json()) as { code: string }).code).toBe('acl-missing-refs')
  })

  test('agent create referencing an invisible dependsOn agent → 422', async () => {
    const res = await req(h.app, h.bob.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ ...AGENT_BODY, name: 'wrapper', dependsOn: [secretAgentId] }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('acl-missing-refs')
  })
})

describe('RFC-099 — workflows list filter + private workflow lifecycle', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('private workflow hidden from stranger lists and 404 on detail/validate/export', async () => {
    const created = await req(h.app, h.alice.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'private-flow',
        description: '',
        definition: { $schema_version: 4, inputs: [], nodes: [], edges: [] },
      }),
    })
    const wf = (await created.json()) as WorkflowDetail
    await req(h.app, h.alice.token, `/api/workflows/${wf.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify(aclMutation(wf.id, { visibility: 'private' })),
    })
    const list = (await (await req(h.app, h.carol.token, '/api/workflows')).json()) as Array<{
      id: string
    }>
    expect(list.some((w) => w.id === wf.id)).toBe(false)
    expect((await req(h.app, h.carol.token, `/api/workflows/${wf.id}`)).status).toBe(404)
    expect(
      (
        await req(h.app, h.carol.token, `/api/workflows/${wf.id}/validate`, {
          method: 'POST',
          body: JSON.stringify({
            expectedVersion: wf.version,
            expectedSnapshotHash: wf.snapshotHash,
          }),
        })
      ).status,
    ).toBe(404)
    expect((await req(h.app, h.carol.token, `/api/workflows/${wf.id}/export`)).status).toBe(404)
    const yamlText = JSON.stringify({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      definition: wf.definition,
    })
    const hiddenConflict = await req(h.app, h.carol.token, '/api/workflows/import', {
      method: 'POST',
      body: JSON.stringify({ yamlText, mode: 'fail' }),
    })
    // A hidden collision is indistinguishable from an absent incoming id. Since
    // mode=fail discards a non-colliding YAML id, it creates a fresh Carol-owned
    // row instead of leaking that Alice's private id exists via 404 vs 201.
    expect(hiddenConflict.status).toBe(201)
    const hiddenResult = (await hiddenConflict.json()) as {
      outcome: string
      workflow: WorkflowDetail
    }
    expect(hiddenResult.outcome).toBe('created')
    expect(hiddenResult.workflow.id).not.toBe(wf.id)
    expect(hiddenResult.workflow.ownerUserId).toBe(h.carol.id)
    const hiddenOverwrite = await req(h.app, h.carol.token, '/api/workflows/import', {
      method: 'POST',
      body: JSON.stringify({
        yamlText,
        mode: 'overwrite',
        overwrite: {
          workflowId: wf.id,
          expectedVersion: wf.version,
          clientMutationId: ulid(),
        },
      }),
    })
    expect(hiddenOverwrite.status).toBe(404)
    expect(((await hiddenOverwrite.json()) as { code: string }).code).toBe('workflow-not-found')
    expect(
      (
        await req(h.app, h.carol.token, `/api/workflows/${wf.id}`, {
          method: 'DELETE',
          body: JSON.stringify({ expectedVersion: wf.version, clientMutationId: ulid() }),
        })
      ).status,
    ).toBe(404)
    // owner still fully operational
    expect((await req(h.app, h.alice.token, `/api/workflows/${wf.id}`)).status).toBe(200)
  })
})
