// RFC-167 PR-2③④ — dynamic-workflow engine wiring + confirm gate. Locks:
//
//   launch    — startWorkgroupTask(dynamic) synthesizes the single-orchestrator
//               generation snapshot + stamps dw:{phase:'generating'} (the PR-1
//               'workgroup-dynamic-not-implemented' 422 guard is GONE), and
//               runTask routes the task into the GENERATE engine (the failure
//               shape below is generate-engine-specific).
//   engine    — runDynamicWorkflowGenerate over scripted fake hooks (no
//               subprocesses): success → dw.phase='awaiting_confirm' +
//               generatedDef + dw-gate holder run (awaiting_review lifecycle
//               invariant); malformed output → bounded retry with the error
//               list injected; exhausted → failed('dw-generate-exhausted');
//               rejection feedback rides the regen prompt; awaiting_confirm
//               re-entry is idempotent (re-parks, never re-generates);
//               phase='executing' is refused (dw-phase-invariant).
//   dispatch  — runTask three-way source locks + behavior: phase='executing'
//               runs the swapped snapshot through runScope (NOT the generate
//               engine); an 'executing' task whose snapshot still contains the
//               generation host node fail-fasts 'dw-phase-invariant'.
//   confirm   — POST dw-confirm: approve swaps workflow_snapshot=generatedDef
//               + dw.phase='executing' atomically (resumeKick extra) and
//               closes the holder; reject requires a comment, resets the pass
//               (phase='generating', attempts=0, rejectRounds+1, generatedDef
//               dropped); DW_MAX_REJECT_ROUNDS hard-cap fails the task; a
//               closed gate 409s. POST dw-save-as-workflow persists the
//               generated DAG as a reusable workflows row.

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  initialDwState,
  parseDwState,
  WorkflowDefinitionSchema,
  type DwState,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { buildActor } from '../src/auth/actor'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, runtimes, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import {
  DW_GATE_CAUSE,
  DW_GENERATE_CAUSE,
  DW_MAX_GENERATE_ATTEMPTS,
  DW_MAX_REJECT_ROUNDS,
  extractJsonPayload,
  runDynamicWorkflowGenerate,
} from '../src/services/dynamicWorkflowRunner'
import {
  DW_ORCHESTRATOR_NODE_ID,
  ORCHESTRATOR_AGENT_NAME,
  ORCHESTRATOR_WORKFLOW_PORT,
} from '../src/services/orchestratorAgent'
import { runTask } from '../src/services/scheduler'
import { createUser } from '../src/services/users'
import { createWorkgroup } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroupLaunch'
import type {
  WorkgroupEngineHooks,
  WorkgroupHostRunRequest,
  WorkgroupHostRunResult,
} from '../src/services/workgroupRunner'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const OPENCODE_CMD = ['bun', 'run', MOCK_OPENCODE]
const log = createLogger('rfc167-dw-engine-test')

// ---------------------------------------------------------------------------
// seeds
// ---------------------------------------------------------------------------

function dynamicConfig(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg-dyn',
    workgroupName: 'dyn-squad',
    mode: 'dynamic_workflow',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    instructions: '章程：先审计后修复',
    goal: '修掉支付回调里的竞态',
    members: [
      {
        id: 'm-planner',
        memberType: 'agent',
        agentName: 'wg-planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '规划',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'wg-coder',
        userId: null,
        displayName: 'coder',
        roleDesc: '实现',
      },
    ],
    ...overrides,
  }
}

const GENERATION_SNAPSHOT = {
  $schema_version: 4,
  inputs: [],
  nodes: [
    { id: DW_ORCHESTRATOR_NODE_ID, kind: 'agent-single', agentName: ORCHESTRATOR_AGENT_NAME },
  ],
  edges: [],
}

async function seedPoolAgents(db: DbClient): Promise<void> {
  // A registered runtime whose binary does not exist: any REAL dispatch of a
  // pool agent (post-approve runScope in the HTTP tests) fails fast at spawn
  // (ENOENT) instead of launching an actual opencode process on the dev box.
  await db
    .insert(runtimes)
    .values({
      id: ulid(),
      name: 'aw-test-broken-rt',
      protocol: 'opencode',
      binaryPath: '/nonexistent-aw-test-binary',
    })
    .onConflictDoNothing()
  const base = {
    description: '',
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    runtime: 'aw-test-broken-rt',
  }
  await createAgent(db, { ...base, name: 'wg-planner', outputs: ['plan'], bodyMd: 'plan' }).catch(
    () => undefined,
  )
  await createAgent(db, {
    ...base,
    name: 'wg-coder',
    outputs: ['code_result'],
    bodyMd: 'code',
  }).catch(() => undefined)
}

