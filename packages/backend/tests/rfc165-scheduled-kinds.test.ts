// LOCKS: RFC-165 §9b (D11) — scheduled-task three-subject support
// (design §11.16/.17/.19).
//
//   K1 create kind='agent': payload validated through the kind envelope
//      (scheduledPayloadSchemaFor selector); LIGHT create-time gate — missing
//      agent 404, builtin agent 403; success stamps launch_kind + DTO field.
//   K2 create kind='workgroup': missing group 404; success stamps kind.
//   K3 kind is IMMUTABLE: PUT with a different launchKind → 422
//      scheduled-kind-immutable; PUT restating the same kind passes.
//   K4 fire dispatch (agent): the REAL buildScheduleLaunch factory routes an
//      agent row through startAgentTask — task lands with sourceAgentName +
//      scheduled_task_id stamped (scratch space; full launch validation ran).
//   K5 fire dispatch (workgroup): routes through startWorkgroupTask — task
//      lands with workgroupId; run-now shares fireSchedule (same dispatch).
//   K6 N1-r3 permission matrix over HTTP with a narrow PAT (no tasks:launch):
//      create 403 / run-now 403 / enable 403 / enabled-state spec change 403;
//      rename, disable, disabled-state spec-only edit, delete ALL pass.
//   K7 compat: create without launchKind defaults to 'workflow' (old
//      clients keep working byte-for-byte).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, scheduledTasks, tasks } from '../src/db/schema'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { buildScheduleLaunch } from '../src/services/scheduleLaunch'
import {
  createScheduledTask,
  fireSchedule,
  getScheduledTaskRow,
  updateScheduledTask,
} from '../src/services/scheduledTasks'
import { createUser } from '../src/services/users'
import { createWorkflow } from '../src/services/workflow'
import { createWorkgroup } from '../src/services/workgroups'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const

const AGENT_FIELDS = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: 'do it',
}

function actorFor(id: string, role: 'admin' | 'user' = 'admin'): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role, status: 'active' },
    source: 'daemon',
  })
}

