// RFC-164 PR-1 — workgroups resource: service CRUD + zod shape + route ACL.
//
// Locks:
//   - migration 0082 tables round-trip through the service (createInMemoryDb
//     applies the real migration folder, so a broken 0082 fails here first);
//   - leader resolution (displayName → leaderMemberId; lw requires an agent
//     member; free_collab stores null and reads switches as all-on);
//   - members full-replace semantics (ids regenerate; per-group displayName
//     uniqueness — same displayName in two groups is fine);
//   - human members must resolve to active users at save time;
//   - RFC-099: creator-becomes-owner default public, private → list filtered
//     + identical 404 (D1), owner-only writes, D15 new-agent-ref usability
//     gate on create AND update (grandfathered existing refs pass).

import { buildActor } from '../src/auth/actor'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import {
  CreateWorkgroupSchema,
  resolveWorkgroupSwitches,
  workgroupLaunchReadiness,
  type CreateWorkgroup,
  type WorkgroupDetail,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents } from '../src/db/schema'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import {
  createWorkgroup,
  deleteWorkgroup,
  diffNewAgentMemberIds,
  getWorkgroup,
  listWorkgroups,
  renameWorkgroup,
  saveWorkgroup,
  workgroupDraftSnapshotOf,
} from '../src/services/workgroups'
import { ConflictError, NotFoundError, ValidationError } from '../src/util/errors'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)
const agentId = (name: string): string => `agent-${name}`
const AGENT_NAMES = ['planner-agent', 'coder-a', 'a', 'b', 'auditor', 'lead-agent'] as const

function groupInput(overrides: Partial<CreateWorkgroup> = {}): CreateWorkgroup {
  return CreateWorkgroupSchema.parse({
    name: 'payment-squad',
    description: 'payments strike team',
    instructions: 'ship idempotent callbacks',
    mode: 'leader_worker',
    leaderDisplayName: 'planner',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 12,
    completionGate: true,
    members: [
      {
        memberType: 'agent',
        agentId: agentId('planner-agent'),
        displayName: 'planner',
        roleDesc: '协调',
      },
      {
        memberType: 'agent',
        agentId: agentId('coder-a'),
        displayName: 'coder',
        roleDesc: '后端实现',
      },
    ],
    ...overrides,
  })
}

async function saveByName(
  db: DbClient,
  name: string,
  next: (snapshot: WorkgroupDraftSnapshot) => WorkgroupDraftSnapshot,
) {
  const current = await getWorkgroup(db, name)
  if (current === null) throw new Error(`missing fixture workgroup ${name}`)
  return (
    await saveWorkgroup(
      db,
      current.id,
      {
        expectedVersion: current.version,
        clientMutationId: ulid(),
        snapshot: next(workgroupDraftSnapshotOf(current)),
      },
      { kind: 'actor', actor: T6_ACTOR },
    )
  ).workgroup
}

async function renameByName(db: DbClient, name: string, newName: string, description?: string) {
  const current = await getWorkgroup(db, name)
  if (current === null) throw new Error(`missing fixture workgroup ${name}`)
  return (
    await renameWorkgroup(
      db,
      current.id,
      {
        newName,
        ...(description === undefined ? {} : { description }),
        expectedVersion: current.version,
        clientMutationId: ulid(),
      },
      { kind: 'actor', actor: T6_ACTOR },
    )
  ).workgroup
}

