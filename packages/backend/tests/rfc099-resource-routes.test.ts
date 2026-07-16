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

async function loadWorkflow(app: Hono, token: string, id: string): Promise<WorkflowDetail> {
  const res = await req(app, token, `/api/workflows/${id}`)
  expect(res.status).toBe(200)
  return (await res.json()) as WorkflowDetail
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

  async function createAgentAsAlice(): Promise<void> {
    const res = await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(AGENT_BODY),
    })
    expect(res.status).toBe(201)
  }

  async function setPrivate(): Promise<void> {
    const res = await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    expect(res.status).toBe(200)
  }

  // D18/D20 asymmetric defaults: the five ACL'd resource types default
  // PUBLIC (this test); tasks default PRIVATE with no visibility switch
  // (locked in tasks-visibility.test.ts). 2026-06-12 user adjustment.
  test('user creates agent → becomes owner, default public, everyone sees it', async () => {
    await createAgentAsAlice()
    const detail = await req(h.app, h.bob.token, '/api/agents/secret-agent')
    expect(detail.status).toBe(200)
    const body = (await detail.json()) as { ownerUserId: string; visibility: string }
    expect(body.ownerUserId).toBe(h.alice.id)
    expect(body.visibility).toBe('public')
  })

  test('private agent: stranger list-excluded + detail 404 byte-identical to missing', async () => {
    await createAgentAsAlice()
    await setPrivate()
    const list = (await (await req(h.app, h.carol.token, '/api/agents')).json()) as Array<{
      name: string
    }>
    expect(list.some((a) => a.name === 'secret-agent')).toBe(false)
    const invisible = await req(h.app, h.carol.token, '/api/agents/secret-agent')
    const missing = await req(h.app, h.carol.token, '/api/agents/does-not-exist-at-all')
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    const a = (await invisible.json()) as { code: string }
    const b = (await missing.json()) as { code: string }
    expect(a.code).toBe(b.code) // D1: existence does not leak via the error code
    // owner + admin still see it
    expect((await req(h.app, h.alice.token, '/api/agents/secret-agent')).status).toBe(200)
    expect((await req(h.app, h.admin.token, '/api/agents/secret-agent')).status).toBe(200)
  })

  test('grant via ACL PUT → grantee can view but not modify; owner + admin can modify', async () => {
    await createAgentAsAlice()
    await setPrivate()
    const put = await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ userIds: [h.bob.id] }),
    })
    expect(put.status).toBe(200)
    expect((await req(h.app, h.bob.token, '/api/agents/secret-agent')).status).toBe(200)
    // grantee modify → 403 (visible, so a 403 leaks nothing new)
    const bobPatch = await req(h.app, h.bob.token, '/api/agents/secret-agent', {
      method: 'PUT',
      body: JSON.stringify({ description: 'bob was here' }),
    })
    expect(bobPatch.status).toBe(403)
    // stranger modify → 404 (must look like it doesn't exist)
    const carolPatch = await req(h.app, h.carol.token, '/api/agents/secret-agent', {
      method: 'PUT',
      body: JSON.stringify({ description: 'carol was here' }),
    })
    expect(carolPatch.status).toBe(404)
    const ownerPatch = await req(h.app, h.alice.token, '/api/agents/secret-agent', {
      method: 'PUT',
      body: JSON.stringify({ description: 'owner edit' }),
    })
    expect(ownerPatch.status).toBe(200)
    const adminPatch = await req(h.app, h.admin.token, '/api/agents/secret-agent', {
      method: 'PUT',
      body: JSON.stringify({ description: 'admin edit' }),
    })
    expect(adminPatch.status).toBe(200)
  })

  test('GET acl: member list visible read-only to grantee; canManage only for owner/admin', async () => {
    await createAgentAsAlice()
    await setPrivate()
    await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ userIds: [h.bob.id] }),
    })
    const asBob = (await (
      await req(h.app, h.bob.token, '/api/agents/secret-agent/acl')
    ).json()) as {
      ownerUserId: string
      users: Array<{ id: string }>
      canManage: boolean
    }
    expect(asBob.ownerUserId).toBe(h.alice.id)
    expect(asBob.users.map((u) => u.id)).toEqual([h.bob.id])
    expect(asBob.canManage).toBe(false)
    // grantee cannot PUT the acl
    const bobPut = await req(h.app, h.bob.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'public' }),
    })
    expect(bobPut.status).toBe(403)
    // stranger gets the same 404 as a missing resource
    expect((await req(h.app, h.carol.token, '/api/agents/secret-agent/acl')).status).toBe(404)
  })

  test('owner transfer keeps the previous owner in the grant list', async () => {
    await createAgentAsAlice()
    await setPrivate()
    const put = await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ ownerUserId: h.bob.id }),
    })
    expect(put.status).toBe(200)
    const acl = (await put.json()) as {
      ownerUserId: string
      users: Array<{ id: string }>
    }
    expect(acl.ownerUserId).toBe(h.bob.id)
    expect(acl.users.map((u) => u.id)).toContain(h.alice.id)
    // alice (now a grantee) still sees it but can no longer manage
    expect((await req(h.app, h.alice.token, '/api/agents/secret-agent')).status).toBe(200)
    const alicePut = await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'public' }),
    })
    expect(alicePut.status).toBe(403)
    // bob (new owner) can modify the agent itself
    const bobPatch = await req(h.app, h.bob.token, '/api/agents/secret-agent', {
      method: 'PUT',
      body: JSON.stringify({ description: 'new owner edit' }),
    })
    expect(bobPatch.status).toBe(200)
  })

  test('granting an unknown or system user → 422 acl-user-invalid', async () => {
    await createAgentAsAlice()
    const res = await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ userIds: ['01HFAKEUSERID0000000000000'] }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('acl-user-invalid')
    const sys = await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ userIds: ['__system__'] }),
    })
    expect(sys.status).toBe(422)
  })
})