async function seedOwner(db: DbClient): Promise<string> {
  const u = await createUser(db, {
    username: 'alice',
    displayName: 'alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  return u.id
}

describe('RFC-165 §9b — create/update by kind (K1/K2/K3/K7)', () => {
  let db: DbClient
  let ownerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    ownerId = await seedOwner(db)
  })

  test('K1 agent kind: envelope validated; missing 404; builtin 403; success stamps kind', async () => {
    await expect(
      createScheduledTask(
        db,
        {
          name: 's',
          launchKind: 'agent',
          launchPayload: { agentId: 'ghost-id', name: 't', description: 'd', scratch: true },
          scheduleSpec: SPEC,
          enabled: true,
        },
        { actor: actorFor(ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'agent-not-found' })

    const builtinId = ulid()
    await db.insert(agents).values({
      id: builtinId,
      name: 'sys',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      builtin: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await expect(
      createScheduledTask(
        db,
        {
          name: 's',
          launchKind: 'agent',
          launchPayload: { agentId: builtinId, name: 't', description: 'd', scratch: true },
          scheduleSpec: SPEC,
          enabled: true,
        },
        { actor: actorFor(ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'builtin-readonly' })

    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const created = await createScheduledTask(
      db,
      {
        name: 'agent sched',
        launchKind: 'agent',
        launchPayload: {
          agentId: solo.id,
          agentName: 'client-supplied-stale-name',
          name: 't',
          description: 'd',
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actorFor(ownerId) },
    )
    expect(created.launchKind).toBe('agent')
    expect(created.launchPayload as { agentId: string; agentName: string }).toMatchObject({
      agentId: solo.id,
      agentName: 'solo',
    })
    const row = await getScheduledTaskRow(db, created.id)
    expect(row!.launchKind).toBe('agent')
  })

  test('K2 workgroup kind: missing group 404; success stamps kind', async () => {
    await expect(
      createScheduledTask(
        db,
        {
          name: 's',
          launchKind: 'workgroup',
          launchPayload: { workgroupId: 'missing-id', name: 't', goal: 'g', scratch: true },
          scheduleSpec: SPEC,
          enabled: true,
        },
        { actor: actorFor(ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-not-found' })

    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const squad = await createWorkgroup(db, {
      name: 'squad',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1.id, displayName: 'lead', roleDesc: '' }],
    })
    const created = await createScheduledTask(
      db,
      {
        name: 'wg sched',
        launchKind: 'workgroup',
        launchPayload: {
          workgroupId: squad.id,
          workgroupName: 'client-supplied-stale-name',
          name: 't',
          goal: 'g',
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actorFor(ownerId) },
    )
    expect(created.launchKind).toBe('workgroup')
    expect(created.launchPayload as { workgroupId: string; workgroupName: string }).toMatchObject({
      workgroupId: squad.id,
      workgroupName: 'squad',
    })
  })

  test('K3 kind immutable on PUT; restating the same kind passes', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const created = await createScheduledTask(
      db,
      {
        name: 'agent sched',
        launchKind: 'agent',
        launchPayload: { agentId: solo.id, name: 't', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: false,
      },
      { actor: actorFor(ownerId) },
    )
    await expect(
      updateScheduledTask(db, created.id, { launchKind: 'workflow' }, { actor: actorFor(ownerId) }),
    ).rejects.toMatchObject({ code: 'scheduled-kind-immutable' })
    const renamed = await updateScheduledTask(
      db,
      created.id,
      { launchKind: 'agent', name: 'renamed' },
      { actor: actorFor(ownerId) },
    )
    expect(renamed.name).toBe('renamed')
  })

  test('K8 update with a kind-mismatched payload → 422 scheduled-task-invalid (no 500)', async () => {
    // Implementation-gate P1: the service used to .parse() and let the raw
    // ZodError escape to the errorHandler as HTTP 500.
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const created = await createScheduledTask(
      db,
      {
        name: 'agent sched',
        launchKind: 'agent',
        launchPayload: { agentId: solo.id, name: 't', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: false,
      },
      { actor: actorFor(ownerId) },
    )
    await expect(
      updateScheduledTask(
        db,
        created.id,
        { launchPayload: { workflowId: 'wf', name: 't', inputs: {} } },
        { actor: actorFor(ownerId) },
      ),
    ).rejects.toMatchObject({ code: 'scheduled-task-invalid' })
  })

  test('K9 agent rename stays id-stable; delete refuses while a schedule targets the id', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await createScheduledTask(
      db,
      {
        name: 'agent sched',
        launchKind: 'agent',
        launchPayload: { agentId: solo.id, name: 't', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: false,
      },
      { actor: actorFor(ownerId) },
    )
    const { deleteAgent, renameAgent } = await import('../src/services/agent')
    expect(await renameAgent(db, solo.id, { newName: 'solo2' })).toMatchObject({
      id: solo.id,
      name: 'solo2',
    })
    await expect(deleteAgent(db, solo.id, T6_ACTOR)).rejects.toMatchObject({
      code: 'agent-scheduled-referenced',
    })
  })

  test('K10 workgroup rename stays id-stable; delete refuses while a schedule targets the id', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const squad = await createWorkgroup(db, {
      name: 'squad',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1.id, displayName: 'lead', roleDesc: '' }],
    })
    await createScheduledTask(
      db,
      {
        name: 'wg sched',
        launchKind: 'workgroup',
        launchPayload: { workgroupId: squad.id, name: 't', goal: 'g', scratch: true },
        scheduleSpec: SPEC,
        enabled: false,
      },
      { actor: actorFor(ownerId) },
    )
    const { deleteWorkgroup, renameWorkgroup } = await import('../src/services/workgroups')
    const renamed = await renameWorkgroup(
      db,
      squad.id,
      {
        newName: 'squad2',
        expectedVersion: squad.version,
        clientMutationId: ulid(),
      },
      { kind: 'actor', actor: T6_ACTOR },
    )
    expect(renamed).toMatchObject({
      id: squad.id,
      name: 'squad2',
    })
    await expect(
      deleteWorkgroup(
        db,
        squad.id,
        {
          expectedVersion: renamed.version,
          clientMutationId: ulid(),
          confirmName: renamed.name,
        },
        { kind: 'actor', actor: T6_ACTOR },
      ),
    ).rejects.toMatchObject({
      code: 'workgroup-scheduled-referenced',
    })
  })

  test('K7 compat: create without launchKind defaults to workflow', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] } as never,
    })
    const created = await createScheduledTask(
      db,
      {
        name: 'legacy client',
        launchKind: 'workflow', // schema default — restated here for the typed call
        launchPayload: {
          workflowId: wf.id,
          name: 't',
          inputs: {},
          repoUrl: 'https://example.com/a.git',
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actorFor(ownerId) },
    )
    expect(created.launchKind).toBe('workflow')
  })
})

describe('RFC-165 §9b — fire dispatch by kind (K4/K5)', () => {
  let db: DbClient
  let appHome: string
  let ownerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-kinds-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    writeFileSync(join(appHome, 'config.json'), JSON.stringify({ $schema_version: 1 }))
    ownerId = await seedOwner(db)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('K4 agent row fires through startAgentTask (sourceAgentName + scheduled_task_id)', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const created = await createScheduledTask(
      db,
      {
        name: 'agent sched',
        launchKind: 'agent',
        launchPayload: { agentId: solo.id, name: 'nightly', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actorFor(ownerId) },
    )
    // Display metadata can be stale/corrupt without changing identity. Fire
    // must resolve solely by agentId and never fall back to this name.
    await db
      .update(scheduledTasks)
      .set({
        launchPayload: JSON.stringify({
          ...(created.launchPayload as object),
          agentName: 'definitely-not-solo',
        }),
      })
      .where(eq(scheduledTasks.id, created.id))
    const row = (await getScheduledTaskRow(db, created.id))!
    const { taskId } = await fireSchedule(
      db,
      row,
      buildScheduleLaunch(db, join(appHome, 'config.json')),
      Date.now(),
    )
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(task.sourceAgentName).toBe('solo')
    expect(task.scheduledTaskId).toBe(created.id)
    expect(task.spaceKind).toBe('scratch')
    expect(task.name).toContain('nightly') // decorateTaskName keeps the base
  })

  test('K5 workgroup row fires through startWorkgroupTask (workgroupId stamped)', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const squad = await createWorkgroup(db, {
      name: 'squad',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1.id, displayName: 'lead', roleDesc: '' }],
    })
    const created = await createScheduledTask(
      db,
      {
        name: 'wg sched',
        launchKind: 'workgroup',
        launchPayload: {
          workgroupId: squad.id,
          name: 'nightly',
          goal: 'g',
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actorFor(ownerId) },
    )
    await db
      .update(scheduledTasks)
      .set({
        launchPayload: JSON.stringify({
          ...(created.launchPayload as object),
          workgroupName: 'definitely-not-squad',
        }),
      })
      .where(eq(scheduledTasks.id, created.id))
    const row = (await getScheduledTaskRow(db, created.id))!
    const { taskId } = await fireSchedule(
      db,
      row,
      buildScheduleLaunch(db, join(appHome, 'config.json')),
      Date.now(),
    )
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(task.workgroupId).not.toBe(null)
    expect(task.scheduledTaskId).toBe(created.id)
  })
})

describe('RFC-165 §9b — N1-r3 permission matrix over HTTP (K6)', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let appHome: string
  let narrowPat: string
  let launchPat: string
  let adminToken: string
  let wfId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-kinds-http-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    app = createApp({
      token: 'a'.repeat(64),
      configPath: join(appHome, 'config.json'),
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const admin = await createUser(db, {
      username: 'alice',
      displayName: 'alice',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    adminToken = (await createSession({ db, userId: admin.id })).token
    const bob = await createUser(db, {
      username: 'bob',
      displayName: 'bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    narrowPat = (
      await createPat({
        db,
        userId: bob.id,
        name: 'narrow',
        scopes: ['tasks:read:own', 'workflows:read'],
      })
    ).token
    launchPat = (
      await createPat({
        db,
        userId: bob.id,
        name: 'launcher',
        scopes: ['tasks:launch', 'workflows:read'],
      })
    ).token
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] } as never,
    })
    wfId = wf.id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  async function req(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  const createBody = () =>
    JSON.stringify({
      name: 's',
      launchPayload: {
        workflowId: wfId,
        name: 't',
        inputs: {},
        repoUrl: 'https://example.com/a.git',
      },
      scheduleSpec: SPEC,
      enabled: false,
    })

  test('K6 matrix: launch-arming ops need tasks:launch; stop/rename/delete stay open', async () => {
    // create: narrow PAT 403; launch PAT 201.
    const denied = await req('/api/scheduled-tasks', narrowPat, {
      method: 'POST',
      body: createBody(),
    })
    expect(denied.status).toBe(403)
    const ok = await req('/api/scheduled-tasks', launchPat, { method: 'POST', body: createBody() })
    expect(ok.status).toBe(201)
    const sched = (await ok.json()) as { id: string }

    // enable (arms) → 403 for narrow; rename + disabled-state spec-only edit pass.
    const enableDenied = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    expect(enableDenied.status).toBe(403)
    const rename = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, {
      method: 'PUT',
      body: JSON.stringify({ name: 'renamed by narrow' }),
    })
    expect(rename.status).toBe(200)
    const specWhileDisabled = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, {
      method: 'PUT',
      body: JSON.stringify({ scheduleSpec: { kind: 'daily', at: '10:00', timezone: 'UTC' } }),
    })
    expect(specWhileDisabled.status).toBe(200)

    // payload replacement (arms) → 403 for narrow.
    const payloadDenied = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, {
      method: 'PUT',
      body: JSON.stringify({
        launchPayload: {
          workflowId: wfId,
          name: 't2',
          inputs: {},
          repoUrl: 'https://example.com/b.git',
        },
      }),
    })
    expect(payloadDenied.status).toBe(403)

    // enable via launch PAT, then enabled-state spec change → 403 for narrow.
    const enabled = await req(`/api/scheduled-tasks/${sched.id}`, launchPat, {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
    expect(enabled.status).toBe(200)
    const specWhileEnabled = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, {
      method: 'PUT',
      body: JSON.stringify({ scheduleSpec: { kind: 'daily', at: '11:00', timezone: 'UTC' } }),
    })
    expect(specWhileEnabled.status).toBe(403)

    // run-now: narrow 403 (the launch itself will fail on the fake URL for
    // the launch PAT — permission is what's under test, so only the 403 arm
    // is asserted here; K4/K5 cover the real dispatch).
    const runDenied = await req(`/api/scheduled-tasks/${sched.id}/run-now`, narrowPat, {
      method: 'POST',
      body: '{}',
    })
    expect(runDenied.status).toBe(403)

    // disable + delete stay open to the narrow PAT.
    const disable = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    })
    expect(disable.status).toBe(200)
    const del = await req(`/api/scheduled-tasks/${sched.id}`, narrowPat, { method: 'DELETE' })
    expect([200, 204]).toContain(del.status)

    // Sanity: an admin session is never gated.
    const adminCreate = await req('/api/scheduled-tasks', adminToken, {
      method: 'POST',
      body: createBody(),
    })
    expect(adminCreate.status).toBe(201)
  })

  test('RFC-223 PR-7: name-only scheduled targets are rejected at the HTTP boundary', async () => {
    for (const [launchKind, launchPayload] of [
      ['agent', { agentName: 'legacy-agent-name', name: 't', description: 'd', scratch: true }],
      ['workgroup', { workgroupName: 'legacy-group-name', name: 't', goal: 'g', scratch: true }],
    ] as const) {
      const res = await req('/api/scheduled-tasks', adminToken, {
        method: 'POST',
        body: JSON.stringify({
          name: `${launchKind} name-only`,
          launchKind,
          launchPayload,
          scheduleSpec: SPEC,
          enabled: false,
        }),
      })
      expect(res.status).toBe(422)
    }
  })
})
