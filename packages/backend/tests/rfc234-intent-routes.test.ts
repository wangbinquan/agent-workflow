// RFC-234 §6 (T7) — intent-session route locks:
//  end-to-end stubbed flow (create → generated draft with server-issued slots
//  → commit → resources land), creator-only 404 shape (stranger AND manager),
//  admin read-only audit, in-flight 409, and the route-boundary error codes
//  `intent-invalid` / `invalid-json` (named here for route-error-code-coverage).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, intentSessions } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import { seedBuiltinRuntimes, updateRuntime } from '../src/services/runtimeRegistry'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '../src/services/systemAgentRun'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let root: string
let app: ReturnType<typeof createApp>
let ownerToken: string
let strangerToken: string
let managerToken: string

const CHANGESET = JSON.stringify({
  $schema_version: 1,
  ops: [
    {
      opId: 'op-1',
      action: 'create',
      resourceType: 'agent',
      tempRef: '$new:auditor',
      payload: {
        name: 'auditor',
        description: 'audits',
        outputs: ['findings'],
        bodyMd: 'You audit.',
      },
    },
  ],
})

function stubRun(
  kind: 'changeset' | 'questions',
): (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult> {
  return async (opts) => {
    const nonce = /nonce="([^"]+)"/.exec(opts.prompt)?.[1] ?? ''
    const body =
      kind === 'changeset'
        ? `<port name="summary">built it</port><port name="changeset">${CHANGESET.replace(
            /&/g,
            '&',
          ).replace(/</g, '<')}</port>`
        : `<port name="summary">need info</port><port name="questions">${JSON.stringify([
            { id: 'q1', question: 'which?', options: ['a', 'b'], multiSelect: false },
          ]).replace(/</g, '<')}</port>`
    return {
      status: 'ok',
      exitCode: 0,
      eventText: `<workflow-output nonce="${nonce}">${body}</workflow-output>`,
      stderrTail: '',
      durationMs: 3,
      scratchDir: '/tmp/x',
      scratchRetained: false,
    }
  }
}

