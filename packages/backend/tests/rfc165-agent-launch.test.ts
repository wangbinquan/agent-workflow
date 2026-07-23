// LOCKS: RFC-165 §4 — single-agent launch path (design §11.8/.9/.11/.12).
//
//   A1  buildAgentHostSnapshot shape: input→agent edge; allowClarify wires an
//       OPTIONAL clarify channel (sessionMode isolated + clarifyMode optional
//       + the two clarify edges); allowClarify=false omits it entirely; the
//       snapshot parses through WorkflowDefinitionSchema and passes
//       validateWorkflowDef with a live context.
//   A2  negative matrix: missing agent / missing skill / missing plugin all
//       FAIL validation — the plugin case proves the launch path uses the
//       FULL production context (R3-3; the old hand-rolled ctx skipped it).
//   A3  startAgentTask happy path (scratch): task lands with
//       workflowId=__agent_host__ anchor, sourceAgentName stamped,
//       spaceKind 'scratch', frozen snapshot = the synthesized def, and the
//       description riding inputs.description.
//   A4  ACL: unknown agent and invisible (private) agent 404 IDENTICALLY;
//       builtin agent → 403 builtin-readonly; no space source → 422
//       agent-launch-invalid.
//   A5  F17 transactional re-check: an agent deleted between the service
//       gate and the insert fails the launch with agent-not-found and leaves
//       NO task row (scratch dir cleaned).
//   A6  lifecycle guards (F13-r3): agent host tasks pass the builtin guard
//       (resume/retry reachable); workgroup host tasks stay 403; BOTH host
//       kinds get 422 task-host-sync-unsupported on sync-workflow.
//   A7  F13-r4/r5: autoResumeInterruptedTasks skips workgroup tasks; repair
//       list marks revive options unavailable for workgroup tasks and apply
//       refuses them with workgroup-repair-unsupported.
//   A8  agent delete: non-terminal single-agent task → 409
//       agent-tasks-active; id-addressed rename remains safe and terminal-only
//       history permits deletion.
//   A9  F15 permission carve-out: tasks:launch WITHOUT agents:write may
//       launch; agents:write WITHOUT tasks:launch may NOT.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  StartAgentTaskSchema,
  WorkflowDefinitionSchema,
  taskExecutionKind,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, tasks, workflows } from '../src/db/schema'
import {
  acquireAgentLaunch,
  isAgentLaunching,
  releaseAgentLaunch,
} from '../src/services/agentLaunchReservation'
import { getAgentById } from '../src/services/agent'
import { createApp } from '../src/server'
import { createAgent, deleteAgent, renameAgent } from '../src/services/agent'
import {
  AGENT_HOST_AGENT_NODE_ID,
  AGENT_HOST_CLARIFY_NODE_ID,
  AGENT_HOST_INPUT_KEY,
  AGENT_HOST_WORKFLOW_ID,
  buildAgentHostSnapshot,
  ensureAgentHostWorkflow,
  startAgentTask,
} from '../src/services/agentLaunch'
import { autoResumeInterruptedTasks } from '../src/services/autoResume'
import { createUser } from '../src/services/users'
import {
  buildWorkflowValidationContext,
  validateWorkflowDef,
} from '../src/services/workflow.validator'
import { runGit } from '../src/util/git'

// RFC-203 T6: reference-disclosure needs a principal — an admin actor keeps
// these service-level tests' original full-visibility expectations.
const T6_ACTOR = buildActor({
  user: { id: 'u-t6-test', username: 'u-t6', displayName: 'T6', role: 'admin', status: 'active' },
  source: 'session',
})

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

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
  bodyMd: 'do the thing',
}

function daemonActor() {
  return buildActor({
    user: { id: 'u-admin', username: 'admin', displayName: 'A', role: 'admin', status: 'active' },
    source: 'daemon',
  })
}