describe('RFC-164 — CreateWorkgroupSchema shape', () => {
  test('quick create (决策 #21): name+description alone is a valid body — everything defaults', () => {
    const r = CreateWorkgroupSchema.safeParse({ name: 'g1', description: 'light' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.members).toEqual([])
      expect(r.data.mode).toBe('leader_worker')
      expect(r.data.leaderDisplayName).toBeUndefined()
    }
  })

  // 用户拍板 2026-07-13: raise the default round cap and open the completion
  // gate by default. Locks WORKGROUP_MAX_ROUNDS_DEFAULT/LIMIT (20→1000, 500→1000)
  // and the completionGate default (false→true) against silent regression.
  test('new-group defaults: maxRounds=1000, completionGate ON, cap raised to 1000', () => {
    const r = CreateWorkgroupSchema.safeParse({ name: 'g1' })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.maxRounds).toBe(1000)
      expect(r.data.completionGate).toBe(true)
    }
    // Cap raised 500 → 1000: exactly 1000 is accepted, 1001 is rejected.
    expect(CreateWorkgroupSchema.safeParse({ name: 'g2', maxRounds: 1000 }).success).toBe(true)
    expect(CreateWorkgroupSchema.safeParse({ name: 'g3', maxRounds: 1001 }).success).toBe(false)
  })

  test('leader_worker WITHOUT leader is save-valid (readiness is launch-time)', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      members: [{ memberType: 'agent', agentId: agentId('a'), displayName: 'a' }],
    })
    expect(r.success).toBe(true)
  })

  test('leader must be an agent member (human leader rejected)', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      leaderDisplayName: 'human-lead',
      members: [
        { memberType: 'human', userId: 'u1', displayName: 'human-lead' },
        { memberType: 'agent', agentId: agentId('a'), displayName: 'a' },
      ],
    })
    expect(r.success).toBe(false)
  })

  test('duplicate displayName within a group is rejected', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      leaderDisplayName: 'dev',
      members: [
        { memberType: 'agent', agentId: agentId('a'), displayName: 'dev' },
        { memberType: 'agent', agentId: agentId('b'), displayName: 'dev' },
      ],
    })
    expect(r.success).toBe(false)
  })

  test('displayName must not contain @, comma or whitespace (mention token)', () => {
    for (const bad of ['@dev', 'de v', 'a,b']) {
      const r = CreateWorkgroupSchema.safeParse({
        name: 'g1',
        mode: 'free_collab',
        members: [{ memberType: 'agent', agentId: agentId('a'), displayName: bad }],
      })
      expect(r.success).toBe(false)
    }
  })

  test('member type/ref cross-field rules', () => {
    // agent member without agentId
    expect(
      CreateWorkgroupSchema.safeParse({
        name: 'g1',
        mode: 'free_collab',
        members: [{ memberType: 'agent', displayName: 'a' }],
      }).success,
    ).toBe(false)
    // human member without userId
    expect(
      CreateWorkgroupSchema.safeParse({
        name: 'g1',
        mode: 'free_collab',
        members: [{ memberType: 'human', displayName: 'h' }],
      }).success,
    ).toBe(false)
    // human member carrying agentId
    expect(
      CreateWorkgroupSchema.safeParse({
        name: 'g1',
        mode: 'free_collab',
        members: [{ memberType: 'human', userId: 'u', agentId: 'agent-x', displayName: 'h' }],
      }).success,
    ).toBe(false)
  })

  test('workgroupLaunchReadiness: no-agent-member / leader-missing / ready', () => {
    const human = { id: 'h1', memberType: 'human' as const }
    const agentA = { id: 'a1', memberType: 'agent' as const }
    // RFC-187 TRAP-1 加了 advisory `warnings` 层（不阻启动）；这里的 blocking
    // golden 全部零 warning——warning 三态见 rfc187-launch-readiness.test.ts。
    expect(
      workgroupLaunchReadiness({ mode: 'leader_worker', leaderMemberId: null, members: [human] }),
    ).toEqual({ ready: false, reasons: ['no-agent-member', 'leader-missing'], warnings: [] })
    expect(
      workgroupLaunchReadiness({ mode: 'leader_worker', leaderMemberId: null, members: [agentA] }),
    ).toEqual({ ready: false, reasons: ['leader-missing'], warnings: [] })
    // leader id pointing at a non-agent member is NOT ready
    expect(
      workgroupLaunchReadiness({
        mode: 'leader_worker',
        leaderMemberId: 'h1',
        members: [human, agentA],
      }),
    ).toEqual({ ready: false, reasons: ['leader-missing'], warnings: [] })
    expect(
      workgroupLaunchReadiness({
        mode: 'leader_worker',
        leaderMemberId: 'a1',
        members: [human, agentA],
      }),
    ).toEqual({ ready: true, reasons: [], warnings: [] })
    // free_collab only needs an agent member
    expect(
      workgroupLaunchReadiness({ mode: 'free_collab', leaderMemberId: null, members: [agentA] }),
    ).toEqual({ ready: true, reasons: [], warnings: [] })
  })

  test('free_collab needs no leader and resolves switches as all-on', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      mode: 'free_collab',
      switches: { shareOutputs: false, directMessages: false, blackboard: false },
      members: [{ memberType: 'agent', agentId: agentId('a'), displayName: 'a' }],
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(resolveWorkgroupSwitches(r.data.mode, r.data.switches)).toEqual({
        shareOutputs: true,
        directMessages: true,
        blackboard: true,
      })
    }
    // leader_worker keeps storage as-is
    expect(
      resolveWorkgroupSwitches('leader_worker', {
        shareOutputs: false,
        directMessages: true,
        blackboard: false,
      }),
    ).toEqual({ shareOutputs: false, directMessages: true, blackboard: false })
  })
})