async function seedDynamicTask(
  db: DbClient,
  opts: {
    dw: DwState
    config?: WorkgroupRuntimeConfig
    snapshot?: unknown
    status?: 'pending' | 'running' | 'awaiting_review' | 'failed'
    worktreePath?: string
    ownerUserId?: string
  },
): Promise<{ taskId: string }> {
  const taskId = ulid()
  const config = opts.config ?? dynamicConfig()
  await db.insert(workflows).values({
    id: `wf-anchor-${taskId}`,
    name: `dw-anchor-${taskId}`,
    definition: '{"$schema_version":1,"inputs":[],"nodes":[],"edges":[]}',
    builtin: true,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'dw-task',
    workflowId: `wf-anchor-${taskId}`,
    workflowSnapshot: JSON.stringify(opts.snapshot ?? GENERATION_SNAPSHOT),
    repoPath: '/tmp/never-read',
    worktreePath: opts.worktreePath ?? '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.status ?? 'running',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify({ ...config, dw: opts.dw }),
    ...(opts.ownerUserId !== undefined ? { ownerUserId: opts.ownerUserId } : {}),
  })
  return { taskId }
}

/** Scripted hooks: pops results in order; records every request. */
function scriptedHooks(queue: WorkgroupHostRunResult[]): {
  hooks: WorkgroupEngineHooks
  requests: WorkgroupHostRunRequest[]
} {
  const requests: WorkgroupHostRunRequest[] = []
  return {
    requests,
    hooks: {
      runHostNode: (req) => {
        requests.push(req)
        const next = queue.shift()
        return Promise.resolve(
          next ?? { status: 'failed', outputs: {}, errorMessage: 'script exhausted' },
        )
      },
    },
  }
}

const GOOD_GEN = {
  nodes: [
    { id: 'plan', agentName: 'wg-planner', promptTemplate: '规划目标怎么拆', inputs: [] },
    {
      id: 'code',
      agentName: 'wg-coder',
      promptTemplate: '按 {{plan}} 实现',
      inputs: [{ port: 'plan', from: { nodeId: 'plan', portName: 'plan' } }],
    },
  ],
  edges: [],
}

const goodResult = (gen: unknown = GOOD_GEN): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: JSON.stringify(gen) },
})

async function readDw(db: DbClient, taskId: string): Promise<DwState | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
  const raw = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
  return parseDwState(raw.dw)
}

// ---------------------------------------------------------------------------
// generate engine (fake hooks — no subprocesses)
// ---------------------------------------------------------------------------