async function req(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('authorization', `Bearer ${token}`)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function pollDetail(token: string, id: string, until: (d: never) => boolean): Promise<never> {
  for (let i = 0; i < 200; i++) {
    const res = await req(token, `/api/intent-sessions/${id}`)
    if (res.status === 200) {
      const detail = (await res.json()) as never
      if (until(detail)) return detail
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('poll timed out')
}

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  await updateRuntime(db, 'opencode', { model: 'openai/gpt-5' })
  root = mkdtempSync(join(tmpdir(), 'rfc234-intent-routes-'))
  process.env.AGENT_WORKFLOW_HOME = root
  app = createApp({
    token: DAEMON_TOKEN,
    configPath: join(root, 'config.json'),
    opencodeVersion: null,
    dbVersion: 1,
    db,
    intentTestDependencies: { runFn: stubRun('changeset') },
  })
  const owner = await createUser(db, {
    username: 'owner',
    displayName: 'Owner',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const stranger = await createUser(db, {
    username: 'stranger',
    displayName: 'Stranger',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const manager = await createUser(db, {
    username: 'mgr',
    displayName: 'Manager',
    role: 'manager',
    password: 'longEnoughPassword',
  })
  ownerToken = (await createSession({ db, userId: owner.id })).token
  strangerToken = (await createSession({ db, userId: stranger.id })).token
  managerToken = (await createSession({ db, userId: manager.id })).token
})
afterEach(() => {
  delete process.env.AGENT_WORKFLOW_HOME
  rmSync(root, { recursive: true, force: true })
})

describe('intent session routes', () => {
  test('stubbed end-to-end: create → draft+slots → commit → resource lands', async () => {
    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: '给我一个审计 agent' }),
    })
    expect(created.status).toBe(201)
    const session = (await created.json()) as { id: string }

    const detail = (await pollDetail(
      ownerToken,
      session.id,
      (d) => (d as { currentDraft: unknown }).currentDraft !== null,
    )) as {
      session: { inFlight: boolean; currentDraftRevision: number }
      turns: Array<{ kind: string }>
      currentDraft: {
        id: string
        revision: number
        draftHash: string
        stale: boolean
        slots: Array<{ kind: string; slotId: string }>
        validation: { errors: string[] }
      }
    }
    expect(detail.session.inFlight).toBe(false)
    expect(detail.turns.map((t) => t.kind)).toEqual(['message', 'changeset'])
    expect(detail.currentDraft.stale).toBe(false)
    expect(detail.currentDraft.validation.errors).toEqual([])
    expect(detail.currentDraft.slots.some((s) => s.slotId === 'name:op-1')).toBe(true)

    const listed = (await (await req(ownerToken, '/api/intent-sessions')).json()) as Array<{
      id: string
      currentDraftRevision: number | null
    }>
    expect(listed.find((item) => item.id === session.id)?.currentDraftRevision).toBe(
      detail.currentDraft.revision,
    )

    const commit = await req(ownerToken, `/api/intent-sessions/${session.id}/commit`, {
      method: 'POST',
      body: JSON.stringify({
        clientMutationId: ulid(),
        draftRevision: detail.currentDraft.revision,
        draftHash: detail.currentDraft.draftHash,
        decisions: [],
      }),
    })
    expect(commit.status).toBe(200)
    const receipt = (await commit.json()) as {
      applied: Array<{ resourceId: string; name: string }>
    }
    expect(receipt.applied.length).toBe(1)
    const settledDetail = (await (
      await req(ownerToken, `/api/intent-sessions/${session.id}`)
    ).json()) as {
      commits: Array<{ draftId: string }>
    }
    expect(settledDetail.commits[0]?.draftId).toBe(detail.currentDraft.id)
    const agentRow = db
      .select()
      .from(agents)
      .where(eq(agents.id, receipt.applied[0]?.resourceId ?? ''))
      .get()
    expect(agentRow?.name).toBe('auditor')
    expect(agentRow?.ownerUserId).not.toBeNull()
  })

  test('creator-only 404 shape: stranger AND manager get not-found; admin reads', async () => {
    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: 'x' }),
    })
    const session = (await created.json()) as { id: string }

    const asStranger = await req(strangerToken, `/api/intent-sessions/${session.id}`)
    expect(asStranger.status).toBe(404)
    const asManager = await req(managerToken, `/api/intent-sessions/${session.id}`)
    expect(asManager.status).toBe(404)
    // daemon token = system admin actor → read-only audit works
    const asAdmin = await req(DAEMON_TOKEN, `/api/intent-sessions/${session.id}`)
    expect(asAdmin.status).toBe(200)
    // …but admin/manager/stranger cannot write into someone else's session
    const strangerMsg = await req(strangerToken, `/api/intent-sessions/${session.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(strangerMsg.status).toBe(404)
    // stranger list does not include the session
    const list = (await (await req(strangerToken, '/api/intent-sessions')).json()) as Array<{
      id: string
    }>
    expect(list.some((s) => s.id === session.id)).toBe(false)
  })

  test('turn Session view reuses owner/admin read scope; user turns are typed 410', async () => {
    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: 'show the execution' }),
    })
    const session = (await created.json()) as { id: string }
    const detail = (await pollDetail(
      ownerToken,
      session.id,
      (d) => (d as { session: { inFlight: boolean } }).session.inFlight === false,
    )) as {
      turns: Array<{
        id: string
        role: 'user' | 'agent'
        execution: { captureState: string } | null
      }>
    }
    const agentTurn = detail.turns.find((turn) => turn.role === 'agent')
    const userTurn = detail.turns.find((turn) => turn.role === 'user')
    expect(agentTurn?.execution?.captureState).toBe('complete')
    expect(userTurn?.execution).toBeNull()

    const path = `/api/intent-sessions/${session.id}/turns/${agentTurn?.id ?? ''}/session`
    expect((await req(ownerToken, path)).status).toBe(200)
    expect((await req(DAEMON_TOKEN, path)).status).toBe(200)
    expect((await req(strangerToken, path)).status).toBe(404)
    expect((await req(managerToken, path)).status).toBe(404)

    const userPath = `/api/intent-sessions/${session.id}/turns/${userTurn?.id ?? ''}/session`
    const userResponse = await req(ownerToken, userPath)
    expect(userResponse.status).toBe(410)
    const body = (await userResponse.json()) as { error?: { code?: string }; code?: string }
    expect(body.error?.code ?? body.code).toBe('intent-turn-session-not-applicable')
  })

  test('in-flight 409 + malformed payloads name their error codes', async () => {
    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: 'x' }),
    })
    const session = (await created.json()) as { id: string }
    await pollDetail(
      ownerToken,
      session.id,
      (d) => (d as { session: { inFlight: boolean } }).session.inFlight === false,
    )

    // Simulate an in-flight turn and assert the structural 409.
    db.update(intentSessions)
      .set({ inFlightTurnId: ulid() })
      .where(eq(intentSessions.id, session.id))
      .run()
    const blocked = await req(ownerToken, `/api/intent-sessions/${session.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ message: 'more' }),
    })
    expect(blocked.status).toBe(409)
    const blockedBody = (await blocked.json()) as { error?: { code?: string }; code?: string }
    expect(blockedBody.error?.code ?? blockedBody.code).toBe('intent-turn-in-flight')

    // Route-boundary error codes (route-error-code-coverage naming):
    const badJson = await req(ownerToken, '/api/intent-sessions', { method: 'POST', body: '{nope' })
    expect(badJson.status).toBe(422)
    const badJsonBody = (await badJson.json()) as { error?: { code?: string }; code?: string }
    expect(badJsonBody.error?.code ?? badJsonBody.code).toBe('invalid-json')

    const badPayload = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ nope: true }),
    })
    expect(badPayload.status).toBe(422)
    const badPayloadBody = (await badPayload.json()) as { error?: { code?: string }; code?: string }
    expect(badPayloadBody.error?.code ?? badPayloadBody.code).toBe('intent-invalid')
  })

  // T13: modify-entry mounts ride the CREATE payload and land BEFORE the
  // auto-fired first turn (a post-create mount would 409 against it and the
  // first generation would run blind to its target). Invisible targets fail
  // the create with the uniform 404 shape.
  test('create with mounts: manifest seeded pre-turn; invisible target 404s', async () => {
    const seeded = await req(ownerToken, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'mount-target',
        description: 'target',
        outputs: ['answer'],
        bodyMd: 'x',
      }),
    })
    expect(seeded.status).toBe(201)
    const target = (await seeded.json()) as { id: string }

    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({
        message: 'adjust the mounted agent',
        mounts: [{ resourceType: 'agent', resourceId: target.id }],
      }),
    })
    expect(created.status).toBe(201)
    const session = (await created.json()) as { id: string }
    const detail = (await pollDetail(
      ownerToken,
      session.id,
      (d) => (d as { session: { inFlight: boolean } }).session.inFlight === false,
    )) as {
      mounts: Array<{ handle: string; resourceType: string; resourceId: string; detail: boolean }>
    }
    // detail:true — the first turn already ran WITH the mount (that is the
    // point of create-time mounting) and its dump promoted the root to a
    // full-detail entry.
    expect(detail.mounts).toEqual([
      { handle: 'res#agent#1', resourceType: 'agent', resourceId: target.id, detail: true },
    ])

    // A stranger-invisible (here: nonexistent) target fails the CREATE.
    const bad = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({
        message: 'x',
        mounts: [{ resourceType: 'agent', resourceId: ulid() }],
      }),
    })
    expect(bad.status).toBe(404)
  })

  // Design-gate P2-2 manager boundary: `?all=1` is an ADMIN audit affordance;
  // a manager gets their own sessions only — no bypass.
  test('manager ?all=1 lists own sessions only; admin sees all', async () => {
    await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: 'owner session' }),
    })
    const asManager = await req(managerToken, '/api/intent-sessions?all=1')
    expect(asManager.status).toBe(200)
    expect(await asManager.json()).toEqual([])
    const asAdmin = await req(DAEMON_TOKEN, '/api/intent-sessions?all=1')
    const adminRows = (await asAdmin.json()) as Array<{ ownerUserId?: string }>
    expect(adminRows.length).toBe(1)
    expect(typeof adminRows[0]?.ownerUserId).toBe('string')
  })

  // Codex impl-gate P2-4 — owner-only mutations keep the 404 shape for EVERY
  // non-owner, including the system admin who may read the session.
  test('retry/cancel keep the 404 shape for admin and manager alike', async () => {
    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: 'x' }),
    })
    const session = (await created.json()) as { id: string }
    await pollDetail(
      ownerToken,
      session.id,
      (d) => (d as { session: { inFlight: boolean } }).session.inFlight === false,
    )
    for (const token of [DAEMON_TOKEN, managerToken, strangerToken]) {
      for (const path of ['retry', 'cancel-turn']) {
        const res = await req(token, `/api/intent-sessions/${session.id}/${path}`, {
          method: 'POST',
        })
        expect(res.status).toBe(404)
        // Route-local code named here for route-error-code-coverage: these two
        // owner-only mutations raise `intent-session-not-found` in the ROUTE
        // (the read already succeeded for the admin), not in the service.
        const body = (await res.json()) as { error?: { code?: string }; code?: string }
        expect(body.error?.code ?? body.code).toBe('intent-session-not-found')
      }
    }
  })

  // AC-11: the resource-side provenance annotation is scoped to session
  // viewers (creator + system admin). Everyone else — and every miss — gets
  // the SAME `[]` shape: no resource-existence oracle, no foreign-activity
  // leak. Locks the real pipeline row (written by commit), not a seeded one.
  test('provenance read: creator/admin see rows, others get uniform empty', async () => {
    const created = await req(ownerToken, '/api/intent-sessions', {
      method: 'POST',
      body: JSON.stringify({ message: 'build an auditor' }),
    })
    const session = (await created.json()) as { id: string }
    const detail = (await pollDetail(
      ownerToken,
      session.id,
      (d) => (d as { currentDraft: unknown }).currentDraft !== null,
    )) as { currentDraft: { revision: number; draftHash: string } }
    const commit = await req(ownerToken, `/api/intent-sessions/${session.id}/commit`, {
      method: 'POST',
      body: JSON.stringify({
        clientMutationId: ulid(),
        draftRevision: detail.currentDraft.revision,
        draftHash: detail.currentDraft.draftHash,
        decisions: [],
      }),
    })
    expect(commit.status).toBe(200)
    const receipt = (await commit.json()) as { applied: Array<{ resourceId: string }> }
    const agentId = receipt.applied[0]?.resourceId ?? ''

    const mine = await req(ownerToken, `/api/intent-provenance/agent/${agentId}`)
    expect(mine.status).toBe(200)
    const mineRows = (await mine.json()) as Array<{ sessionId: string; sessionTitle: string }>
    expect(mineRows.length).toBe(1)
    expect(mineRows[0]?.sessionId).toBe(session.id)

    // Stranger and manager: [] even though the row exists (manager: no bypass).
    for (const token of [strangerToken, managerToken]) {
      const res = await req(token, `/api/intent-provenance/agent/${agentId}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual([])
    }
    // System admin audits.
    const asAdmin = await req(DAEMON_TOKEN, `/api/intent-provenance/agent/${agentId}`)
    expect(((await asAdmin.json()) as unknown[]).length).toBe(1)

    // Unknown id → same empty shape; malformed type → intent-invalid.
    const miss = await req(ownerToken, `/api/intent-provenance/agent/${ulid()}`)
    expect(miss.status).toBe(200)
    expect(await miss.json()).toEqual([])
    const badType = await req(ownerToken, `/api/intent-provenance/nonsense/${agentId}`)
    expect(badType.status).toBe(422)
  })
})