describe('RFC-164 — services/workgroups.ts CRUD', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.insert(agents).values(
      AGENT_NAMES.map((name) => ({
        id: agentId(name),
        name,
      })),
    )
  })

  test('create + get round-trip: leader resolved, members ordered, switches persisted', async () => {
    const g = await createWorkgroup(db, groupInput())
    expect(g.id).toBeTruthy()
    expect(g.mode).toBe('leader_worker')
    expect(g.members).toHaveLength(2)
    expect(g.members[0]?.displayName).toBe('planner') // sortOrder = input order
    expect(g.members[1]?.displayName).toBe('coder')
    const leader = g.members.find((m) => m.id === g.leaderMemberId)
    expect(leader?.displayName).toBe('planner')
    expect(leader?.memberType).toBe('agent')
    expect(g.switches).toEqual({ shareOutputs: true, directMessages: false, blackboard: false })
    expect(g.maxRounds).toBe(12)
    expect(g.completionGate).toBe(true)

    const fetched = await getWorkgroup(db, 'payment-squad')
    expect(fetched?.id).toBe(g.id)
    expect((await listWorkgroups(db)).map((x) => x.name)).toEqual(['payment-squad'])
  })

  test('name conflict → ConflictError', async () => {
    await createWorkgroup(db, groupInput())
    expect(createWorkgroup(db, groupInput())).rejects.toThrow(ConflictError)
  })

  test('same member displayName across two groups is fine (uniqueness is per-group)', async () => {
    await createWorkgroup(db, groupInput())
    const g2 = await createWorkgroup(db, groupInput({ name: 'another-squad' }))
    expect(g2.members.map((m) => m.displayName)).toContain('planner')
  })

  test('versioned save replaces changed roster, re-resolves leader, and clears it in fc', async () => {
    const g1 = await createWorkgroup(db, groupInput())
    const oldIds = new Set(g1.members.map((m) => m.id))

    const g2 = await saveByName(db, 'payment-squad', (snapshot) => ({
      ...snapshot,
      description: 'v2',
      instructions: '',
      mode: 'free_collab',
      leaderDisplayName: undefined,
      switches: { shareOutputs: false, directMessages: false, blackboard: false },
      maxRounds: 30,
      completionGate: false,
      members: [
        {
          memberType: 'agent',
          agentId: agentId('coder-a'),
          displayName: 'coder',
          roleDesc: '实现',
        },
        {
          memberType: 'agent',
          agentId: agentId('auditor'),
          displayName: 'auditor',
          roleDesc: '审计',
        },
      ],
    }))
    expect(g2.mode).toBe('free_collab')
    expect(g2.leaderMemberId).toBeNull()
    expect(g2.members).toHaveLength(2)
    for (const m of g2.members) expect(oldIds.has(m.id)).toBe(false)
    expect(g2.description).toBe('v2')
    expect(g2.maxRounds).toBe(30)
  })

  test('service-level defensive leader validation (bypassing route zod)', async () => {
    const input = groupInput()
    // hand-corrupt: leader name that matches no member
    const corrupted = { ...input, leaderDisplayName: 'ghost' }
    expect(createWorkgroup(db, corrupted)).rejects.toThrow(ValidationError)
  })

  test('human member must be an existing active user', async () => {
    const withGhostHuman = groupInput({
      members: [
        { memberType: 'agent', agentId: agentId('a'), displayName: 'planner', roleDesc: '' },
        { memberType: 'human', userId: 'no-such-user', displayName: 'pm', roleDesc: '' },
      ],
    })
    expect(createWorkgroup(db, withGhostHuman)).rejects.toThrow(ValidationError)

    const u = await createUser(db, {
      username: 'pmuser',
      displayName: 'pm',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const ok = await createWorkgroup(db, {
      ...groupInput({ name: 'with-human' }),
      members: [
        { memberType: 'agent', agentId: agentId('a'), displayName: 'planner', roleDesc: '' },
        { memberType: 'human', userId: u.id, displayName: 'pm', roleDesc: '把关' },
      ],
    })
    const human = ok.members.find((m) => m.memberType === 'human')
    expect(human?.userId).toBe(u.id)
    expect(human?.displayName).toBe('pm')
  })

  test('rename happy path + conflict + delete + not-found', async () => {
    await createWorkgroup(db, groupInput())
    const renamed = await renameByName(db, 'payment-squad', 'pay-squad')
    expect(renamed.name).toBe('pay-squad')
    expect(await getWorkgroup(db, 'payment-squad')).toBeNull()

    await createWorkgroup(db, groupInput())
    expect(renameByName(db, 'pay-squad', 'payment-squad')).rejects.toThrow(ConflictError)

    const current = await getWorkgroup(db, 'pay-squad')
    if (current === null) throw new Error('missing pay-squad')
    await deleteWorkgroup(
      db,
      current.id,
      { expectedVersion: current.version, clientMutationId: ulid(), confirm: current.name },
      { kind: 'actor', actor: T6_ACTOR },
    )
    expect(await getWorkgroup(db, 'pay-squad')).toBeNull()
    expect(
      deleteWorkgroup(
        db,
        current.id,
        { expectedVersion: current.version, clientMutationId: ulid(), confirm: current.name },
        { kind: 'actor', actor: T6_ACTOR },
      ),
    ).rejects.toThrow(NotFoundError)
    expect(
      saveWorkgroup(
        db,
        current.id,
        {
          expectedVersion: current.version,
          clientMutationId: ulid(),
          snapshot: workgroupDraftSnapshotOf(current),
        },
        { kind: 'actor', actor: T6_ACTOR },
      ),
    ).rejects.toThrow(NotFoundError)
  })

  test('rename + description edit atomically (2026-07-13 后端原子端点)', async () => {
    await createWorkgroup(db, groupInput())
    // name + description together
    const both = await renameByName(db, 'payment-squad', 'pay-squad', 'new blurb')
    expect(both.name).toBe('pay-squad')
    expect(both.description).toBe('new blurb')

    // description-only: name unchanged, the conflict/scheduled guards don't run,
    // the description is updated in place.
    const descOnly = await renameByName(db, 'pay-squad', 'pay-squad', 'blurb v2')
    expect(descOnly.name).toBe('pay-squad')
    expect(descOnly.description).toBe('blurb v2')

    // pure rename (description omitted) leaves the stored description untouched.
    const pure = await renameByName(db, 'pay-squad', 'pay-team')
    expect(pure.name).toBe('pay-team')
    expect(pure.description).toBe('blurb v2')

    // no-op (same name, description omitted) returns the row unchanged.
    const noop = await renameByName(db, 'pay-team', 'pay-team')
    expect(noop.name).toBe('pay-team')
    expect(noop.description).toBe('blurb v2')
  })

  test('diffNewAgentMemberIds — only new agent refs, humans ignored, dedup', () => {
    const prev = {
      members: [
        {
          id: '1',
          memberType: 'agent' as const,
          agentId: 'agent-a',
          agentName: 'a',
          userId: null,
          displayName: 'a',
          roleDesc: '',
          sortOrder: 0,
        },
      ],
    }
    const next = {
      members: [
        { memberType: 'agent', agentId: 'agent-a' },
        { memberType: 'agent', agentId: 'agent-b' },
        { memberType: 'agent', agentId: 'agent-b' },
        { memberType: 'human', agentId: undefined },
      ],
    }
    expect(diffNewAgentMemberIds(prev, next)).toEqual(['agent-b'])
    expect(diffNewAgentMemberIds(null, next)).toEqual(['agent-a', 'agent-b'])
  })
})