describe('RFC-099 — D15 new-reference usability gate', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
    // alice owns a PRIVATE agent.
    await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(AGENT_BODY),
    })
    await req(h.app, h.alice.token, '/api/agents/secret-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
  })

  function wfBody(agentName: string | null): Record<string, unknown> {
    return {
      name: 'flow',
      description: '',
      definition: {
        $schema_version: 4,
        inputs: [],
        nodes: agentName === null ? [] : [{ id: 'n1', kind: 'agent-single', agentName }],
        edges: [],
      },
    }
  }

  test('creating a workflow that references an invisible agent → 422 acl-missing-refs', async () => {
    const res = await req(h.app, h.bob.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify(wfBody('secret-agent')),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      code: string
      details?: { missing?: Array<{ type: string; name: string }> }
    }
    expect(body.code).toBe('acl-missing-refs')
    expect(body.details?.missing).toEqual([{ type: 'agent', name: 'secret-agent' }])
  })

  test('owner can reference their own private agent; admin can reference anything', async () => {
    expect(
      (
        await req(h.app, h.alice.token, '/api/workflows', {
          method: 'POST',
          body: JSON.stringify(wfBody('secret-agent')),
        })
      ).status,
    ).toBe(201)
    expect(
      (
        await req(h.app, h.admin.token, '/api/workflows', {
          method: 'POST',
          body: JSON.stringify(wfBody('secret-agent')),
        })
      ).status,
    ).toBe(201)
  })

  test('unresolvable agent names still save (existence stays the validator’s job)', async () => {
    const res = await req(h.app, h.bob.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify(wfBody('never-heard-of-it')),
    })
    expect(res.status).toBe(201)
  })

  test('grandfathered reference survives an unrelated PUT; adding a NEW invisible ref is rejected', async () => {
    // alice creates a workflow referencing her private agent, then transfers
    // the WORKFLOW (not the agent) to bob — bob now owns a workflow with a
    // reference he could not add himself.
    const created = await req(h.app, h.alice.token, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify(wfBody('secret-agent')),
    })
    const wf = (await created.json()) as WorkflowDetail
    await req(h.app, h.alice.token, `/api/workflows/${wf.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({ ownerUserId: h.bob.id }),
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
        { id: 'n2', kind: 'agent-single', agentName: 'secret-agent' },
      ],
    }
    expect(
      (await saveWorkflowDefinition(h.app, h.bob.token, wf.id, def2 as WorkflowDefinition)).status,
    ).toBe(200)
    // …but referencing a DIFFERENT private agent he cannot see is rejected.
    await req(h.app, h.alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ ...AGENT_BODY, name: 'second-secret' }),
    })
    await req(h.app, h.alice.token, '/api/agents/second-secret/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    const def3 = {
      ...wf.definition,
      nodes: [
        ...(wf.definition.nodes as unknown[]),
        { id: 'n3', kind: 'agent-single', agentName: 'second-secret' },
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
      body: JSON.stringify({ ...AGENT_BODY, name: 'wrapper', dependsOn: ['secret-agent'] }),
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
      body: JSON.stringify({ visibility: 'private' }),
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
