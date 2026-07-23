// RFC-164 PR-3 — launch path + round engine (leader_worker backend closure).
//
// Locks:
//   - synthesized host snapshot is a VALID WorkflowDefinition with clarify
//     channels wired on BOTH host nodes (design §2);
//   - startWorkgroupTask: readiness gate (决策 #21), human-member temporary
//     guard (plan T14 — removed by PR-5), config/snapshot/two-column stamp;
//   - engine orchestration over fake hooks (no subprocesses): lw dispatch →
//     result → re-wake → done; protocol-violation retry; member clarify park;
//     max_rounds cap → failed; completion gate → awaiting_review + gate
//     holder run (lifecycle invariant, 设计门 Finding-2);
//   - prompt isolation (design §11 double lock): human user ids NEVER appear
//     in composed prompts (roster uses display names);
//   - stuck-detector S1/S2 workgroup exemption (Finding-2);
//   - source locks: runTask branches on workgroup_id before runScope;
//     renderUserPrompt REPLACES (not extends) the protocol block.

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'
import {
  agentHasClarifyChannel,
  renderUserPrompt,
  WorkflowDefinitionSchema,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import {
  agents,
  lifecycleAlerts,
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMessages,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'
import { createUser } from '../src/services/users'
import { createWorkgroup } from '../src/services/workgroups'
import {
  buildWorkgroupHostSnapshot,
  buildWorkgroupRuntimeConfig,
  ensureWorkgroupHostWorkflow,
  WG_LEADER_NODE_ID,
  WG_MEMBER_NODE_ID,
  WORKGROUP_HOST_WORKFLOW_ID,
} from '../src/services/workgroup/launch'
import {
  runWorkgroupEngine,
  type WorkgroupEngineHooks,
  type WorkgroupHostRunRequest,
  type WorkgroupHostRunResult,
} from '../src/services/workgroup/engine'
import { gateViewOf, loadWorkgroupTaskState } from '../src/services/workgroup/state'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc164-engine-test')

async function seedNamedAgent(db: DbClient, name: string): Promise<string> {
  return (
    await createAgent(db, {
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: name,
    })
  ).id
}

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: 'be kind',
    goal: 'fix payments',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'wg-planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '协调',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'wg-coder',
        userId: null,
        displayName: 'coder',
        roleDesc: '实现',
      },
      {
        id: 'm-pm',
        memberType: 'human',
        agentName: null,
        userId: 'u-pm-secret',
        displayName: 'pm',
        roleDesc: '把关',
      },
    ],
    ...overrides,
  }
}

async function seedEngineTask(
  db: DbClient,
  config: WorkgroupRuntimeConfig,
): Promise<{ taskId: string }> {
  const agentIds = new Map<string, string>()
  for (const [name, bodyMd] of [
    ['wg-planner', 'plan'],
    ['wg-coder', 'code'],
  ] as const) {
    const created = await createAgent(db, {
      name,
      description: '',
      outputs: [],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd,
    }).catch(() => null)
    const existing =
      created ?? (await db.select().from(agents).where(eq(agents.name, name)).limit(1))[0] ?? null
    if (existing !== null) agentIds.set(name, existing.id)
  }
  const canonicalConfig: WorkgroupRuntimeConfig = {
    ...config,
    members: config.members.map((member) =>
      member.memberType === 'agent' && member.agentName !== null
        ? { ...member, agentId: member.agentId ?? agentIds.get(member.agentName) }
        : member,
    ),
  }
  const taskId = ulid()
  const snapshot = buildWorkgroupHostSnapshot(canonicalConfig)
  await db.insert(workflows).values({
    id: ulid(),
    name: `host-anchor-${taskId}`,
    definition: '{}',
    builtin: true,
  })
  const workflowRow = (await db.select().from(workflows).limit(1))[0]
  await db.insert(tasks).values({
    id: taskId,
    name: 'wg-engine-task',
    workflowId: workflowRow?.id ?? ulid(),
    workflowSnapshot: JSON.stringify(snapshot),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: canonicalConfig.workgroupId,
    workgroupConfigJson: JSON.stringify(canonicalConfig),
  })
  return { taskId }
}

/** Scripted hooks: pops the next result per (nodeId) queue; records requests. */
function scriptedHooks(script: {
  leader: WorkgroupHostRunResult[]
  member: WorkgroupHostRunResult[]
}): { hooks: WorkgroupEngineHooks; requests: WorkgroupHostRunRequest[] } {
  const requests: WorkgroupHostRunRequest[] = []
  const hooks: WorkgroupEngineHooks = {
    runHostNode: (req) => {
      requests.push(req)
      const queue = req.nodeId === WG_LEADER_NODE_ID ? script.leader : script.member
      const next = queue.shift()
      if (next === undefined) {
        return Promise.resolve({
          status: 'failed',
          outputs: {},
          errorMessage: `script exhausted for ${req.nodeId}`,
        })
      }
      return Promise.resolve(next)
    },
  }
  return { hooks, requests }
}

const doneLeader = (opts: {
  assignments?: Array<{ member: string; title: string; brief: string }>
  decision: { action: 'continue' | 'done'; summary?: string }
  messages?: Array<{ to: string | null; body: string }>
}): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: {
    wg_decision: JSON.stringify(opts.decision),
    ...(opts.assignments !== undefined ? { wg_assignments: JSON.stringify(opts.assignments) } : {}),
    ...(opts.messages !== undefined ? { wg_messages: JSON.stringify(opts.messages) } : {}),
  },
})

const doneMember = (summary: string): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: { wg_result: JSON.stringify({ summary }) },
})

// RFC-215 — fc 认领执行是批 run（含单卡批）：逐卡 wg_task_results，wg_result 不再
// 是批 run 的合法端口（design §6.2 端口拆分）。lw worker 仍走上面的单对象形态。
const doneBatchMember = (...summaries: string[]): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: {
    wg_task_results: JSON.stringify(summaries.map((summary, i) => ({ task: i + 1, summary }))),
  },
})