describe('RFC-164 — workgroups route ACL (RFC-099 D1/D4/D15/D18)', () => {
  let db: DbClient
  let app: Hono
  let alice: { id: string; token: string }
  let bob: { id: string; token: string }

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

  async function req(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  async function detail(token: string, id: string): Promise<WorkgroupDetail> {
    const response = await req(token, `/api/workgroups/${id}`)
    expect(response.status).toBe(200)
    return (await response.json()) as WorkgroupDetail
  }

  function saveBody(group: WorkgroupDetail, patch: Partial<WorkgroupDraftSnapshot> = {}): string {
    return JSON.stringify({
      expectedVersion: group.version,
      clientMutationId: ulid(),
      snapshot: { ...workgroupDraftSnapshotOf(group), ...patch },
    })
  }

  function renameBody(group: WorkgroupDetail, newName: string, description?: string): string {
    return JSON.stringify({
      newName,
      ...(description === undefined ? {} : { description }),
      expectedVersion: group.version,
      clientMutationId: ulid(),
    })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: DAEMON_TOKEN,
      configPath: '/tmp/aw-rfc164-config-never-used.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    alice = await mkUser('alice', 'user')
    bob = await mkUser('bob', 'user')
    await db.insert(agents).values(
      AGENT_NAMES.map((name) => ({
        id: agentId(name),
        name,
        ownerUserId: alice.id,
      })),
    )
  })

  test('create → 201, creator becomes owner, default public; invalid body → 422', async () => {
    const res = await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ownerUserId: string; visibility: string }
    expect(body.ownerUserId).toBe(alice.id)
    expect(body.visibility).toBe('public')

    const bad = await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({ name: 'BAD NAME!' }),
    })
    expect(bad.status).toBe(422)
    expect(((await bad.json()) as { code: string }).code).toBe('workgroup-invalid')
  })

  test('private group: stranger list-excluded + detail 404 identical to missing (D1)', async () => {
    const createdResponse = await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const created = (await createdResponse.json()) as WorkgroupDetail
    await req(alice.token, `/api/workgroups/${created.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: created.id,
        expectedAclRevision: 0,
      }),
    })
    const list = (await (await req(bob.token, '/api/workgroups')).json()) as Array<{
      name: string
    }>
    expect(list.some((g) => g.name === 'payment-squad')).toBe(false)
    const invisible = await req(bob.token, `/api/workgroups/${created.id}`)
    const missing = await req(bob.token, '/api/workgroups/never-existed-id')
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(((await invisible.json()) as { code: string }).code).toBe(
      ((await missing.json()) as { code: string }).code,
    )
  })

  test('non-owner PUT/DELETE → 403; owner PUT ok', async () => {
    const createdResponse = await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const created = (await createdResponse.json()) as WorkgroupDetail
    const group = await detail(alice.token, created.id)
    const forbidden = await req(bob.token, `/api/workgroups/${created.id}`, {
      method: 'PUT',
      body: saveBody(group),
    })
    expect(forbidden.status).toBe(403)
    const del = await req(bob.token, `/api/workgroups/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(403)
    const ok = await req(alice.token, `/api/workgroups/${created.id}`, {
      method: 'PUT',
      body: saveBody(group, { description: 'v2' }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { workgroup: WorkgroupDetail }).workgroup.description).toBe('v2')
  })

  test('D15: referencing an invisible private agent as a NEW member → 422 acl-missing-refs; grandfathered ref passes', async () => {
    // alice creates a private agent
    const agentRes = await req(alice.token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'alice-private-agent',
        description: '',
        outputs: [],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: 'x',
      }),
    })
    expect(agentRes.status).toBe(201)
    const privateAgent = (await agentRes.json()) as { id: string }
    await req(alice.token, `/api/agents/${privateAgent.id}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: privateAgent.id,
        expectedAclRevision: 0,
      }),
    })

    // bob cannot reference it in a new group
    const blocked = await req(bob.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(
        groupInput({
          name: 'bobs-squad',
          leaderDisplayName: 'lead',
          members: [
            {
              memberType: 'agent',
              agentId: agentId('lead-agent'),
              displayName: 'lead',
              roleDesc: '',
            },
            {
              memberType: 'agent',
              agentId: privateAgent.id,
              displayName: 'stolen',
              roleDesc: '',
            },
          ],
        }),
      ),
    })
    expect(blocked.status).toBe(422)
    expect(((await blocked.json()) as { code: string }).code).toBe('acl-missing-refs')

    // A visible canonical id can be frozen in a new group.
    const createdResponse = await req(bob.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput({ name: 'bobs-squad' })),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as WorkgroupDetail

    // Grandfathered: visibility loss after save does not invalidate an
    // unchanged member id on the existing group.
    await req(alice.token, `/api/agents/${agentId('planner-agent')}/acl`, {
      method: 'PUT',
      body: JSON.stringify({
        visibility: 'private',
        expectedResourceId: agentId('planner-agent'),
        expectedAclRevision: 0,
      }),
    })
    const group = await detail(bob.token, created.id)
    const keep = await req(bob.token, `/api/workgroups/${created.id}`, {
      method: 'PUT',
      body: saveBody(group),
    })
    expect(keep.status).toBe(200)
  })

  test('rename via route + acl endpoint round-trip', async () => {
    const createdResponse = await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const created = (await createdResponse.json()) as WorkgroupDetail
    const group = await detail(alice.token, created.id)
    const renamed = await req(alice.token, `/api/workgroups/${created.id}/rename`, {
      method: 'POST',
      body: renameBody(group, 'pay-squad'),
    })
    expect(renamed.status).toBe(200)
    const acl = await req(alice.token, `/api/workgroups/${created.id}/acl`)
    expect(acl.status).toBe(200)
    const aclBody = (await acl.json()) as { resourceType: string; canManage: boolean }
    expect(aclBody.resourceType).toBe('workgroup')
    expect(aclBody.canManage).toBe(true)
  })

  test('rename route saves name + description atomically; description-only keeps the name', async () => {
    const createdResponse = await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const created = (await createdResponse.json()) as WorkgroupDetail
    const group = await detail(alice.token, created.id)
    const both = await req(alice.token, `/api/workgroups/${created.id}/rename`, {
      method: 'POST',
      body: renameBody(group, 'pay-squad', 'atomic blurb'),
    })
    expect(both.status).toBe(200)
    const bothReceipt = (await both.json()) as { workgroup: WorkgroupDetail }
    expect(bothReceipt.workgroup).toMatchObject({
      name: 'pay-squad',
      description: 'atomic blurb',
    })
    // description-only edit — newName echoes the current name, no rename occurs.
    const descOnly = await req(alice.token, `/api/workgroups/${created.id}/rename`, {
      method: 'POST',
      body: renameBody(bothReceipt.workgroup, 'pay-squad', 'blurb only'),
    })
    expect(descOnly.status).toBe(200)
    expect(((await descOnly.json()) as { workgroup: WorkgroupDetail }).workgroup).toMatchObject({
      name: 'pay-squad',
      description: 'blurb only',
    })
  })
})