describe('RFC-167 engine — generation pass', () => {
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedPoolAgents(db)
  })

  test('success: generatedDef persisted, phase=awaiting_confirm, dw-gate holder minted, standard protocol (no wg block)', async () => {
    const { taskId } = await seedDynamicTask(db, { dw: initialDwState() })
    const { hooks, requests } = scriptedHooks([goodResult()])

    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')

    // one orchestrator run, minted against the host node with 借壳 identity
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.nodeId).toBe(DW_ORCHESTRATOR_NODE_ID)
    expect(req.agent.name).toBe(ORCHESTRATOR_AGENT_NAME)
    // the orchestrator uses the STANDARD workflow-output protocol
    expect(req.workgroupProtocolBlock).toBeUndefined()
    // Codex impl-gate P1: the generation run's worktree writes are discarded
    // (never merged back) — validation + human confirm happen after the run
    expect(req.discardWrites).toBe(true)
    // prompt carries charter + goal + the pool's capability cards
    expect(req.promptTemplate).toContain('章程：先审计后修复')
    expect(req.promptTemplate).toContain('修掉支付回调里的竞态')
    expect(req.promptTemplate).toContain('wg-planner')
    expect(req.promptTemplate).toContain('wg-coder')
    // prompt isolation: no member/user ids ever ride the prompt
    expect(req.promptTemplate).not.toContain('m-planner')

    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('awaiting_confirm')
    expect(dw?.generateAttempts).toBe(0)
    const def = WorkflowDefinitionSchema.parse(dw?.generatedDef)
    expect(def.nodes.map((n) => n.id).sort()).toEqual(['code', 'plan'])
    expect(def.edges).toHaveLength(1)

    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const holder = runs.filter((r) => r.rerunCause === DW_GATE_CAUSE)
    expect(holder).toHaveLength(1)
    expect(holder[0]?.status).toBe('awaiting_review')
    const genRuns = runs.filter((r) => r.rerunCause === DW_GENERATE_CAUSE)
    expect(genRuns).toHaveLength(1)
    expect(genRuns[0]?.agentOverrideName).toBe(ORCHESTRATOR_AGENT_NAME)
  })

  test('malformed JSON retries with the error list injected; attempts persist across the pass', async () => {
    const { taskId } = await seedDynamicTask(db, { dw: initialDwState() })
    const { hooks, requests } = scriptedHooks([
      { status: 'done', outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: 'not json {{' } },
      goodResult(),
    ])

    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.promptTemplate).toContain('Validation errors in your previous workflow')
    expect(requests[1]!.promptTemplate).toContain('invalid JSON')

    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('awaiting_confirm')
    expect(dw?.generateAttempts).toBe(1) // the failed attempt stays counted
  })

  test('fenced JSON payload is tolerated (extractJsonPayload)', async () => {
    expect(extractJsonPayload('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJsonPayload('  {"a":1} ')).toBe('{"a":1}')
    const { taskId } = await seedDynamicTask(db, { dw: initialDwState() })
    const fenced = '```json\n' + JSON.stringify(GOOD_GEN) + '\n```'
    const { hooks } = scriptedHooks([
      { status: 'done', outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: fenced } },
    ])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
  })

  test('v1-violating output (agent outside the pool) exhausts the bounded retries → failed', async () => {
    await createAgent(db, {
      name: 'outsider',
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
    })
    const { taskId } = await seedDynamicTask(db, { dw: initialDwState() })
    const badGen = {
      nodes: [{ id: 'n1', agentName: 'outsider', promptTemplate: 'do it', inputs: [] }],
      edges: [],
    }
    const { hooks, requests } = scriptedHooks([
      goodResult(badGen),
      goodResult(badGen),
      goodResult(badGen),
    ])

    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('failed')
    expect(result.detail?.summary).toBe('dw-generate-exhausted')
    expect(result.detail?.message).toContain('dw-agent-outside-pool')
    expect(requests).toHaveLength(DW_MAX_GENERATE_ATTEMPTS)
    // the retry prompts carried the layer-2 error code
    expect(requests[1]!.promptTemplate).toContain('dw-agent-outside-pool')

    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('generating')
    expect(dw?.generateAttempts).toBe(DW_MAX_GENERATE_ATTEMPTS)
    // no confirm gate was opened
    const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === DW_GATE_CAUSE,
    )
    expect(holders).toHaveLength(0)
  })

  test('rejection feedback rides the regeneration prompt (high priority block)', async () => {
    const { taskId } = await seedDynamicTask(db, {
      dw: {
        ...initialDwState(),
        rejectRounds: 1,
        rejectionComment: '不要把审计和修复合在一个节点',
      },
    })
    const { hooks, requests } = scriptedHooks([goodResult()])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    expect(requests[0]!.promptTemplate).toContain('REJECTED')
    expect(requests[0]!.promptTemplate).toContain('不要把审计和修复合在一个节点')
    // the comment is consumed by the successful regeneration
    const dw = await readDw(db, taskId)
    expect(dw?.rejectionComment).toBeUndefined()
    expect(dw?.rejectRounds).toBe(1) // reject accounting is the confirm route's job
  })

  test('awaiting_confirm re-entry is idempotent: re-parks without re-generating; re-mints a lost holder', async () => {
    const def = WorkflowDefinitionSchema.parse({
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'plan', kind: 'agent-single', agentName: 'wg-planner', promptTemplate: 'x' }],
      edges: [],
    })
    const { taskId } = await seedDynamicTask(db, {
      dw: { ...initialDwState(), phase: 'awaiting_confirm', generatedDef: def },
    })
    // holder present → nothing minted, no orchestrator run
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: DW_ORCHESTRATOR_NODE_ID,
      status: 'awaiting_review',
      rerunCause: DW_GATE_CAUSE,
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    const { hooks, requests } = scriptedHooks([])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    expect(requests).toHaveLength(0)
    const before = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(before).toHaveLength(1)

    // lost holder (crash) → re-minted on re-entry, still no regeneration
    await db.delete(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const again = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(again.kind).toBe('awaiting_review')
    expect(requests).toHaveLength(0)
    const after = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(after).toHaveLength(1)
    expect(after[0]?.rerunCause).toBe(DW_GATE_CAUSE)
    expect(after[0]?.status).toBe('awaiting_review')
  })

  test('a mid-generation config edit survives the dw persist (json_set slot write, Codex P2)', async () => {
    const { taskId } = await seedDynamicTask(db, { dw: initialDwState() })
    const requests: WorkgroupHostRunRequest[] = []
    const hooks: WorkgroupEngineHooks = {
      runHostNode: async (r) => {
        requests.push(r)
        // simulate a PUT config landing WHILE the orchestrator runs: a new
        // top-level key must survive the engine's dw persist.
        const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
        const cfg = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
        await db
          .update(tasks)
          .set({ workgroupConfigJson: JSON.stringify({ ...cfg, probe: 'keep-me' }) })
          .where(eq(tasks.id, taskId))
        return goodResult()
      },
    }
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    const cfg = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
    expect(cfg.probe).toBe('keep-me') // the concurrent edit was NOT stomped
    expect(parseDwState(cfg.dw)?.phase).toBe('awaiting_confirm') // dw still landed
    expect(requests).toHaveLength(1)
  })

  test('a manual resume of a generate-exhausted task grants a fresh attempt budget (Codex P2)', async () => {
    const { taskId } = await seedDynamicTask(db, {
      dw: { ...initialDwState(), generateAttempts: DW_MAX_GENERATE_ATTEMPTS },
    })
    const { hooks, requests } = scriptedHooks([goodResult()])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    // without the reset the loop would run ZERO times and instantly re-fail
    expect(result.kind).toBe('awaiting_review')
    expect(requests).toHaveLength(1)
    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('awaiting_confirm')
    expect(dw?.generateAttempts).toBe(0)
  })

  test("phase='executing' is refused (dw-phase-invariant — dispatch must never send it here)", async () => {
    const { taskId } = await seedDynamicTask(db, {
      dw: { ...initialDwState(), phase: 'executing' },
    })
    const { hooks, requests } = scriptedHooks([])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('failed')
    expect(result.detail?.summary).toBe('dw-phase-invariant')
    expect(requests).toHaveLength(0)
  })

  test('empty resolved pool (agents deleted after launch) fails without minting anything', async () => {
    const config = dynamicConfig({
      members: [
        {
          id: 'm-ghost',
          memberType: 'agent',
          agentName: 'ghost-agent',
          userId: null,
          displayName: 'ghost',
          roleDesc: '',
        },
      ],
    })
    const { taskId } = await seedDynamicTask(db, { dw: initialDwState(), config })
    const { hooks, requests } = scriptedHooks([])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('failed')
    expect(result.detail?.summary).toContain('agent pool is empty')
    expect(requests).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// launch + runTask dispatch
// ---------------------------------------------------------------------------

describe('RFC-167 — dynamic launch + runTask dispatch', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  // RFC-175 §2b: the immediate-submit workgroup-identity OCC guard for relaunch.
  test('expectedWorkgroupId mismatch → 409 (after the ACL-404 gate)', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc175-wg-'))
    try {
      await createWorkgroup(db, {
        name: 'wg',
        description: '',
        instructions: '章程',
        mode: 'dynamic_workflow',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 5,
        completionGate: false,
        members: [
          { memberType: 'agent', agentName: 'ghost-agent', displayName: 'g', roleDesc: '' },
        ],
      })
      const actor = buildActor({
        user: { id: 'u', username: 'u', displayName: 'u', role: 'admin', status: 'active' },
        source: 'daemon',
      })
      // A relaunch whose seeded group was deleted+recreated under the same name
      // carries the OLD id → rejected AFTER the ACL gate (never a 409-vs-404
      // existence probe for a private group name), before readiness/materialize.
      await expect(
        startWorkgroupTask(
          db,
          actor,
          'wg',
          { name: 't', goal: 'g', scratch: true, expectedWorkgroupId: 'stale-other-id' },
          { db, appHome },
        ),
      ).rejects.toMatchObject({ code: 'workgroup-id-mismatch' })
    } finally {
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test('dynamic launch synthesizes the generation snapshot + dw slot and enters the GENERATE engine', async () => {
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc167-launch-'))
    const previousOutputs = process.env.MOCK_OPENCODE_OUTPUTS
    try {
      await createAgent(db, {
        name: 'launch-agent',
        description: '',
        outputs: ['result'],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
        bodyMd: 'execute the generated step',
      })
      await createWorkgroup(db, {
        name: 'dyn',
        description: '',
        instructions: '章程',
        mode: 'dynamic_workflow',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 5,
        completionGate: false,
        members: [
          {
            memberType: 'agent',
            agentName: 'launch-agent',
            displayName: 'launcher',
            roleDesc: '',
          },
        ],
      })
      const actor = buildActor({
        user: { id: 'u-own', username: 'own', displayName: 'own', role: 'admin', status: 'active' },
        source: 'daemon',
      })
      process.env.MOCK_OPENCODE_OUTPUTS = JSON.stringify({
        workflow: JSON.stringify({
          nodes: [
            {
              id: 'generated-step',
              agentName: 'launch-agent',
              promptTemplate: 'execute',
              inputs: [],
            },
          ],
          edges: [],
        }),
      })
      const task = await startWorkgroupTask(
        db,
        actor,
        'dyn',
        { name: 't', goal: '目标', scratch: true },
        { db, appHome, opencodeCmd: OPENCODE_CMD, awaitScheduler: true },
      )

      const row = (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(row?.workgroupId).not.toBeNull()
      const snapshot = WorkflowDefinitionSchema.parse(JSON.parse(row?.workflowSnapshot ?? '{}'))
      expect(snapshot.nodes).toHaveLength(1)
      expect(snapshot.nodes[0]?.id).toBe(DW_ORCHESTRATOR_NODE_ID)
      const raw = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
      // The mock orchestrator's proposal proves runTask dispatched to the
      // GENERATE engine (not the turn engine or runScope).
      expect(parseDwState(raw.dw)?.phase).toBe('awaiting_confirm')
      expect(row?.status).toBe('awaiting_review')
    } finally {
      if (previousOutputs === undefined) delete process.env.MOCK_OPENCODE_OUTPUTS
      else process.env.MOCK_OPENCODE_OUTPUTS = previousOutputs
      rmSync(appHome, { recursive: true, force: true })
    }
  })

  test("dispatch: phase='executing' runs the swapped snapshot through runScope (not the generate engine)", async () => {
    const realDef = {
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'g1', kind: 'agent-single', agentName: 'ghost-agent', promptTemplate: 'x' }],
      edges: [],
    }
    const { taskId } = await seedDynamicTask(db, {
      dw: { ...initialDwState(), phase: 'executing' },
      snapshot: realDef,
      status: 'pending',
    })
    await runTask({ taskId, db, appHome: '/tmp/aw-rfc167-nonexistent' })
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('failed')
    // runScope's failure shape for the REAL DAG node (g1): agent resolution
    // fail-fast with failedNodeId stamped. The generate engine can't produce
    // this (it fails pool-empty or mints dw-generate rows first).
    expect(row?.failedNodeId).toBe('g1')
    expect(row?.errorSummary).toContain("agent 'ghost-agent' not found")
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.some((r) => r.rerunCause === DW_GENERATE_CAUSE)).toBe(false)
  })

  test("dispatch fail-fast: phase='executing' with the generation host snapshot → dw-phase-invariant", async () => {
    const { taskId } = await seedDynamicTask(db, {
      dw: { ...initialDwState(), phase: 'executing' },
      status: 'pending',
    })
    await runTask({ taskId, db, appHome: '/tmp/aw-rfc167-nonexistent' })
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('failed')
    expect(row?.errorSummary).toBe('dw-phase-invariant')
  })

  test('source locks: three-way dispatch wiring in scheduler.ts', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).toContain('task.workgroupId !== null') // RFC-164 lock stays
    expect(src).toContain('deriveWorkgroupDispatchFromConfig(task.workgroupConfigJson)')
    expect(src).toContain("wgDispatch === 'dw-generate'")
    expect(src).toContain('runDynamicWorkflowGenerate({')
    expect(src).toContain("'dw-phase-invariant'")
    // Codex impl-gate P1: the generation run's iso delta is dropped, never
    // merged into the canonical worktree (abandon + skip merge-back).
    expect(src).toContain('req.discardWrites === true')
    expect(src).toContain("{ kind: 'abandon', reason: 'discard-writes' }")
  })
})