// ---------------------------------------------------------------------------
// host snapshot
// ---------------------------------------------------------------------------

describe('RFC-164 engine — host snapshot', () => {
  test('parses as a WorkflowDefinition; clarify channel wired on BOTH host nodes', () => {
    const snapshot = buildWorkgroupHostSnapshot(cfg())
    const def = WorkflowDefinitionSchema.parse(snapshot)
    expect(def.nodes.map((n) => n.id).sort()).toEqual(
      [WG_LEADER_NODE_ID, WG_MEMBER_NODE_ID, '__wg_clarify__'].sort(),
    )
    expect(agentHasClarifyChannel(def, WG_LEADER_NODE_ID)).toBe(true)
    expect(agentHasClarifyChannel(def, WG_MEMBER_NODE_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// launch path (HTTP)
// ---------------------------------------------------------------------------

describe('RFC-164 engine — launch path', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let token: string
  let a1Id: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedTestDefaultOpencodeRuntime(db)
    app = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-rfc164-engine-config.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const u = await createUser(db, {
      username: 'alice',
      displayName: 'alice',
      role: 'user',
      password: 'longEnoughPassword',
    })
    token = (await createSession({ db, userId: u.id })).token
    a1Id = await seedNamedAgent(db, 'a1')
  })

  async function req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  test('builtin host workflow row is lazily ensured (idempotent; NOT migration-seeded)', async () => {
    // fresh DB stays clean — empty-fixture expectations elsewhere depend on it
    const before = await db.select().from(workflows)
    expect(before.some((w) => w.id === WORKGROUP_HOST_WORKFLOW_ID)).toBe(false)
    await ensureWorkgroupHostWorkflow(db)
    await ensureWorkgroupHostWorkflow(db) // idempotent
    const rows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, WORKGROUP_HOST_WORKFLOW_ID))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.name).toBe('__workgroup_host__')
    expect(rows[0]?.builtin).toBe(true)
  })

  test('not launch-ready (leaderless lw) → 422 workgroup-not-ready with reasons', async () => {
    const group = await createWorkgroup(db, {
      name: 'no-leader',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1Id, displayName: 'a1', roleDesc: '' }],
    })
    const res = await req(`/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g' }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string; details?: { reasons?: string[] } }
    expect(body.code).toBe('workgroup-not-ready')
    expect(body.details?.reasons).toEqual(['leader-missing'])
    const retiredNameRoute = await req(`/api/workgroups/${group.name}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g' }),
    })
    expect(retiredNameRoute.status).toBe(404)
  })

  test('RFC-225 exact handoff rejects a stale workgroup version before task materialization', async () => {
    const group = await createWorkgroup(db, {
      name: 'version-fenced',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1Id, displayName: 'lead', roleDesc: '' }],
    })
    const res = await req(`/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 't',
        goal: 'g',
        scratch: true,
        expectedWorkgroupVersion: group.version + 1,
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      code: string
      details?: { expectedVersion: number; currentVersion: number }
    }
    expect(body).toMatchObject({
      code: 'workgroup-version-conflict',
      details: { expectedVersion: 2, currentVersion: 1 },
    })
    expect(await db.select().from(tasks)).toHaveLength(0)
    expect(
      (await db.select().from(workflows)).some((row) => row.id === WORKGROUP_HOST_WORKFLOW_ID),
    ).toBe(false)
  })

  test('上线前加固：deleted roster agent blocks launch before task/host materialization', async () => {
    const deletedAgentId = await seedNamedAgent(db, 'deleted-agent')
    const group = await createWorkgroup(db, {
      name: 'dangling-agent',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'ghost',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [
        { memberType: 'agent', agentId: deletedAgentId, displayName: 'ghost', roleDesc: '' },
      ],
    })
    await db.delete(agents).where(eq(agents.id, deletedAgentId))
    const res = await req(`/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g', scratch: true }),
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      code: string
      details?: { reasons?: string[]; missingAgentNames?: string[] }
    }
    expect(body.code).toBe('workgroup-not-ready')
    expect(body.details?.reasons).toEqual(['agent-missing'])
    expect(body.details?.missingAgentNames).toEqual(['deleted-agent'])
    expect(await db.select().from(tasks)).toHaveLength(0)
    expect(
      (await db.select().from(workflows)).some((w) => w.id === WORKGROUP_HOST_WORKFLOW_ID),
    ).toBe(false)
  })

  // RFC-167 PR-2③: the PR-1 staged guard is GONE — dynamic_workflow groups
  // launch into the generate→confirm→execute engine. Full launch coverage
  // (snapshot/dw stamp/engine entry) lives in rfc167-dynamic-workflow-engine
  // .test.ts; here we lock only that the old guard never fires again.
  test('dynamic_workflow launch passes the old PR-1 guard (RFC-167 撤守卫回归锁)', async () => {
    const group = await createWorkgroup(db, {
      name: 'dyn',
      description: '',
      instructions: '',
      mode: 'dynamic_workflow',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1Id, displayName: 'a1', roleDesc: '' }],
    })
    const res = await req(`/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g' }),
    })
    // No repo source in the body → the launch still 422s at StartTaskSchema,
    // which proves the flow got PAST the removed dynamic guard.
    const body = (await res.json()) as { code?: string }
    expect(body.code).not.toBe('workgroup-dynamic-not-implemented')
    expect(body.code).toBe('workgroup-launch-invalid')
  })

  test('human-member groups launch past the gate (PR-5/T24 撤守卫回归锁)', async () => {
    const u = await createUser(db, {
      username: 'pm',
      displayName: 'pm',
      role: 'user',
      password: 'longEnoughPassword',
    })
    const group = await createWorkgroup(db, {
      name: 'with-human',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [
        { memberType: 'agent', agentId: a1Id, displayName: 'lead', roleDesc: '' },
        { memberType: 'human', userId: u.id, displayName: 'pm', roleDesc: '' },
      ],
    })
    const res = await req(`/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g' }),
    })
    // The old temporary guard must NOT fire; whatever the launch outcome is
    // (here it proceeds into worktree materialization against a fake repo),
    // it is not the human-members rejection.
    const body = (await res.json()) as { code?: string }
    expect(body.code).not.toBe('workgroup-human-members-unsupported')
  })

  test('resolveWorkgroupCollaborators: human members ∪ explicit, deduped (PR-5/T24 接线回归锁)', async () => {
    // Pure-fn unit test instead of a full launch: startWorkgroupTask feeds this
    // result to startTask as collaboratorUserIds so human members become task
    // members (the answer boundary for clarifies/reviews — RFC-099 / proposal
    // 目标 6). A real launch would need a repo source and couple the test to
    // the concurrent RFC-165 space-schema migration (scratch/repoUrl), so we
    // lock the wiring at the pure boundary.
    const { resolveWorkgroupCollaborators } = await import('../src/services/workgroup/launch')
    const members = [
      { memberType: 'agent' as const, userId: null },
      { memberType: 'human' as const, userId: 'u-pm' },
      { memberType: 'human' as const, userId: 'u-qa' },
    ]
    // human ids appended to explicit, order-stable, deduped
    expect(resolveWorkgroupCollaborators(['u-ext'], members)).toEqual(['u-ext', 'u-pm', 'u-qa'])
    // explicit already containing a human id does not duplicate it
    expect(resolveWorkgroupCollaborators(['u-pm'], members)).toEqual(['u-pm', 'u-qa'])
    // no explicit → just the human members
    expect(resolveWorkgroupCollaborators(undefined, members)).toEqual(['u-pm', 'u-qa'])
    // agent-only group → empty
    expect(
      resolveWorkgroupCollaborators(undefined, [{ memberType: 'agent', userId: null }]),
    ).toEqual([])
  })

  test('invalid launch payload (no repo source) → 422 via StartTaskSchema single-sourcing', async () => {
    const group = await createWorkgroup(db, {
      name: 'ready-group',
      description: '',
      instructions: '',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 5,
      completionGate: false,
      members: [{ memberType: 'agent', agentId: a1Id, displayName: 'lead', roleDesc: '' }],
    })
    const res = await req(`/api/workgroups/${group.id}/tasks`, {
      method: 'POST',
      body: JSON.stringify({ name: 't', goal: 'g' }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('workgroup-launch-invalid')
  })
})

// ---------------------------------------------------------------------------
// engine orchestration (fake hooks — no subprocesses)
// ---------------------------------------------------------------------------

describe('RFC-164 engine — lw round orchestration', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('happy path: dispatch → member result → leader re-wake → done', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        doneLeader({
          assignments: [{ member: 'coder', title: 'do-x', brief: 'do x well' }],
          decision: { action: 'continue' },
          messages: [{ to: null, body: 'kickoff note' }],
        }),
        doneLeader({ decision: { action: 'done', summary: 'all shipped' } }),
      ],
      member: [doneMember('x is done')],
    })

    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    // three runs: leader, member, leader
    expect(requests.map((r) => r.nodeId)).toEqual([
      WG_LEADER_NODE_ID,
      WG_MEMBER_NODE_ID,
      WG_LEADER_NODE_ID,
    ])
    // member run carried the assignment brief + worker protocol
    const memberReq = requests[1]
    expect(memberReq?.promptTemplate).toContain('do x well')
    expect(memberReq?.workgroupProtocolBlock).toContain('CANNOT delegate')
    // leader turn 2 saw the member result via the ledger/new-activity block
    expect(requests[2]?.promptTemplate).toContain('x is done')

    const assignments = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(assignments).toHaveLength(1)
    expect(assignments[0]?.status).toBe('done')
    expect(assignments[0]?.resultMessageId).toBeTruthy()

    const messages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    const kinds = messages.map((m) => m.kind).sort()
    expect(kinds).toContain('dispatch')
    expect(kinds).toContain('result')
    expect(kinds).toContain('decision')
    expect(kinds).toContain('chat') // blackboard kickoff note

    // borrowing columns on the member run (agentOverrideName + shardKey)
    const memberRuns = await db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.nodeId, WG_MEMBER_NODE_ID))
    expect(memberRuns).toHaveLength(1)
    expect(memberRuns[0]?.agentOverrideName).toBe('wg-coder')
    expect(memberRuns[0]?.shardKey).toBe(assignments[0]?.id ?? '')
    expect(memberRuns[0]?.rerunCause).toBe('wg-assignment')
  })

  test('leader protocol violation retries once with error notice, then succeeds', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        { status: 'done', outputs: { wg_decision: 'not json' } },
        doneLeader({ decision: { action: 'done', summary: 'ok' } }),
      ],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.promptTemplate).toContain('Protocol errors in your previous reply')
  })

  test('persistent leader protocol violation → task failed (no hot loop)', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks } = scriptedHooks({
      leader: [
        { status: 'done', outputs: {} },
        { status: 'done', outputs: {} },
      ],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('failed')
    expect(result.detail?.summary).toContain('leader')
  })

  // Regression: task 01KXBATKFJ73MDYNM6YN2DMA29 (2026-07-12). The leader CHOSE
  // to ask a human but mis-formatted the <workflow-clarify> body (prose, not
  // JSON), so runHostNode returned a `clarify-questions-malformed` failure.
  // Pre-fix, driveLeaderTurn threw on ANY failed status → reportFatal → the
  // WHOLE task died at round 0 with ZERO retries. Post-fix, a clarify-questions-*
  // failure folds into the WG_PROTOCOL_RETRIES re-prompt loop (symmetric to the
  // malformed-output-port path), so a single formatting slip is recoverable.
  test('leader malformed <workflow-clarify> retries with a notice instead of fatally failing the task', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        {
          status: 'failed',
          outputs: {},
          // RFC-186: retry-vs-fatal now routes on the structured failureCode
          // (FOLLOWUP_POLICY), not an errorMessage prefix — the real runHostNode
          // always stamps it, so the mock must too.
          failureCode: 'clarify-questions-malformed',
          errorMessage:
            'clarify-questions-malformed: JSON.parse failed: JSON Parse error: Unexpected identifier "The"',
        },
        doneLeader({ decision: { action: 'done', summary: 'ok' } }),
      ],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.promptTemplate).toContain('Protocol errors in your previous reply')
    expect(requests[1]?.promptTemplate).toContain('<workflow-clarify> reply was malformed')
  })

  // The retry budget is bounded: a leader that keeps mis-formatting its clarify
  // still hard-fails once WG_PROTOCOL_RETRIES is exhausted (no infinite re-prompt
  // hot loop) — the fatal path stays reachable, just no longer on the FIRST slip.
  test('persistent malformed <workflow-clarify> hard-fails after the retry budget', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    // RFC-186: budget is WG_PROTOCOL_RETRIES (3) → attempts 0..3 (4 host runs),
    // the last of which exhausts the budget and throws. Script 4 malformed
    // failures (with structured failureCode) so the BUDGET, not the script, is
    // what finally fatals it.
    const malformed = {
      status: 'failed' as const,
      outputs: {},
      failureCode: 'clarify-questions-malformed' as const,
      errorMessage: 'clarify-questions-malformed: prose again',
    }
    const { hooks } = scriptedHooks({
      leader: [malformed, malformed, malformed, malformed],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('failed')
    expect(result.detail?.summary).toContain('leader')
  })

  test('member clarify park → assignment awaiting_human + engine parks awaiting_human', async () => {
    const config = cfg()
    const { taskId } = await seedEngineTask(db, config)
    const { hooks } = scriptedHooks({
      leader: [
        doneLeader({
          assignments: [{ member: 'coder', title: 'do-x', brief: 'b' }],
          decision: { action: 'continue' },
        }),
      ],
      member: [{ status: 'awaiting', outputs: {}, clarifyQuestionCount: 1 }],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_human')
    const a = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.taskId, taskId))
    )[0]
    expect(a?.status).toBe('awaiting_human')
  })

  // RFC-187 §3-7 — updated from the old "cap → hard failed" lock. Hitting the cap WITH
  // completed work no longer hard-fails: the leader gets exactly ONE grace wrap-up round
  // to aggregate/declare done (probe C produced hello.txt then the task `failed` maxRounds:1
  // with that file in canonical). A genuine no-work spin still fails (unit-covered in
  // rfc187-maxrounds-wrapup.test.ts: decideWorkgroupOutcome capExceeded + no work → failed).
  test('§3-7 max_rounds grace wrap-up: completed work at the cap → ONE wrap-up round → done', async () => {
    const config = cfg({ maxRounds: 1 })
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        // round 1 (the only budgeted round): dispatch, don't declare done yet.
        doneLeader({
          assignments: [{ member: 'coder', title: 'do-x', brief: 'b' }],
          decision: { action: 'continue' },
        }),
        // the grace wrap-up round the cap now grants: aggregate + declare done.
        doneLeader({ decision: { action: 'done', summary: 'wrapped up at the cap' } }),
      ],
      member: [doneMember('did the work')],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    // NOT failed — the deliverable-in-hand task wrapped up.
    expect(result.kind).toBe('ok')
    // exactly ONE grace round: 2 leader runs (dispatch + wrap-up), never a 3rd.
    expect(requests.filter((r) => r.nodeId === WG_LEADER_NODE_ID)).toHaveLength(2)
    const sys = (
      await db.select().from(workgroupMessages).where(eq(workgroupMessages.taskId, taskId))
    ).filter((m) => m.kind === 'system')
    expect(sys.some((m) => m.bodyMd.includes('max_rounds'))).toBe(false)
  })

  // RFC-187 §3-3 — an in-place protocol retry mints a fresh leader run, but it's the
  // SAME logical round: tagged wg-protocol-retry and excluded from the round count so a
  // fumbled turn doesn't burn multiple max_rounds (RFC-186 raised retries 1→3).
  test('§3-3 protocol retries mint wg-protocol-retry rows that do not count as rounds', async () => {
    const config = cfg({ maxRounds: 8 })
    const { taskId } = await seedEngineTask(db, config)
    const { hooks } = scriptedHooks({
      leader: [
        // round 1 fumbles the envelope ONCE (retryable), then dispatches on the retry.
        {
          status: 'failed',
          outputs: {},
          errorMessage: 'no <workflow-output> envelope',
          failureCode: 'envelope-missing',
        },
        doneLeader({
          assignments: [{ member: 'coder', title: 'x', brief: 'b' }],
          decision: { action: 'continue' },
        }),
        doneLeader({ decision: { action: 'done', summary: 'done' } }),
      ],
      member: [doneMember('did it')],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // the in-place retry row is tagged wg-protocol-retry (excluded from the count)...
    expect(runs.filter((r) => r.rerunCause === 'wg-protocol-retry')).toHaveLength(1)
    // ...and the two LOGICAL leader rounds keep the wg-leader-round cause.
    expect(runs.filter((r) => r.rerunCause === 'wg-leader-round')).toHaveLength(2)
  })

  test('completion gate: decision done → awaiting_review + gate holder run (invariant)', async () => {
    const config = cfg({ completionGate: true })
    const { taskId } = await seedEngineTask(db, config)
    const { hooks } = scriptedHooks({
      leader: [doneLeader({ decision: { action: 'done', summary: 'ready for review' } })],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    // gate holder run satisfies "task awaiting_review ⟹ ∃ awaiting_review node_run"
    const gateRuns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'wg-gate',
    )
    expect(gateRuns).toHaveLength(1)
    expect(gateRuns[0]?.status).toBe('awaiting_review')
    // RFC-217 T2 — gate state persisted in workgroup_task_state (the config
    // column no longer carries runtime slots).
    const st = await loadWorkgroupTaskState(db, taskId)
    expect(st.gateStatus).toBe('awaiting_confirmation')
    expect(gateViewOf(st).awaitingConfirmation).toBe(true)
    expect(gateViewOf(st).declaredDone).toBe(true)
  })

  test('prompt isolation (design §11): human user ids never reach any prompt', async () => {
    const config = cfg() // includes human member with userId 'u-pm-secret'
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        doneLeader({
          assignments: [{ member: 'coder', title: 'do-x', brief: 'b' }],
          decision: { action: 'continue' },
        }),
        doneLeader({ decision: { action: 'done', summary: 's' } }),
      ],
      member: [doneMember('r')],
    })
    await runWorkgroupEngine({ db, taskId, log, hooks })
    for (const r of requests) {
      expect(r.promptTemplate).not.toContain('u-pm-secret')
      expect(r.workgroupProtocolBlock).not.toContain('u-pm-secret')
      // the human member IS visible by display name
      expect(r.promptTemplate).toContain('@pm')
    }
  })
})