describe('RFC-165 §4 — agent host snapshot (A1/A2)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('A1 shape: clarify ON → optional channel wired; OFF → absent; both validate', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })

    const on = buildAgentHostSnapshot({ id: solo.id, name: 'solo' }, true)
    const onDef = WorkflowDefinitionSchema.parse(on)
    expect(onDef.nodes.map((n) => n.id).sort()).toEqual(
      ['__agent_clarify__', '__agent_input__', '__agent_main__'].sort(),
    )
    const clarify = onDef.nodes.find((n) => n.id === AGENT_HOST_CLARIFY_NODE_ID) as Record<
      string,
      unknown
    >
    expect(clarify.sessionMode).toBe('isolated')
    expect(clarify.clarifyMode).toBe('optional')
    const agentNode = onDef.nodes.find((n) => n.id === AGENT_HOST_AGENT_NODE_ID) as Record<
      string,
      unknown
    >
    expect(agentNode.promptTemplate).toBe(`{{${AGENT_HOST_INPUT_KEY}}}`)
    // input→agent edge + the two clarify edges.
    expect(onDef.edges.length).toBe(3)
    const ctx = await buildWorkflowValidationContext(db)
    expect(validateWorkflowDef(onDef, ctx).ok).toBe(true)

    const off = buildAgentHostSnapshot({ id: solo.id, name: 'solo' }, false)
    const offDef = WorkflowDefinitionSchema.parse(off)
    expect(offDef.nodes.map((n) => n.id).sort()).toEqual(
      ['__agent_input__', '__agent_main__'].sort(),
    )
    expect(offDef.edges.length).toBe(1)
    expect(validateWorkflowDef(offDef, ctx).ok).toBe(true)
  })

  test('A2 negative matrix: missing agent / skill / plugin all fail validation', async () => {
    const ctxNoAgent = await buildWorkflowValidationContext(db)
    const ghost = WorkflowDefinitionSchema.parse(
      buildAgentHostSnapshot({ id: 'no-such-agent-id', name: 'no-such-agent' }, true),
    )
    expect(validateWorkflowDef(ghost, ctxNoAgent).ok).toBe(false)

    // RFC-223 (PR-1): a bare skill NAME with no managed row is a repo-local
    // `project` ref (RFC-178, self-discovered → not validated). To exercise
    // skill-not-found we need a MANAGED ref to a non-existent skill id;
    // createAgent would demote an unknown token to project, so insert the row
    // directly (mirrors the deleted-plugin case below).
    const skillyId = ulid()
    await db.insert(agents).values({
      id: skillyId,
      name: 'skilly',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: JSON.stringify([{ kind: 'managed', skillId: 'no-such-skill-id' }]),
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const skillDef = WorkflowDefinitionSchema.parse(
      buildAgentHostSnapshot({ id: skillyId, name: 'skilly' }, true),
    )
    expect(validateWorkflowDef(skillDef, await buildWorkflowValidationContext(db)).ok).toBe(false)

    // createAgent validates plugin refs at SAVE time — simulate the historical
    // case (plugin deleted after the agent was saved) via a direct row insert.
    const pluggyId = ulid()
    await db.insert(agents).values({
      id: pluggyId,
      name: 'pluggy',
      description: '',
      outputs: '[]',
      permission: '{}',
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '["no-such-plugin"]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const plugDef = WorkflowDefinitionSchema.parse(
      buildAgentHostSnapshot({ id: pluggyId, name: 'pluggy' }, true),
    )
    // The load-bearing R3-3 case: with a partial {agents,skills} ctx this
    // passed silently; the full production ctx must reject it.
    expect(validateWorkflowDef(plugDef, await buildWorkflowValidationContext(db)).ok).toBe(false)
  })
})

describe('RFC-165 §4 — startAgentTask (A3/A4/A5/A8)', () => {
  let db: DbClient
  let appHome: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-agent-'))
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const BODY = () =>
    StartAgentTaskSchema.parse({
      name: 'solo run',
      description: 'fix the flaky test',
      scratch: true,
    })

  test('A3 happy path (scratch): anchor row + sourceAgentName + frozen synthesized snapshot', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const task = await startAgentTask(db, daemonActor(), solo.id, BODY(), { db, appHome })

    expect(task.status).toBe('pending')
    expect(task.workflowId).toBe(AGENT_HOST_WORKFLOW_ID)
    expect(task.sourceAgentName).toBe('solo')
    expect(task.spaceKind).toBe('scratch')
    expect(taskExecutionKind(task)).toBe('agent')
    expect(task.inputs[AGENT_HOST_INPUT_KEY]).toBe('fix the flaky test')
    const snapshot = task.workflowSnapshot as { nodes: Array<{ id: string; agentName?: string }> }
    expect(snapshot.nodes.some((n) => n.id === AGENT_HOST_AGENT_NODE_ID)).toBe(true)
    // FK anchor row exists and is builtin (lazily seeded).
    const anchor = (
      await db.select().from(workflows).where(eq(workflows.id, AGENT_HOST_WORKFLOW_ID))
    )[0]!
    expect(anchor.builtin).toBe(true)
  })

  test('RFC-223 PR-7: service input is canonical id; an existing name is not resolved', async () => {
    await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await expect(
      startAgentTask(db, daemonActor(), 'solo', BODY(), { db, appHome }),
    ).rejects.toMatchObject({ code: 'agent-not-found' })
    expect((await db.select().from(tasks)).length).toBe(0)
  })

  test('A4 unknown and invisible agents 404 identically; builtin 403; no source 422', async () => {
    const owner = await createUser(db, {
      username: 'owner',
      displayName: 'O',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const stranger = await createUser(db, {
      username: 'stranger',
      displayName: 'S',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const privateAgent = await createAgent(
      db,
      { ...AGENT_FIELDS, name: 'private-agent' },
      { ownerUserId: owner.id },
    )
    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.name, 'private-agent'))
    const strangerActor = buildActor({
      user: {
        id: stranger.id,
        username: 'stranger',
        displayName: 'S',
        role: 'user',
        status: 'active',
      },
      source: 'session',
    })

    await expect(
      startAgentTask(db, strangerActor, 'no-such-id', BODY(), { db, appHome }),
    ).rejects.toMatchObject({ code: 'agent-not-found' })
    await expect(
      startAgentTask(db, strangerActor, privateAgent.id, BODY(), { db, appHome }),
    ).rejects.toMatchObject({ code: 'agent-not-found' })

    const builtinId = ulid()
    await db.insert(agents).values({
      id: builtinId,
      name: 'sys-agent',
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
      startAgentTask(db, daemonActor(), builtinId, BODY(), { db, appHome }),
    ).rejects.toMatchObject({ code: 'builtin-readonly' })

    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await expect(
      startAgentTask(
        db,
        daemonActor(),
        solo.id,
        StartAgentTaskSchema.parse({ name: 't', description: 'd' }),
        { db, appHome },
      ),
    ).rejects.toMatchObject({ code: 'agent-launch-invalid' })
  })

  test('A5 F17: agent deleted between gate and insert → launch fails atomically', async () => {
    await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await ensureAgentHostWorkflow(db)
    // Simulate the race by handing startTask an agentLaunch whose agent no
    // longer exists at transaction time (the outer service gate already
    // passed in the real interleaving; here we call startTask directly the
    // way startAgentTask does, after removing the row).
    const { startTask } = await import('../src/services/task')
    await db.delete(agents).where(eq(agents.name, 'solo'))
    await expect(
      startTask(
        {
          workflowId: AGENT_HOST_WORKFLOW_ID,
          name: 'ghost run',
          inputs: { description: 'x' },
          scratch: true,
        } as never,
        { db, appHome, agentLaunch: { agentName: 'solo', agentId: 'solo-id', snapshotJson: '{}' } },
      ),
    ).rejects.toMatchObject({ code: 'agent-not-found' })
    // Transaction rolled back — no ghost task row.
    expect((await db.select().from(tasks)).length).toBe(0)
  })

  test('A8 delete: live task 409s; display rename is id-stable; terminal delete proceeds', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await ensureAgentHostWorkflow(db)
    const liveId = ulid()
    await db.insert(tasks).values({
      id: liveId,
      name: 'live',
      workflowId: AGENT_HOST_WORKFLOW_ID,
      workflowSnapshot: '{}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x',
      baseBranch: 'main',
      branch: `agent-workflow/${liveId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
      sourceAgentName: 'solo',
      // RFC-223: the delete guard now matches by the CANONICAL
      // source_agent_id (a real launch always stamps it), not by name.
      sourceAgentId: solo.id,
    })
    await expect(deleteAgent(db, solo.id, T6_ACTOR)).rejects.toMatchObject({
      code: 'agent-tasks-active',
    })
    const renamed = await renameAgent(db, solo.id, { newName: 'solo2' })
    expect(renamed).toMatchObject({ id: solo.id, name: 'solo2' })
    // The active-task guard follows the immutable id, not the old display name.
    await expect(deleteAgent(db, solo.id, T6_ACTOR)).rejects.toMatchObject({
      code: 'agent-tasks-active',
    })

    await db
      .update(tasks)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(tasks.id, liveId))
    // Terminal-only history no longer blocks deletion.
    await deleteAgent(db, solo.id, T6_ACTOR)
    expect((await db.select().from(agents)).length).toBe(0)
  })
})

describe('RFC-165 — HTTP surface: launch + lifecycle guards (A6/A9)', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let appHome: string
  let adminToken: string
  let soloId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc165-agent-http-'))
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
    soloId = (await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })).id
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  async function req(path: string, token: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  async function seedRepoUrl(): Promise<string> {
    const repo = join(appHome, 'src-repo')
    await runGit(appHome, ['init', '-q', '-b', 'main', 'src-repo'])
    await runGit(repo, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'init',
    ])
    return repo
  }

  test('A6 lifecycle guards: agent host passes builtin lock; workgroup host stays 403; both sync 422', async () => {
    await ensureAgentHostWorkflow(db)
    const { ensureWorkgroupHostWorkflow, WORKGROUP_HOST_WORKFLOW_ID } =
      await import('../src/services/workgroup/launch')
    await ensureWorkgroupHostWorkflow(db)

    const mk = async (over: Record<string, unknown>) => {
      const id = ulid()
      await db.insert(tasks).values({
        id,
        name: 'fixture',
        workflowSnapshot: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
        repoPath: appHome,
        worktreePath: appHome,
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status: 'failed',
        inputs: '{}',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        ...(over as object),
      } as never)
      return id
    }
    const agentTask = await mk({ workflowId: AGENT_HOST_WORKFLOW_ID, sourceAgentName: 'solo' })
    const wgTask = await mk({ workflowId: WORKGROUP_HOST_WORKFLOW_ID, workgroupId: 'wg1' })

    // Agent host: the builtin guard lets resume through (it fails later for
    // OTHER reasons — anything but builtin-readonly proves the carve-out).
    const agentResume = await req(`/api/tasks/${agentTask}/resume`, adminToken, {
      method: 'POST',
    })
    const agentBody = (await agentResume.json()) as { code?: string }
    expect(agentBody.code).not.toBe('builtin-readonly')

    // Workgroup host: locked (403 builtin-readonly via the host row).
    const wgResume = await req(`/api/tasks/${wgTask}/resume`, adminToken, { method: 'POST' })
    expect(wgResume.status).toBe(403)
    expect(((await wgResume.json()) as { code: string }).code).toBe('builtin-readonly')
    const wgRetry = await req(`/api/tasks/${wgTask}/nodes/whatever/retry`, adminToken, {
      method: 'POST',
    })
    expect(wgRetry.status).toBe(403)

    // Host sync is uniformly 422 for BOTH host kinds.
    for (const id of [agentTask, wgTask]) {
      const sync = await req(`/api/tasks/${id}/sync-workflow`, adminToken, {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: 1 }),
      })
      expect(sync.status).toBe(422)
      expect(((await sync.json()) as { code: string }).code).toBe('task-host-sync-unsupported')
    }
  })

  test('A10 raw-key gate: {scratch, repoPath} agent launch → 422 start-task-path-retired', async () => {
    // Implementation-gate P2: without the gate the retired key silently
    // strips and the body degrades to a scratch launch (F1 shape).
    const res = await req(`/api/agents/${soloId}/tasks`, adminToken, {
      method: 'POST',
      body: JSON.stringify({
        name: 't',
        description: 'd',
        scratch: true,
        repoPath: '/tmp/x',
      }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('start-task-path-retired')

    const { ensureWorkgroupHostWorkflow } = await import('../src/services/workgroup/launch')
    await ensureWorkgroupHostWorkflow(db)
    const { createWorkgroup } = await import('../src/services/workgroups')
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
    const wg = await req(`/api/workgroups/${squad.id}/tasks`, adminToken, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g', scratch: true, repoPath: '/tmp/x' }),
    })
    expect(wg.status).toBe(422)
    expect(((await wg.json()) as { code: string }).code).toBe('start-task-path-retired')
  })

  test('A9 F15 carve-out: tasks:launch suffices; agents:write alone does not', async () => {
    const bob = await createUser(db, {
      username: 'bob',
      displayName: 'bob',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const repoUrl = `file://${await seedRepoUrl()}`
    const launchBody = JSON.stringify({
      name: 'via pat',
      description: 'do it',
      repoUrl,
      ref: 'main',
    })

    const { token: launchPat } = await createPat({
      db,
      userId: bob.id,
      name: 'launch-only',
      scopes: ['agents:read', 'tasks:launch'],
    })
    const ok = await req(`/api/agents/${soloId}/tasks`, launchPat, {
      method: 'POST',
      body: launchBody,
    })
    expect(ok.status).toBe(201)
    const created = (await ok.json()) as { sourceAgentName: string | null; workflowId: string }
    expect(created.sourceAgentName).toBe('solo')
    expect(created.workflowId).toBe(AGENT_HOST_WORKFLOW_ID)
    const retiredNameRoute = await req('/api/agents/solo/tasks', launchPat, {
      method: 'POST',
      body: launchBody,
    })
    expect(retiredNameRoute.status).toBe(404)

    const { token: writePat } = await createPat({
      db,
      userId: bob.id,
      name: 'write-only',
      scopes: ['agents:read', 'agents:write'],
    })
    const refused = await req(`/api/agents/${soloId}/tasks`, writePat, {
      method: 'POST',
      body: launchBody,
    })
    expect(refused.status).toBe(403)
  })
})

describe('RFC-165 — workgroup exclusions (A7)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('A7a boot auto-resume NOW resumes workgroup tasks too (RFC-186 PR-2 lifted the limitation)', async () => {
    const wf = ulid()
    await db.insert(workflows).values({
      id: wf,
      name: 'wf',
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const mk = async (over: Record<string, unknown>) => {
      const id = ulid()
      await db.insert(tasks).values({
        id,
        name: 'fixture',
        workflowId: wf,
        workflowSnapshot: '{}',
        repoPath: '/tmp/x',
        worktreePath: '/tmp/x',
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status: 'interrupted',
        errorSummary: 'daemon-restart',
        inputs: '{}',
        startedAt: Date.now(),
        ...(over as object),
      } as never)
      return id
    }
    const plain = await mk({})
    const wg = await mk({ workgroupId: 'wg1' })

    const resumedIds: string[] = []
    const result = await autoResumeInterruptedTasks({
      db,
      breaker: { maxAttempts: 3, windowMs: 60_000 },
      resume: async (id: string) => {
        resumedIds.push(id)
      },
    } as never)
    // RFC-186 PR-2 (audit §5 F1): turn-engine workgroups are no longer excluded
    // from boot auto-resume — the permanent-death limitation is lifted.
    expect(resumedIds).toContain(plain)
    expect(resumedIds).toContain(wg)
    expect(result.resumed).toContain(plain)
    expect(result.resumed).toContain(wg)
  })

  test('A7c EXHAUSTIVE: every execution-reviving repair option carries revivesExecution', () => {
    // Implementation-gate P2 (round 2): the workgroup refusal is only as good
    // as the classification — an unstamped revive option (T2.resurrect was
    // the caught case) walks straight into generic resumeTask. Judge each
    // def by its SOURCE: resumeAfterApply, node-run minting, or a resurrect
    // id all mean "revives execution" and MUST be stamped.
    const dir = join(import.meta.dir, '..', 'src', 'services', 'lifecycleRepair')
    for (const file of readdirSync(dir).filter((f: string) => f.startsWith('options-'))) {
      const src = readFileSync(join(dir, file), 'utf8')
      const heads = [...src.matchAll(/const \w+: RepairOptionDef = \{/g)]
      for (let i = 0; i < heads.length; i++) {
        const start = heads[i]!.index!
        const end = i + 1 < heads.length ? heads[i + 1]!.index! : src.length
        const block = src.slice(start, end)
        const id = /id: '([^']+)'/.exec(block)?.[1] ?? '(unknown)'
        const revives =
          block.includes('resumeAfterApply') ||
          block.includes('mintNodeRun') ||
          id.includes('resurrect')
        if (revives) {
          expect(block.includes('revivesExecution: true'), `${file} ${id} must be stamped`).toBe(
            true,
          )
        }
      }
    }
  })

  test('A7b repair list marks revive options unavailable + apply refuses (workgroup task)', async () => {
    const { listRepairOptionsForAlert, applyRepairOption } =
      await import('../src/services/lifecycleRepair')
    const { lifecycleAlerts } = await import('../src/db/schema')
    const wf = ulid()
    await db.insert(workflows).values({
      id: wf,
      name: 'wf',
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'wg-task',
      workflowId: wf,
      workflowSnapshot: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
      repoPath: '/tmp/x',
      worktreePath: '/tmp/x',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
      workgroupId: 'wg1',
    })
    const alertId = ulid()
    await db.insert(lifecycleAlerts).values({
      id: alertId,
      taskId,
      rule: 'S4',
      severity: 'warn',
      detail: '{}',
      detectedAt: Date.now(),
    } as never)

    const deps = { db } as never
    const listed = await listRepairOptionsForAlert({
      db,
      taskId,
      alertId,
      actorUserId: null,
      appHome: '/tmp',
      deps,
    })
    const kick = listed.options.find((o) => o.id === 'S4.kick-task')
    expect(kick).toBeDefined()
    expect(kick!.available).toBe(false)
    expect(kick!.unavailableReasonKey).toBe('diagnose.repair.common.workgroupUnsupported')

    await expect(
      applyRepairOption({
        db,
        taskId,
        alertId,
        optionId: 'S4.kick-task',
        actorUserId: null,
        appHome: '/tmp',
        deps,
      }),
    ).rejects.toMatchObject({ code: 'workgroup-repair-unsupported' })
  })
})

// LOCKS: RFC-175 §2e — the agent-identity closure for "relaunch". A post-migration
// agent task stamps `sourceAgentId`; a relaunch carries `expectedAgentId` as an
// immediate-submit OCC guard; and an in-process reference-counted reservation
// blocks deleteAgent/renameAgent for the whole launch so a delete+recreate-
// same-name replacement can't run a different agent than the task recorded.
describe('RFC-175 §2e — agent relaunch identity guard + launch reservation', () => {
  let db: DbClient
  let appHome: string
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc175-agent-'))
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const BODY = (extra: Record<string, unknown> = {}) =>
    StartAgentTaskSchema.parse({ name: 'solo run', description: 'do it', scratch: true, ...extra })

  test('sourceAgentId persisted; expectedAgentId match launches, stale id → 409', async () => {
    const solo = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const agentId = solo.id

    // Baseline launch stamps the stable id onto the task.
    const t1 = await startAgentTask(db, daemonActor(), agentId, BODY(), { db, appHome })
    expect(t1.sourceAgentId).toBe(agentId)

    // Relaunch carrying the CORRECT expected id succeeds.
    const t2 = await startAgentTask(
      db,
      daemonActor(),
      agentId,
      BODY({ expectedAgentId: agentId }),
      {
        db,
        appHome,
      },
    )
    expect(t2.sourceAgentId).toBe(agentId)

    // Relaunch carrying a STALE id (the delete+recreate-same-name ABA the guard
    // exists to close) → 409, and no ghost task row is minted.
    await expect(
      startAgentTask(db, daemonActor(), agentId, BODY({ expectedAgentId: 'stale-other-id' }), {
        db,
        appHome,
      }),
    ).rejects.toMatchObject({ code: 'agent-id-mismatch' })
    expect((await db.select().from(tasks)).length).toBe(2)
  })

  test('reservation blocks delete until all holders release; display rename remains safe', async () => {
    const agentId = (await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })).id

    expect(isAgentLaunching(agentId)).toBe(false)
    // Two concurrent same-agent launches hold the shared id.
    acquireAgentLaunch(agentId)
    acquireAgentLaunch(agentId)
    expect(isAgentLaunching(agentId)).toBe(true)

    // Delete refuses while a launch is in flight. Rename is display-only now:
    // it keeps the exact id targeted by both launch holders.
    await expect(deleteAgent(db, agentId, T6_ACTOR)).rejects.toMatchObject({
      code: 'agent-launching',
    })
    expect(await renameAgent(db, agentId, { newName: 'solo2' })).toMatchObject({
      id: agentId,
      name: 'solo2',
    })

    // R11-F1: the FIRST holder releasing must NOT free the shared key while the
    // OTHER launch is still materializing — delete stays blocked.
    releaseAgentLaunch(agentId)
    expect(isAgentLaunching(agentId)).toBe(true)
    await expect(deleteAgent(db, agentId, T6_ACTOR)).rejects.toMatchObject({
      code: 'agent-launching',
    })

    // Only after the LAST holder releases does delete proceed.
    releaseAgentLaunch(agentId)
    expect(isAgentLaunching(agentId)).toBe(false)
    await deleteAgent(db, agentId, T6_ACTOR)
    expect(await getAgentById(db, agentId)).toBeNull()
  })
})
