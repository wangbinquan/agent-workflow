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

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import {
  CreateWorkgroupSchema,
  resolveWorkgroupSwitches,
  workgroupLaunchReadiness,
  type CreateWorkgroup,
} from '@agent-workflow/shared'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'
import {
  createWorkgroup,
  deleteWorkgroup,
  diffNewAgentMemberNames,
  getWorkgroup,
  listWorkgroups,
  renameWorkgroup,
  updateWorkgroup,
} from '../src/services/workgroups'
import { ConflictError, NotFoundError, ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

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
      { memberType: 'agent', agentName: 'planner-agent', displayName: 'planner', roleDesc: '协调' },
      { memberType: 'agent', agentName: 'coder-a', displayName: 'coder', roleDesc: '后端实现' },
    ],
    ...overrides,
  })
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

  test('leader_worker WITHOUT leader is save-valid (readiness is launch-time)', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      members: [{ memberType: 'agent', agentName: 'a', displayName: 'a' }],
    })
    expect(r.success).toBe(true)
  })

  test('leader must be an agent member (human leader rejected)', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      leaderDisplayName: 'human-lead',
      members: [
        { memberType: 'human', userId: 'u1', displayName: 'human-lead' },
        { memberType: 'agent', agentName: 'a', displayName: 'a' },
      ],
    })
    expect(r.success).toBe(false)
  })

  test('duplicate displayName within a group is rejected', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      leaderDisplayName: 'dev',
      members: [
        { memberType: 'agent', agentName: 'a', displayName: 'dev' },
        { memberType: 'agent', agentName: 'b', displayName: 'dev' },
      ],
    })
    expect(r.success).toBe(false)
  })

  test('displayName must not contain @, comma or whitespace (mention token)', () => {
    for (const bad of ['@dev', 'de v', 'a,b']) {
      const r = CreateWorkgroupSchema.safeParse({
        name: 'g1',
        mode: 'free_collab',
        members: [{ memberType: 'agent', agentName: 'a', displayName: bad }],
      })
      expect(r.success).toBe(false)
    }
  })

  test('member type/ref cross-field rules', () => {
    // agent member without agentName
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
    // human member carrying agentName
    expect(
      CreateWorkgroupSchema.safeParse({
        name: 'g1',
        mode: 'free_collab',
        members: [{ memberType: 'human', userId: 'u', agentName: 'x', displayName: 'h' }],
      }).success,
    ).toBe(false)
  })

  test('workgroupLaunchReadiness: no-agent-member / leader-missing / ready', () => {
    const human = { id: 'h1', memberType: 'human' as const }
    const agentA = { id: 'a1', memberType: 'agent' as const }
    expect(
      workgroupLaunchReadiness({ mode: 'leader_worker', leaderMemberId: null, members: [human] }),
    ).toEqual({ ready: false, reasons: ['no-agent-member', 'leader-missing'] })
    expect(
      workgroupLaunchReadiness({ mode: 'leader_worker', leaderMemberId: null, members: [agentA] }),
    ).toEqual({ ready: false, reasons: ['leader-missing'] })
    // leader id pointing at a non-agent member is NOT ready
    expect(
      workgroupLaunchReadiness({
        mode: 'leader_worker',
        leaderMemberId: 'h1',
        members: [human, agentA],
      }),
    ).toEqual({ ready: false, reasons: ['leader-missing'] })
    expect(
      workgroupLaunchReadiness({
        mode: 'leader_worker',
        leaderMemberId: 'a1',
        members: [human, agentA],
      }),
    ).toEqual({ ready: true, reasons: [] })
    // free_collab only needs an agent member
    expect(
      workgroupLaunchReadiness({ mode: 'free_collab', leaderMemberId: null, members: [agentA] }),
    ).toEqual({ ready: true, reasons: [] })
  })

  test('free_collab needs no leader and resolves switches as all-on', () => {
    const r = CreateWorkgroupSchema.safeParse({
      name: 'g1',
      mode: 'free_collab',
      switches: { shareOutputs: false, directMessages: false, blackboard: false },
      members: [{ memberType: 'agent', agentName: 'a', displayName: 'a' }],
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
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
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

  test('update = full replace: member ids regenerate, leader re-resolves, fc clears leader', async () => {
    const g1 = await createWorkgroup(db, groupInput())
    const oldIds = new Set(g1.members.map((m) => m.id))

    const g2 = await updateWorkgroup(db, 'payment-squad', {
      description: 'v2',
      instructions: '',
      mode: 'free_collab',
      switches: { shareOutputs: false, directMessages: false, blackboard: false },
      maxRounds: 30,
      completionGate: false,
      members: [
        { memberType: 'agent', agentName: 'coder-a', displayName: 'coder', roleDesc: '实现' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'auditor', roleDesc: '审计' },
      ],
    })
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
        { memberType: 'agent', agentName: 'a', displayName: 'planner', roleDesc: '' },
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
        { memberType: 'agent', agentName: 'a', displayName: 'planner', roleDesc: '' },
        { memberType: 'human', userId: u.id, displayName: 'pm', roleDesc: '把关' },
      ],
    })
    const human = ok.members.find((m) => m.memberType === 'human')
    expect(human?.userId).toBe(u.id)
    expect(human?.displayName).toBe('pm')
  })

  test('rename happy path + conflict + delete + not-found', async () => {
    await createWorkgroup(db, groupInput())
    const renamed = await renameWorkgroup(db, 'payment-squad', 'pay-squad')
    expect(renamed.name).toBe('pay-squad')
    expect(await getWorkgroup(db, 'payment-squad')).toBeNull()

    await createWorkgroup(db, groupInput())
    expect(renameWorkgroup(db, 'pay-squad', 'payment-squad')).rejects.toThrow(ConflictError)

    await deleteWorkgroup(db, 'pay-squad')
    expect(await getWorkgroup(db, 'pay-squad')).toBeNull()
    expect(deleteWorkgroup(db, 'pay-squad')).rejects.toThrow(NotFoundError)
    expect(updateWorkgroup(db, 'pay-squad', groupInput())).rejects.toThrow(NotFoundError)
  })

  test('rename + description edit atomically (2026-07-13 后端原子端点)', async () => {
    await createWorkgroup(db, groupInput())
    // name + description together
    const both = await renameWorkgroup(db, 'payment-squad', 'pay-squad', 'new blurb')
    expect(both.name).toBe('pay-squad')
    expect(both.description).toBe('new blurb')

    // description-only: name unchanged, the conflict/scheduled guards don't run,
    // the description is updated in place.
    const descOnly = await renameWorkgroup(db, 'pay-squad', 'pay-squad', 'blurb v2')
    expect(descOnly.name).toBe('pay-squad')
    expect(descOnly.description).toBe('blurb v2')

    // pure rename (description omitted) leaves the stored description untouched.
    const pure = await renameWorkgroup(db, 'pay-squad', 'pay-team')
    expect(pure.name).toBe('pay-team')
    expect(pure.description).toBe('blurb v2')

    // no-op (same name, description omitted) returns the row unchanged.
    const noop = await renameWorkgroup(db, 'pay-team', 'pay-team')
    expect(noop.name).toBe('pay-team')
    expect(noop.description).toBe('blurb v2')
  })

  test('diffNewAgentMemberNames — only new agent refs, humans ignored, dedup', () => {
    const prev = {
      members: [
        {
          id: '1',
          memberType: 'agent' as const,
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
        { memberType: 'agent', agentName: 'a' },
        { memberType: 'agent', agentName: 'b' },
        { memberType: 'agent', agentName: 'b' },
        { memberType: 'human', agentName: undefined },
      ],
    }
    expect(diffNewAgentMemberNames(prev, next)).toEqual(['b'])
    expect(diffNewAgentMemberNames(null, next)).toEqual(['a', 'b'])
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
    await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    await req(alice.token, '/api/workgroups/payment-squad/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })
    const list = (await (await req(bob.token, '/api/workgroups')).json()) as Array<{
      name: string
    }>
    expect(list.some((g) => g.name === 'payment-squad')).toBe(false)
    const invisible = await req(bob.token, '/api/workgroups/payment-squad')
    const missing = await req(bob.token, '/api/workgroups/never-existed')
    expect(invisible.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(((await invisible.json()) as { code: string }).code).toBe(
      ((await missing.json()) as { code: string }).code,
    )
  })

  test('non-owner PUT/DELETE → 403; owner PUT ok', async () => {
    await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const { name: _n, ...updateBody } = groupInput()
    const forbidden = await req(bob.token, '/api/workgroups/payment-squad', {
      method: 'PUT',
      body: JSON.stringify(updateBody),
    })
    expect(forbidden.status).toBe(403)
    const del = await req(bob.token, '/api/workgroups/payment-squad', { method: 'DELETE' })
    expect(del.status).toBe(403)
    const ok = await req(alice.token, '/api/workgroups/payment-squad', {
      method: 'PUT',
      body: JSON.stringify({ ...updateBody, description: 'v2' }),
    })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { description: string }).description).toBe('v2')
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
    await req(alice.token, '/api/agents/alice-private-agent/acl', {
      method: 'PUT',
      body: JSON.stringify({ visibility: 'private' }),
    })

    // bob cannot reference it in a new group
    const blocked = await req(bob.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(
        groupInput({
          name: 'bobs-squad',
          leaderDisplayName: 'lead',
          members: [
            { memberType: 'agent', agentName: 'lead-agent', displayName: 'lead', roleDesc: '' },
            {
              memberType: 'agent',
              agentName: 'alice-private-agent',
              displayName: 'stolen',
              roleDesc: '',
            },
          ],
        }),
      ),
    })
    expect(blocked.status).toBe(422)
    expect(((await blocked.json()) as { code: string }).code).toBe('acl-missing-refs')

    // dangling (nonexistent) agent names still pass — launch validates existence
    const dangling = await req(bob.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput({ name: 'bobs-squad' })),
    })
    expect(dangling.status).toBe(201)

    // grandfathered: keeping the same members on update never re-checks them
    const { name: _n2, ...same } = groupInput({ name: 'bobs-squad' })
    const keep = await req(bob.token, '/api/workgroups/bobs-squad', {
      method: 'PUT',
      body: JSON.stringify(same),
    })
    expect(keep.status).toBe(200)
  })

  test('rename via route + acl endpoint round-trip', async () => {
    await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const renamed = await req(alice.token, '/api/workgroups/payment-squad/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'pay-squad' }),
    })
    expect(renamed.status).toBe(200)
    const acl = await req(alice.token, '/api/workgroups/pay-squad/acl')
    expect(acl.status).toBe(200)
    const aclBody = (await acl.json()) as { resourceType: string; canManage: boolean }
    expect(aclBody.resourceType).toBe('workgroup')
    expect(aclBody.canManage).toBe(true)
  })

  test('rename route saves name + description atomically; description-only keeps the name', async () => {
    await req(alice.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify(groupInput()),
    })
    const both = await req(alice.token, '/api/workgroups/payment-squad/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'pay-squad', description: 'atomic blurb' }),
    })
    expect(both.status).toBe(200)
    expect((await both.json()) as { name: string; description: string }).toMatchObject({
      name: 'pay-squad',
      description: 'atomic blurb',
    })
    // description-only edit — newName echoes the current name, no rename occurs.
    const descOnly = await req(alice.token, '/api/workgroups/pay-squad/rename', {
      method: 'POST',
      body: JSON.stringify({ newName: 'pay-squad', description: 'blurb only' }),
    })
    expect(descOnly.status).toBe(200)
    expect((await descOnly.json()) as { name: string; description: string }).toMatchObject({
      name: 'pay-squad',
      description: 'blurb only',
    })
  })
})