// ---------------------------------------------------------------------------
// stuck-detector exemption (Finding-2)
// ---------------------------------------------------------------------------

describe('RFC-164 engine — stuck detector S1/S2 workgroup exemption', () => {
  test('workgroup awaiting_review task: no S1 alert; plain task still alerts', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const old = Date.now() - 2 * 60 * 60 * 1000
    async function seedTask(workgroup: boolean): Promise<string> {
      const id = ulid()
      const wfId = ulid()
      await db.insert(workflows).values({ id: wfId, name: `wf-${id}`, definition: '{}' })
      await db.insert(tasks).values({
        id,
        name: workgroup ? 'wg-parked' : 'plain-parked',
        workflowId: wfId,
        workflowSnapshot: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
        repoPath: '/tmp/x',
        worktreePath: '/tmp/x-wt',
        baseBranch: 'main',
        branch: `agent-workflow/${id}`,
        status: 'awaiting_review',
        inputs: '{}',
        startedAt: old,
        ...(workgroup ? { workgroupId: 'wg1', workgroupConfigJson: '{}' } : {}),
      })
      return id
    }
    const wgTask = await seedTask(true)
    const plainTask = await seedTask(false)
    await runStuckTaskDetector({ db, now: () => Date.now() })
    const alerts = await db.select().from(lifecycleAlerts)
    const byTask = (id: string) => alerts.filter((a) => a.taskId === id && a.rule === 'S1')
    expect(byTask(wgTask)).toHaveLength(0)
    expect(byTask(plainTask).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// source locks
// ---------------------------------------------------------------------------

describe('RFC-164 engine — source locks', () => {
  const SCHEDULER_SRC = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const PROMPT_SRC = readFileSync(
    resolve(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts'),
    'utf8',
  )

  test('runTask branches to the workgroup engine BEFORE runScope (never frontier)', () => {
    expect(SCHEDULER_SRC).toContain('isWorkgroupTask(task)')
    expect(SCHEDULER_SRC).toContain('runWorkgroupEngine(')
  })

  test('renderUserPrompt: workgroup protocol REPLACES the agent-outputs block (else-if chain)', () => {
    expect(PROMPT_SRC).toContain('} else if (input.workgroupProtocolBlock !== undefined) {')
    // and the workgroup branch never concatenates buildProtocolBlock
    const branch = PROMPT_SRC.split('} else if (input.workgroupProtocolBlock !== undefined) {')[1]
    const body = branch?.split('} else {')[0] ?? ''
    expect(body).not.toContain('buildProtocolBlock')
  })

  test('renderUserPrompt end-to-end: workgroup block replaces port list', () => {
    const out = renderUserPrompt({
      promptTemplate: 'hello',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['legacy_port'],
      workgroupProtocolBlock: '## WG PROTOCOL SENTINEL',
    })
    expect(out).toContain('## WG PROTOCOL SENTINEL')
    expect(out).not.toContain('legacy_port')
  })

  // Round-trip (Codex review P1): a workgroup host run is dispatched with clarify
  // directive 'delegated' (RFC-183; was 'suppressed' before the reject fold —
  // both render byte-identically). When it is a clarify-answer rerun, runHostNode
  // passes the answered `## Clarify Q&A` as clarifyContext. This locks that
  // renderUserPrompt emits that block (in `sections`) ALONGSIDE the workgroup
  // protocol (which still owns `trailing`) — the 'delegated' directive is neither
  // mandatory nor optional, so it never flips the run into clarify-only mode that
  // would steal `trailing`.
  test('renderUserPrompt: delegated workgroup run renders answered Clarify Q&A ALONGSIDE the wg protocol', () => {
    const out = renderUserPrompt({
      promptTemplate: 'hello',
      inputs: {},
      meta: { repoPath: '/r', baseBranch: 'main', taskId: 't' },
      agentOutputs: ['legacy_port'],
      workgroupProtocolBlock: '## WG PROTOCOL SENTINEL',
      clarifyChannel: { kind: 'self', directive: 'delegated', injectStopNotice: false },
      clarifyContext: { flatBlock: '## Clarify Q&A\n- board size? → 20x20' },
    })
    // the human's answers reach the agent …
    expect(out).toContain('## Clarify Q&A')
    expect(out).toContain('20x20')
    // … and the workgroup protocol still owns the trailing block …
    expect(out).toContain('## WG PROTOCOL SENTINEL')
    // … and the run did NOT flip into mandatory clarify-only ask-back mode.
    expect(out).not.toContain('MANDATORY ASK-BACK')
  })

  // Source lock for the runHostNode wiring that the fake-hook engine tests can't
  // exercise (real runHostNode spawns a subprocess). Locks that a host run fetches
  // the answered clarify queue and threads it as clarifyContext into runNode —
  // remove either and the workgroup clarify answer silently stops round-tripping.
  test('runHostNode round-trips a human clarify answer into a host rerun prompt, shard-scoped', () => {
    // host path selects by req.nodeId/req.nodeRunId (the adopted clarify-answer
    // rerun row) — unique to runHostNode; the normal scheduler path uses node.id.
    expect(SCHEDULER_SRC).toContain('consumerNodeId: req.nodeId')
    expect(SCHEDULER_SRC).toContain('dispatchedRunId: req.nodeRunId')
    // …and threads the answered queue into the host node's runNode call.
    expect(SCHEDULER_SRC).toContain('clarifyContext: { flatBlock: clarifyQueue.block }')
    // RFC-172 (route 2, R2-T7): injection is now for EVERY host node, SCOPED to the run's shard —
    // leader (shardKey=null) passes undefined (node-scoped = pre-route-2 behavior); a member passes
    // its assignment shard so concurrent members never cross-contaminate (selectAgentQueue / R2-T3).
    expect(SCHEDULER_SRC).toContain('shardKey: runShardKey === null ? undefined : runShardKey')
  })

  test('runHostNode ENABLES member clarify — no leader-only reject; shardKey-aware generation (R2-T6/T7)', () => {
    // The interim `clarify-not-supported` reject that guarded the unwired member path is REMOVED —
    // member human ask-back is now a first-class, shard-isolated round-trip (S0–S3, R2-T3, R2-T7).
    expect(SCHEDULER_SRC).not.toContain('clarify-not-supported')
    // …and the host clarify GENERATION is now shardKey-aware (R2-T6: a member's/leader's 2nd round
    // no longer shares the 1st's clarify node_run), not the old hardcoded round index 0.
    // (RFC-217 T9: createClarifyRound's unified arg name is `iteration`.)
    expect(SCHEDULER_SRC).toContain('iteration: askingGeneration')
  })
})

// ---------------------------------------------------------------------------
// runtime config freeze
// ---------------------------------------------------------------------------

describe('RFC-164 engine — buildWorkgroupRuntimeConfig', () => {
  test('freezes resource group + goal into the runtime copy', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const a1Id = await seedNamedAgent(db, 'a1')
    const a2Id = await seedNamedAgent(db, 'a2')
    const group = await createWorkgroup(db, {
      name: 'freeze-me',
      description: '',
      instructions: 'charter',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: true, blackboard: false },
      maxRounds: 7,
      completionGate: true,
      members: [
        { memberType: 'agent', agentId: a1Id, displayName: 'lead', roleDesc: 'r1' },
        { memberType: 'agent', agentId: a2Id, displayName: 'dev', roleDesc: 'r2' },
      ],
    })
    const config = buildWorkgroupRuntimeConfig(group, 'the goal')
    expect(config.goal).toBe('the goal')
    expect(config.workgroupName).toBe('freeze-me')
    expect(config.maxRounds).toBe(7)
    expect(config.completionGate).toBe(true)
    expect(config.members).toHaveLength(2)
    expect(config.leaderMemberId).toBe(group.leaderMemberId)
  })
})

// ---------------------------------------------------------------------------
// PR-6 — free_collab end to end (fake hooks)
// ---------------------------------------------------------------------------

describe('RFC-164 engine — free_collab orchestration', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  const fcCfg = (): WorkgroupRuntimeConfig =>
    cfg({
      mode: 'free_collab',
      leaderMemberId: null,
      switches: { shareOutputs: false, directMessages: false, blackboard: false },
      members: [
        {
          id: 'm-a',
          memberType: 'agent',
          agentName: 'wg-planner',
          userId: null,
          displayName: 'alpha',
          roleDesc: '',
        },
        {
          id: 'm-b',
          memberType: 'agent',
          agentName: 'wg-coder',
          userId: null,
          displayName: 'beta',
          roleDesc: '',
        },
      ],
    })

  test('initial burst → tasks_add (dup dropped) → platform claims → results → converge + summary', async () => {
    const { taskId } = await seedEngineTask(db, fcCfg())
    // 两个成员的初始规划轮各加任务；beta 的第二条与 alpha 的重复（归一化撞 key）
    const memberScript: WorkgroupHostRunResult[] = [
      {
        status: 'done',
        outputs: {
          wg_tasks_add: JSON.stringify([{ title: 'Fix Login-Flow!', brief: 'do a' }]),
        },
      },
      {
        status: 'done',
        outputs: {
          wg_tasks_add: JSON.stringify([
            { title: 'fix login flow', brief: 'dup of a' },
            { title: 'clean TODOs', brief: 'do b' },
          ]),
        },
      },
      // 认领执行两条任务
      doneBatchMember('login flow fixed'),
      doneBatchMember('todos cleaned'),
    ]
    const { hooks, requests } = scriptedHooks({ leader: [], member: memberScript })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    // 全部请求都在 member host 上（无 leader）
    expect(requests.every((r) => r.nodeId === WG_MEMBER_NODE_ID)).toBe(true)
    // 首轮两个成员 + 两次认领执行 = 4 次
    expect(requests).toHaveLength(4)
    // 首轮协议是 fc_member 版（含 tasks_add + 查重纪律）
    expect(requests[0]?.workgroupProtocolBlock).toContain('wg_tasks_add')

    const assignments = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    // 3 条提案 - 1 条重复 = 2 张卡，且全部 done
    expect(assignments).toHaveLength(2)
    expect(assignments.every((a) => a.status === 'done')).toBe(true)
    expect(assignments.every((a) => a.source === 'self_claim')).toBe(true)

    const messages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    // 去重系统告警存在
    expect(messages.some((m) => m.kind === 'system' && m.bodyMd.includes('duplicate'))).toBe(true)
    // 收敛总结（decision 消息）存在且列出两条任务
    const summary = messages.find((m) => m.kind === 'decision')
    expect(summary?.bodyMd).toContain('free-collab converged')
    expect(summary?.bodyMd).toContain('login flow fixed')
    expect(summary?.bodyMd).toContain('todos cleaned')
  })

  test('fc gate: converge with completionGate on → awaiting_review + holder run', async () => {
    // RFC-207 — the gate only exists when someone can confirm it, i.e. when the
    // roster holds a human. An agent-only fc group finishes directly.
    const base = fcCfg()
    const { taskId } = await seedEngineTask(db, {
      ...base,
      completionGate: true,
      members: [
        ...base.members,
        {
          id: 'm-human',
          memberType: 'human' as const,
          agentName: null,
          userId: 'u-1',
          displayName: 'owner',
          roleDesc: '',
        },
      ],
    })
    const { hooks } = scriptedHooks({
      leader: [],
      member: [
        {
          status: 'done',
          outputs: { wg_tasks_add: JSON.stringify([{ title: 't1', brief: 'b' }]) },
        },
        { status: 'done', outputs: {} }, // 第二个成员首轮无提案
        doneBatchMember('t1 done'),
      ],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'wg-gate',
    )
    expect(holders).toHaveLength(1)
    expect(holders[0]?.status).toBe('awaiting_review')
  })

  test('fc approved gate on resume → ok (confirm 端点写入 approved 后重入)', async () => {
    const config = { ...fcCfg(), completionGate: true }
    const { taskId } = await seedEngineTask(db, config)
    // 模拟 PR-5 confirm approve 之后的状态：清单已收敛 + gate approved
    const aId = ulid()
    await db.insert(workgroupAssignments).values({
      id: aId,
      taskId,
      round: 1,
      source: 'self_claim',
      assigneeMemberId: 'm-a',
      title: 't1',
      briefMd: 'b',
      status: 'done',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await db
      .update(tasks)
      .set({
        workgroupConfigJson: JSON.stringify({
          ...config,
          gate: {
            declaredDone: true,
            awaitingConfirmation: false,
            rejected: false,
            approved: true,
          },
        }),
      })
      .where(eq(tasks.id, taskId))
    const { hooks } = scriptedHooks({ leader: [], member: [] })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
  })
})

// RFC-176: goal is a mode-routed directive, not all-members charter context.
// Locks the two fixes: (1) injection scope — leader_worker routes the goal to
// the leader ONLY (workers act on the assignment brief), free_collab to every
// member; (2) launch kickoff — the engine seeds the goal into the room ONCE as
// an opening directive (leader-DIRECTED in lw so workers never see it; PUBLIC in
// fc), so the leader's first turn has actionable content and the room is not
// empty. Root cause it closes: goal rode the all-members charter block AND a
// `continue` leader turn posts nothing, so a fresh room looked empty until a
// human typed (workgroupRunner.ts:1013-1033 / workgroupWake.ts:229).
describe('RFC-176 — goal directive injection & launch kickoff', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  const kickoffs = async (taskId: string) =>
    (await db.select().from(workgroupMessages).where(eq(workgroupMessages.taskId, taskId))).filter(
      (m) => m.authorKind === 'system' && m.kind === 'chat' && m.bodyMd === 'fix payments',
    )

  test('leader_worker: leader-directed kickoff + goal block; worker never sees the goal', async () => {
    const { taskId } = await seedEngineTask(db, cfg())
    const { hooks, requests } = scriptedHooks({
      leader: [
        doneLeader({
          assignments: [{ member: 'coder', title: 'task-1', brief: 'do the work' }],
          decision: { action: 'continue' },
        }),
        doneLeader({ decision: { action: 'done', summary: 'shipped' } }),
      ],
      member: [doneMember('work done')],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    // Leader turn 1 carries the goal (persistent block + kickoff in new-activity)
    // so it dispatches immediately — no human nudge needed.
    expect(requests[0]?.nodeId).toBe(WG_LEADER_NODE_ID)
    expect(requests[0]?.promptTemplate).toContain('## Group goal')
    expect(requests[0]?.promptTemplate).toContain('fix payments')

    // The worker's assignment turn never sees the goal — only the leader's brief.
    const memberReq = requests.find((r) => r.nodeId === WG_MEMBER_NODE_ID)
    expect(memberReq).toBeDefined()
    expect(memberReq?.promptTemplate).not.toContain('## Group goal')
    expect(memberReq?.promptTemplate).not.toContain('fix payments')

    // Exactly one kickoff: system chat directed to the leader (non-public).
    const seeds = await kickoffs(taskId)
    expect(seeds).toHaveLength(1)
    expect(JSON.parse(seeds[0]?.mentionsJson ?? '[]')).toEqual(['m-lead'])

    // P1 regression: a FRESH launch room is NOT empty (the exact symptom) — the
    // goal is visible AND the leader dispatched, with zero human messages.
    const all = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(all.some((m) => m.kind === 'chat' && m.bodyMd === 'fix payments')).toBe(true)
    expect(all.some((m) => m.kind === 'dispatch')).toBe(true)
    expect(all.every((m) => m.authorKind !== 'human')).toBe(true)
  })

  test('kickoff is seeded exactly once — a re-entered engine does not double-post', async () => {
    const { taskId } = await seedEngineTask(db, cfg())
    await runWorkgroupEngine({
      db,
      taskId,
      log,
      hooks: scriptedHooks({
        leader: [doneLeader({ decision: { action: 'done', summary: 'done' } })],
        member: [],
      }).hooks,
    })
    // Second entry (crash-recovery / resume): the empty-room guard is now false.
    await runWorkgroupEngine({
      db,
      taskId,
      log,
      hooks: scriptedHooks({ leader: [], member: [] }).hooks,
    })
    expect(await kickoffs(taskId)).toHaveLength(1)
  })

  test('free_collab: public kickoff; every member turn carries the goal block', async () => {
    const fcCfg: WorkgroupRuntimeConfig = cfg({
      mode: 'free_collab',
      leaderMemberId: null,
      switches: { shareOutputs: false, directMessages: false, blackboard: false },
      members: [
        {
          id: 'm-a',
          memberType: 'agent',
          agentName: 'wg-planner',
          userId: null,
          displayName: 'alpha',
          roleDesc: '',
        },
        {
          id: 'm-b',
          memberType: 'agent',
          agentName: 'wg-coder',
          userId: null,
          displayName: 'beta',
          roleDesc: '',
        },
      ],
    })
    const { taskId } = await seedEngineTask(db, fcCfg)
    const { hooks, requests } = scriptedHooks({
      leader: [],
      member: [
        {
          status: 'done',
          outputs: { wg_tasks_add: JSON.stringify([{ title: 't-a', brief: 'do a' }]) },
        },
        {
          status: 'done',
          outputs: { wg_tasks_add: JSON.stringify([{ title: 't-b', brief: 'do b' }]) },
        },
        doneBatchMember('a done'),
        doneBatchMember('b done'),
      ],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    // No leader — every member owns the goal, so all member turns carry the block.
    expect(requests.length).toBeGreaterThan(0)
    expect(requests.every((r) => r.promptTemplate.includes('## Group goal'))).toBe(true)
    expect(requests[0]?.promptTemplate).toContain('fix payments')

    // Kickoff is public (no mention) ⇒ reaches all members via the blackboard.
    const seeds = await kickoffs(taskId)
    expect(seeds).toHaveLength(1)
    expect(JSON.parse(seeds[0]?.mentionsJson ?? '[]')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// RFC-181 C — 反问硬压制的引擎收场（drop-and-continue，绝不 park）
// (design/RFC-181-workgroup-autonomous-hardening/design.md §2.2)
// runNode 层的 clarify-forbidden 持久拒绝由 RFC-123 既有测试覆盖；此处锁
// workgroupRunner 对该失败的重试/收场 + clarifyEnabled 透传。调度架构审视
// 2026-07-14：引擎改按结构化 failureCode 路由（RFC-145 棘轮），夹具随真实
// 生产路径（runNode 拒绝 + hook lateSuppress 均带 failureCode）同步携码。
// ---------------------------------------------------------------------------

describe('RFC-181 C — clarify 压制收场（fake hooks）', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  const cfSuppressed: WorkgroupHostRunResult = {
    status: 'failed',
    outputs: {},
    errorMessage:
      'clarify-forbidden: node is in STOP CLARIFYING mode; emit <workflow-output>, not <workflow-clarify>',
    failureCode: 'clarify-forbidden',
  }

  test('leader：压制重提示 → 耗尽 drop-and-continue（不 throw、不 park）→ nudge 后收敛 done', async () => {
    // RFC-207 — suppression is now driven by the roster: strip the human so
    // ask-back is off (the RFC-181 `autonomous: true` this replaced meant the
    // same thing). With a human present the leader would legitimately be invited.
    const base = cfg({ completionGate: false })
    const config = {
      ...base,
      members: base.members.filter((m) => m.memberType === 'agent'),
    }
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      // WG_PROTOCOL_RETRIES=1 → 2 次压制尝试后 drop；leader 空转 nudge
      // 重新唤醒 leader，第三个脚本收敛 done。
      leader: [
        cfSuppressed,
        cfSuppressed,
        doneLeader({ decision: { action: 'done', summary: 'decided alone' } }),
      ],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    const leaderReqs = requests.filter((r) => r.nodeId === WG_LEADER_NODE_ID)
    expect(leaderReqs).toHaveLength(3)
    // RFC-181：三处调用点都以最新 config 透传 clarifyEnabled=false。
    expect(leaderReqs.every((r) => r.clarifyEnabled === false)).toBe(true)
    // 第二次尝试的 re-prompt 带压制提示。
    expect(leaderReqs[1]?.promptTemplate).toContain('Ask-back is OFF')
  })

  test('worker：压制重提示 → 耗尽 assignment failed 浮出（不 park），任务照常收敛', async () => {
    const config = cfg({ completionGate: false })
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [
        doneLeader({
          assignments: [{ member: 'coder', title: 'do-x', brief: 'do x' }],
          decision: { action: 'continue' },
        }),
        doneLeader({ decision: { action: 'done', summary: 'wrap' } }),
      ],
      member: [cfSuppressed, cfSuppressed],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    const memberReqs = requests.filter((r) => r.nodeId === WG_MEMBER_NODE_ID)
    // RFC-186: WG_PROTOCOL_RETRIES raised 1→3, so the two scripted suppressions
    // re-prompt (reqs 0,1) then the script-exhausted 3rd attempt fatals the
    // assignment (req 2) — 3 member host runs total (was 2 at budget 1).
    expect(memberReqs).toHaveLength(3)
    expect(memberReqs[1]?.promptTemplate).toContain('Ask-back is OFF')
    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(cards).toHaveLength(1)
    expect(cards[0]?.status).toBe('failed')
  })

  test('非全自动回归：clarifyEnabled=true 透传，压制分支不可达', async () => {
    const config = cfg({ completionGate: false })
    const { taskId } = await seedEngineTask(db, config)
    const { hooks, requests } = scriptedHooks({
      leader: [doneLeader({ decision: { action: 'done', summary: 'fine' } })],
      member: [],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests[0]?.clarifyEnabled).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RFC-182 D6 — mint 即 pending 帧（排队可见性：花名册/回合卡的「排队中」态）
// ---------------------------------------------------------------------------

describe('RFC-182 — mint 即广播 node.status{pending}', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('leader / assignment 每次真 mint 各一帧 pending（happy path 共 3 mint）', async () => {
    const config = cfg({ completionGate: false })
    const { taskId } = await seedEngineTask(db, config)
    const frames: TaskWsMessage[] = []
    const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => frames.push(m))
    const { hooks } = scriptedHooks({
      leader: [
        doneLeader({
          assignments: [{ member: 'coder', title: 't', brief: 'b' }],
          decision: { action: 'continue' },
        }),
        doneLeader({ decision: { action: 'done', summary: 's' } }),
      ],
      member: [doneMember('done x')],
    })
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    unsub()
    expect(result.kind).toBe('ok')
    const pendings = frames.filter((f) => f.type === 'node.status' && f.status === 'pending')
    // 3 真 mint：leader 轮1、member 派发轮、leader 轮2 → 恒一 mint 一帧。
    expect(pendings).toHaveLength(3)
    expect(pendings.every((f) => f.type === 'node.status' && typeof f.nodeRunId === 'string')).toBe(
      true,
    )
  })
})