// ---------------------------------------------------------------------------
// confirm gate (HTTP)
// ---------------------------------------------------------------------------

describe('RFC-167 — dw-confirm gate + save-as (HTTP)', () => {
  let db: DbClient
  let app: ReturnType<typeof createApp>
  let token: string
  let ownerId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedPoolAgents(db)
    app = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-rfc167-dw-config.json',
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
    ownerId = u.id
    token = (await createSession({ db, userId: u.id })).token
  })

  async function req(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    if (init.body) headers.set('content-type', 'application/json')
    return app.request(path, { ...init, headers })
  }

  const GHOST_DEF = {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'g1', kind: 'agent-single', agentName: 'ghost-agent', promptTemplate: 'x' }],
    edges: [],
  }

  /** In-pool single-node def — passes the approve-time revalidation (Codex
   *  P2); the resumed runScope then fails fast at iso setup (the temp
   *  worktree is not a git repo), still without spawning any subprocess. */
  const POOL_DEF = {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'p1', kind: 'agent-single', agentName: 'wg-planner', promptTemplate: 'x' }],
    edges: [],
  }

  async function seedConfirmable(opts: {
    dwOverrides?: Partial<DwState>
    worktreePath?: string
    withHolder?: boolean
    generatedDef?: unknown
  }): Promise<{ taskId: string }> {
    const { taskId } = await seedDynamicTask(db, {
      dw: {
        ...initialDwState(),
        phase: 'awaiting_confirm',
        generatedDef: opts.generatedDef ?? GHOST_DEF,
        ...opts.dwOverrides,
      },
      status: 'awaiting_review',
      worktreePath: opts.worktreePath ?? '/tmp/aw-rfc167-never-exists-wt',
      ownerUserId: ownerId,
    })
    if (opts.withHolder !== false) {
      await db.insert(nodeRuns).values({
        id: ulid(),
        taskId,
        nodeId: DW_ORCHESTRATOR_NODE_ID,
        status: 'awaiting_review',
        rerunCause: DW_GATE_CAUSE,
        retryIndex: 0,
        iteration: 0,
        reviewIteration: 0,
        startedAt: Date.now(),
      })
    }
    return { taskId }
  }

  /** Poll the background fire-and-forget runTask to a terminal state so it
   *  can't bleed into other tests. */
  async function settleTask(taskId: string): Promise<typeof tasks.$inferSelect | undefined> {
    const deadline = Date.now() + 5000
    let final: typeof tasks.$inferSelect | undefined
    while (Date.now() < deadline) {
      final = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      const s = final?.status
      if (s !== 'pending' && s !== 'running' && s !== 'awaiting_review') break
      await Bun.sleep(25)
    }
    return final
  }

  test('approve: snapshot swap + phase=executing land atomically; holder closes; resumed run executes the new DAG', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'aw-rfc167-wt-'))
    try {
      const { taskId } = await seedConfirmable({ worktreePath: wt, generatedDef: POOL_DEF })
      const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(res.status).toBe(200)

      const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      expect(JSON.parse(row?.workflowSnapshot ?? '{}')).toEqual(POOL_DEF)
      const raw = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
      expect(parseDwState(raw.dw)?.phase).toBe('executing')
      const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (r) => r.rerunCause === DW_GATE_CAUSE,
      )
      expect(holders[0]?.status).toBe('done')

      // the fire-and-forget resume drives runScope over the new DAG — the
      // node p1 is minted and fails fast at iso setup (temp dir is not a git
      // repo), proving the swapped snapshot reached the frontier. No spawn.
      const final = await settleTask(taskId)
      expect(final?.status).toBe('failed')
      const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
      expect(runs.some((r) => r.nodeId === 'p1')).toBe(true)
      expect(runs.some((r) => r.rerunCause === DW_GENERATE_CAUSE)).toBe(false)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('approve refuses a proposal that no longer validates against the current pool (409 dw-generated-def-stale)', async () => {
    // GHOST_DEF references an agent outside the pool — as if members changed
    // (or the agent was deleted) between generation and approval (Codex P2).
    const { taskId } = await seedConfirmable({ generatedDef: GHOST_DEF })
    const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('dw-generated-def-stale')
    // gate untouched: still confirmable (reject-with-feedback path stays open)
    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('awaiting_confirm')
    const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === DW_GATE_CAUSE,
    )
    expect(holders[0]?.status).toBe('awaiting_review')
  })

  test('approve composes against the FRESH config: a concurrent edit is neither overwritten nor bypassed (Codex P1)', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'aw-rfc167-fw-'))
    try {
      const { taskId } = await seedConfirmable({ worktreePath: wt, generatedDef: POOL_DEF })
      // A "concurrent" config edit lands after the handler's entry snapshot
      // would have been taken: adds a top-level key. The approve must keep it.
      const row0 = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      const cfg0 = JSON.parse(row0?.workgroupConfigJson ?? '{}') as Record<string, unknown>
      await db
        .update(tasks)
        .set({ workgroupConfigJson: JSON.stringify({ ...cfg0, probe: 'keep-me' }) })
        .where(eq(tasks.id, taskId))

      const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approve' }),
      })
      expect(res.status).toBe(200)
      const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      const cfg = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
      expect(cfg.probe).toBe('keep-me') // fresh compose kept the edit
      expect(parseDwState(cfg.dw)?.phase).toBe('executing')
      await settleTask(taskId)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('approve validates against the FRESH pool: removing the referenced member concurrently → 409 stale', async () => {
    const { taskId } = await seedConfirmable({ generatedDef: POOL_DEF })
    // Concurrently shrink the pool so POOL_DEF's wg-planner is no longer a
    // member — the fresh-view revalidation must catch it (dw-agent-outside-pool).
    const row0 = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    const cfg0 = JSON.parse(row0?.workgroupConfigJson ?? '{}') as Record<string, unknown>
    const members = (cfg0.members as Array<{ agentName: string | null }>).filter(
      (m) => m.agentName !== 'wg-planner',
    )
    await db
      .update(tasks)
      .set({ workgroupConfigJson: JSON.stringify({ ...cfg0, members }) })
      .where(eq(tasks.id, taskId))

    const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('dw-generated-def-stale')
  })

  test('reject: comment required; the phase reset rides the resume CAS; holder closes; generatedDef dropped', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'aw-rfc167-rj-'))
    try {
      // ghost pool: the re-entered generate pass fails at pool resolution
      // BEFORE any host-node run — no subprocess risk from the sync resume.
      const ghostPool = dynamicConfig({
        members: [
          {
            id: 'm-ghost',
            memberType: 'agent',
            agentName: 'ghost-agent',
            userId: null,
            displayName: 'ghost',
            roleDesc: '',
          },
        ],
      })
      const { taskId } = await seedDynamicTask(db, {
        dw: { ...initialDwState(), phase: 'awaiting_confirm', generatedDef: GHOST_DEF },
        config: ghostPool,
        status: 'awaiting_review',
        worktreePath: wt,
        ownerUserId: ownerId,
      })
      await db.insert(nodeRuns).values({
        id: ulid(),
        taskId,
        nodeId: DW_ORCHESTRATOR_NODE_ID,
        status: 'awaiting_review',
        rerunCause: DW_GATE_CAUSE,
        retryIndex: 0,
        iteration: 0,
        reviewIteration: 0,
        startedAt: Date.now(),
      })

      const noComment = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject' }),
      })
      expect(noComment.status).toBe(422)

      const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject', comment: '粒度太粗，按模块拆' }),
      })
      expect(res.status).toBe(200)
      const dw = await readDw(db, taskId)
      expect(dw?.phase).toBe('generating')
      expect(dw?.generateAttempts).toBe(0)
      expect(dw?.rejectRounds).toBe(1)
      expect(dw?.rejectionComment).toBe('粒度太粗，按模块拆')
      expect(dw?.generatedDef).toBeUndefined()
      const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
        (r) => r.rerunCause === DW_GATE_CAUSE,
      )
      expect(holders[0]?.status).toBe('done')
      // the sync resume re-entered the generate engine, which failed at pool
      // resolution — the generate-engine failure shape, no orchestrator run.
      const final = await settleTask(taskId)
      expect(final?.status).toBe('failed')
      expect(final?.errorSummary).toContain('agent pool is empty')
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('generic /resume applies to dynamic tasks (Codex P1: executing recovery); turn-engine workgroups stay 403', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'aw-rfc167-rs-'))
    try {
      // an executing dynamic task that failed mid-DAG — before the carve-out
      // the builtin host anchor 403'd every generic recovery endpoint.
      const { taskId } = await seedDynamicTask(db, {
        dw: { ...initialDwState(), phase: 'executing' },
        snapshot: POOL_DEF,
        status: 'failed',
        worktreePath: wt,
        ownerUserId: ownerId,
      })
      const res = await req(`/api/tasks/${taskId}/resume`, { method: 'POST' })
      expect(res.status).toBe(200)
      const final = await settleTask(taskId)
      expect(final?.status).toBe('failed') // re-ran runScope; p1 iso fails fast

      // control: a turn-engine workgroup task keeps the 403 lock.
      const lw = dynamicConfig({ mode: 'leader_worker', leaderMemberId: 'm-planner' })
      const { taskId: lwTask } = await seedDynamicTask(db, {
        dw: initialDwState(), // ignored by turn-engine dispatch
        config: lw,
        status: 'failed',
        worktreePath: wt,
        ownerUserId: ownerId,
      })
      const lwRes = await req(`/api/tasks/${lwTask}/resume`, { method: 'POST' })
      expect(lwRes.status).toBe(403)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  test('reject propagates a failed resume and leaves the gate re-triable (Codex P1: no stranding)', async () => {
    // nonexistent worktree → the resume ownership CAS never runs (410
    // preflight) → the phase reset must NOT have been written.
    const { taskId } = await seedConfirmable({ generatedDef: POOL_DEF })
    const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', comment: '再拆细一点' }),
    })
    expect(res.status).toBe(410)
    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('awaiting_confirm') // untouched — gate still open
    expect(dw?.rejectRounds).toBe(0)
    expect(dw?.generatedDef).toBeDefined()
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('awaiting_review')
  })

  test('reject at the DW_MAX_REJECT_ROUNDS cap fails the task (dw-reject-exhausted)', async () => {
    const { taskId } = await seedConfirmable({
      dwOverrides: { rejectRounds: DW_MAX_REJECT_ROUNDS - 1 },
    })
    const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', comment: '还是不行' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { exhausted?: boolean }).exhausted).toBe(true)
    const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('failed')
    expect(row?.errorSummary).toBe('dw-reject-exhausted')
    const dw = await readDw(db, taskId)
    expect(dw?.phase).toBe('rejected')
    expect(dw?.rejectRounds).toBe(DW_MAX_REJECT_ROUNDS)
  })

  test('gate not open (phase=generating) → 409; non-dynamic task → 409', async () => {
    const { taskId } = await seedDynamicTask(db, {
      dw: initialDwState(),
      status: 'running',
      ownerUserId: ownerId,
    })
    const res = await req(`/api/workgroup-tasks/${taskId}/dw-confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('workgroup-dw-gate-not-open')

    // a leader_worker task never opens the dw gate
    const lwConfig = dynamicConfig({ mode: 'leader_worker', leaderMemberId: 'm-planner' })
    const { taskId: lwTask } = await seedDynamicTask(db, {
      dw: { ...initialDwState(), phase: 'awaiting_confirm' },
      config: lwConfig,
      status: 'awaiting_review',
      ownerUserId: ownerId,
    })
    const lwRes = await req(`/api/workgroup-tasks/${lwTask}/dw-confirm`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approve' }),
    })
    expect(lwRes.status).toBe(409)
  })

  test('GET room exposes the dw slot for dynamic tasks (PR-3 frontend data source)', async () => {
    const { taskId } = await seedConfirmable({ generatedDef: POOL_DEF })
    const res = await req(`/api/workgroup-tasks/${taskId}/room`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { dw: DwState | null }
    expect(body.dw?.phase).toBe('awaiting_confirm')
    expect(WorkflowDefinitionSchema.safeParse(body.dw?.generatedDef).success).toBe(true)

    // turn-engine tasks expose dw: null
    const lw = dynamicConfig({ mode: 'leader_worker', leaderMemberId: 'm-planner' })
    const { taskId: lwTask } = await seedDynamicTask(db, {
      dw: initialDwState(),
      config: { ...lw },
      status: 'running',
      ownerUserId: ownerId,
    })
    // strip the dw slot the seed helper stamps — lw tasks never carry one
    const row = (await db.select().from(tasks).where(eq(tasks.id, lwTask)))[0]
    const cfg = JSON.parse(row?.workgroupConfigJson ?? '{}') as Record<string, unknown>
    delete cfg.dw
    await db
      .update(tasks)
      .set({ workgroupConfigJson: JSON.stringify(cfg) })
      .where(eq(tasks.id, lwTask))
    const lwRes = await req(`/api/workgroup-tasks/${lwTask}/room`)
    expect(lwRes.status).toBe(200)
    expect(((await lwRes.json()) as { dw: DwState | null }).dw).toBeNull()
  })

  test('save-as-workflow persists the generated DAG; missing def → 409', async () => {
    const goodDef = {
      $schema_version: 4,
      inputs: [],
      nodes: [{ id: 'p1', kind: 'agent-single', agentName: 'wg-planner', promptTemplate: 'x' }],
      edges: [],
    }
    const { taskId } = await seedConfirmable({ generatedDef: goodDef })
    const res = await req(`/api/workgroup-tasks/${taskId}/dw-save-as-workflow`, {
      method: 'POST',
      body: JSON.stringify({ name: 'saved-dw', description: '一次性另存' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string; name: string }
    expect(body.name).toBe('saved-dw')
    const wf = (await db.select().from(workflows).where(eq(workflows.id, body.id)))[0]
    expect(wf).toBeDefined()
    const savedDef = JSON.parse(wf?.definition ?? '{}') as { nodes?: Array<{ id: string }> }
    expect(savedDef.nodes?.map((n) => n.id)).toEqual(['p1'])

    // no generated def → 409
    const { taskId: bare } = await seedDynamicTask(db, {
      dw: initialDwState(),
      status: 'running',
      ownerUserId: ownerId,
    })
    const miss = await req(`/api/workgroup-tasks/${bare}/dw-save-as-workflow`, {
      method: 'POST',
      body: JSON.stringify({ name: 'nope' }),
    })
    expect(miss.status).toBe(409)
    expect(((await miss.json()) as { code: string }).code).toBe('dw-no-generated-workflow')
  })
})
