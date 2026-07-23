// RFC-223 (PR-3b) — dynamic-workflow OPAQUE TOKEN indirection. This file locks
// the token-isolation invariants of design §4.2 (R4-2/R5-2) end to end over the
// pure layer + a live generate→save-as HTTP path:
//
//   1. The orchestrator LLM sees pool members ONLY as opaque `member#N` tokens:
//      the capability-card heading (the machine-readable IDENTITY slot) and the
//      protocol schema use tokens; the real agent NAME appears at most in the
//      card's free-text description (R4-2 — NOT scrubbed), and the canonical
//      agent id NEVER appears in the prompt at all.
//   2. There is a SINGLE server-side token→agentId conversion point
//      (dwGeneratedToWorkflowDef): the stored / approved / saved-as definition
//      is id-canonical — every node carries the frozen agentId and the token is
//      gone. Approval + save-as therefore consume the id form only.
//   3. An unknown token can never bind a member — it fails closed as
//      dw-agent-outside-pool, referencing the token (never a name/id).
//
// The baseline fixtures use distinct names to keep the prompt assertions easy
// to read. The AC16 regression at the bottom adds the post-PR-8 adversarial
// case: two owners, one shared name, and two distinct frozen ids/runtime
// profiles crossing generate → execute without a name-based mis-selection.

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DW_VALIDATION_CODES,
  dwGeneratedToWorkflowDef,
  dwMemberToken,
  initialDwState,
  WorkflowDefinitionSchema,
  type DwState,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { runtimes, tasks, workflows, workgroupTaskState } from '../src/db/schema'
import { createApp } from '../src/server'
import { createAgent } from '../src/services/agent'
import { DW_GATE_CAUSE, runDynamicWorkflowGenerate } from '../src/services/dynamicWorkflowRunner'
import { setNodeRunStatus } from '../src/services/lifecycle'
import {
  buildDwPoolMembers,
  buildOrchestratorPrompt,
  DW_ORCHESTRATOR_NODE_ID,
  dwPoolTokenMap,
  ORCHESTRATOR_WORKFLOW_PORT,
  validateDynamicWorkflowDef,
} from '../src/services/orchestratorAgent'
import { abortAllActiveTasks, resumeDynamicWorkflowExecution } from '../src/services/task'
import { loadWorkgroupTaskState } from '../src/services/workgroup/state'
import { createUser } from '../src/services/users'
import { nodeRuns } from '../src/db/schema'
import type {
  WorkgroupEngineHooks,
  WorkgroupHostRunRequest,
  WorkgroupHostRunResult,
} from '../src/services/workgroup/engine'
import { createLogger } from '../src/util/log'
import { runTestGit } from './helpers/testCommand'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const log = createLogger('rfc223-pr3b-test')

// Distinctive names that ALSO appear inside each agent's own free-text
// description — so the negative scan can distinguish "name in a framework
// identity field" (forbidden) from "name in free text" (allowed, R4-2).
const WRITER_NAME = 'aardvark-writer'
const AUDITOR_NAME = 'basilisk-auditor'

async function seedTwoAgents(db: DbClient): Promise<{ writerId: string; auditorId: string }> {
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
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    runtime: 'aw-test-broken-rt',
  }
  const writer = await createAgent(db, {
    ...base,
    name: WRITER_NAME,
    description: `the ${WRITER_NAME} drafts the patch`,
    outputs: ['patch'],
    bodyMd: 'draft',
  })
  const auditor = await createAgent(db, {
    ...base,
    name: AUDITOR_NAME,
    description: `the ${AUDITOR_NAME} reviews the patch`,
    outputs: ['report'],
    bodyMd: 'review',
  })
  return { writerId: writer.id, auditorId: auditor.id }
}

function twoAgentConfig(writerId: string, auditorId: string): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg-pr3b',
    workgroupName: 'pr3b-squad',
    mode: 'dynamic_workflow',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 5,
    completionGate: false,
    instructions: '章程',
    goal: '修一个 bug',
    members: [
      {
        id: 'm-writer',
        memberType: 'agent',
        agentName: WRITER_NAME,
        agentId: writerId,
        userId: null,
        displayName: 'writer',
        roleDesc: '写',
      },
      {
        id: 'm-auditor',
        memberType: 'agent',
        agentName: AUDITOR_NAME,
        agentId: auditorId,
        userId: null,
        displayName: 'auditor',
        roleDesc: '审',
      },
    ],
  }
}

// A valid two-node token-form proposal: member#1 (writer) → member#2 (auditor).
const TWO_NODE_GEN = {
  nodes: [
    { id: 'draft', agentToken: 'member#1', promptTemplate: '起草补丁', inputs: [] },
    {
      id: 'review',
      agentToken: 'member#2',
      promptTemplate: '审 {{patch}}',
      inputs: [{ port: 'patch', from: { nodeId: 'draft', portName: 'patch' } }],
    },
  ],
  edges: [],
}

describe('RFC-223 PR-3b — pure token indirection invariants', () => {
  test('prompt: framework identity slots are tokens; real names only in free text; NO agent id', () => {
    const writer = {
      id: 'ID_writer',
      name: WRITER_NAME,
      description: `the ${WRITER_NAME} drafts the patch`,
      inputs: [],
      outputs: ['patch'],
      role: 'normal' as const,
      bodyMd: 'draft',
    }
    const auditor = {
      id: 'ID_auditor',
      name: AUDITOR_NAME,
      description: `the ${AUDITOR_NAME} reviews the patch`,
      inputs: [],
      outputs: ['report'],
      role: 'normal' as const,
      bodyMd: 'review',
    }
    const members = buildDwPoolMembers([writer as never, auditor as never])
    const prompt = buildOrchestratorPrompt({ charter: '章程', goal: '目标', pool: members })

    // machine-readable identity slots (card headings) are tokens
    expect(prompt).toContain(`### ${dwMemberToken(0)}`)
    expect(prompt).toContain(`### ${dwMemberToken(1)}`)
    expect(prompt).not.toContain(`### ${WRITER_NAME}`)
    expect(prompt).not.toContain(`### ${AUDITOR_NAME}`)
    // free text (description) may still mention the name — R4-2, not scrubbed
    expect(prompt).toContain(`the ${WRITER_NAME} drafts the patch`)
    // the frozen canonical agent id NEVER reaches the LLM
    expect(prompt).not.toContain('ID_writer')
    expect(prompt).not.toContain('ID_auditor')
  })

  test('single conversion point: both tokens → frozen agentIds; the token is gone', () => {
    const tokenMap = dwPoolTokenMap(
      buildDwPoolMembers([
        { id: 'ID_writer', name: WRITER_NAME } as never,
        { id: 'ID_auditor', name: AUDITOR_NAME } as never,
      ]),
    )
    const { def, unknownTokens } = dwGeneratedToWorkflowDef(TWO_NODE_GEN, tokenMap)
    expect(unknownTokens).toEqual([])
    const idByNode = new Map(def.nodes.map((n) => [n.id, (n as Record<string, unknown>).agentId]))
    expect(idByNode.get('draft')).toBe('ID_writer')
    expect(idByNode.get('review')).toBe('ID_auditor')
    // no token survives anywhere in the id-canonical def
    expect(JSON.stringify(def)).not.toContain('member#')
  })

  test('validate by id: in-pool ids pass; an id outside the two-agent pool fails', () => {
    const tokenMap = dwPoolTokenMap(
      buildDwPoolMembers([
        { id: 'ID_writer', name: WRITER_NAME } as never,
        { id: 'ID_auditor', name: AUDITOR_NAME } as never,
      ]),
    )
    const { def } = dwGeneratedToWorkflowDef(TWO_NODE_GEN, tokenMap)
    expect(validateDynamicWorkflowDef(def, ['ID_writer', 'ID_auditor']).ok).toBe(true)
    // drop the auditor from the pool → its node is now outside-pool (by id)
    const codes = validateDynamicWorkflowDef(def, ['ID_writer']).issues.map((i) => i.code)
    expect(codes).toContain(DW_VALIDATION_CODES.agentOutsidePool)
  })

  test('unknown token fails closed as dw-agent-outside-pool, referencing the token', () => {
    const tokenMap = dwPoolTokenMap(
      buildDwPoolMembers([{ id: 'ID_writer', name: WRITER_NAME } as never]),
    )
    const { def, unknownTokens } = dwGeneratedToWorkflowDef(
      { nodes: [{ id: 'n', agentToken: 'member#7', promptTemplate: 'x', inputs: [] }], edges: [] },
      tokenMap,
    )
    expect(unknownTokens).toEqual(['member#7'])
    expect((def.nodes[0] as Record<string, unknown>).agentId).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Live generate → save-as: the LLM output is token-form; the persisted
// artifacts are id-canonical (scripted hooks — no subprocess).
// ---------------------------------------------------------------------------

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
        return Promise.resolve(next ?? { status: 'failed', outputs: {}, errorMessage: 'exhausted' })
      },
    },
  }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key]
    process.env[key] = value
  }
  return body().finally(() => {
    for (const key of Object.keys(env)) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

async function seedTask(
  db: DbClient,
  config: WorkgroupRuntimeConfig,
  dw: DwState,
  ownerUserId?: string,
): Promise<string> {
  const taskId = ulid()
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
    workflowSnapshot: JSON.stringify({
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: DW_ORCHESTRATOR_NODE_ID,
          kind: 'agent-single',
          agentName: 'aw-workflow-orchestrator',
        },
      ],
      edges: [],
    }),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
    ...(ownerUserId !== undefined ? { ownerUserId } : {}),
  })
  await db.insert(workgroupTaskState).values({
    taskId,
    gateStatus: 'idle',
    dwStateJson: JSON.stringify(dw),
    updatedAt: Date.now(),
  })
  return taskId
}

describe('RFC-223 PR-3b — live generate + save-as consume id form', () => {
  let db: DbClient
  let writerId: string
  let auditorId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const ids = await seedTwoAgents(db)
    writerId = ids.writerId
    auditorId = ids.auditorId
  })

  test('generate: LLM sees tokens; the stored generatedDef is id-canonical for BOTH agents', async () => {
    const config = twoAgentConfig(writerId, auditorId)
    const taskId = await seedTask(db, config, initialDwState())
    const { hooks, requests } = scriptedHooks([
      { status: 'done', outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: JSON.stringify(TWO_NODE_GEN) } },
    ])

    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')

    // the orchestrator prompt is token-only: no real names, no ids, no member ids
    const prompt = requests[0]!.promptTemplate
    expect(prompt).toContain('member#1')
    expect(prompt).toContain('member#2')
    expect(prompt).not.toContain(`### ${WRITER_NAME}`)
    expect(prompt).not.toContain(`### ${AUDITOR_NAME}`)
    expect(prompt).not.toContain(writerId)
    expect(prompt).not.toContain(auditorId)
    expect(prompt).not.toContain('m-writer')

    // the stored generatedDef is id-canonical for BOTH agents; no token leaked
    const dw = (await loadWorkgroupTaskState(db, taskId)).dwState
    const def = WorkflowDefinitionSchema.parse(dw?.generatedDef)
    const idByNode = new Map(def.nodes.map((n) => [n.id, (n as Record<string, unknown>).agentId]))
    expect(idByNode.get('draft')).toBe(writerId)
    expect(idByNode.get('review')).toBe(auditorId)
    expect(JSON.stringify(def)).not.toContain('member#')
  })

  test('reject-regeneration prompt speaks tokens (no real name in the machine-readable pool)', async () => {
    const config = twoAgentConfig(writerId, auditorId)
    const taskId = await seedTask(db, config, {
      ...initialDwState(),
      rejectRounds: 1,
      rejectionComment: '换个顺序',
    })
    const { hooks, requests } = scriptedHooks([
      { status: 'done', outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: JSON.stringify(TWO_NODE_GEN) } },
    ])
    const result = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    expect(result.kind).toBe('awaiting_review')
    const prompt = requests[0]!.promptTemplate
    expect(prompt).toContain('REJECTED')
    expect(prompt).toContain('换个顺序')
    // the regen pool is still token-headed
    expect(prompt).toContain('### member#1')
    expect(prompt).not.toContain(`### ${WRITER_NAME}`)
  })

  test('save-as persists an id-canonical workflow (nodes carry agentId, not a token/name)', async () => {
    const app = createApp({
      token: 'a'.repeat(64),
      configPath: '/tmp/aw-rfc223-pr3b-config.json',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    const user = await createUser(db, {
      username: 'carol',
      displayName: 'carol',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const token = (await createSession({ db, userId: user.id })).token

    // Generate first (token-form LLM output → id-canonical stored def).
    const config = twoAgentConfig(writerId, auditorId)
    const taskId = await seedTask(db, config, initialDwState(), user.id)
    const { hooks } = scriptedHooks([
      { status: 'done', outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: JSON.stringify(TWO_NODE_GEN) } },
    ])
    await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
    // (a gate holder exists — sanity: awaiting_review invariant held)
    const holders = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === DW_GATE_CAUSE,
    )
    expect(holders).toHaveLength(1)

    const res = await app.request(`/api/workgroup-tasks/${taskId}/dw-save-as-workflow`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'saved-pr3b', description: '' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: string }
    const wf = (await db.select().from(workflows).where(eq(workflows.id, body.id)))[0]
    const savedDef = JSON.parse(wf?.definition ?? '{}') as { nodes: Array<Record<string, unknown>> }
    // the persisted workflow is id-canonical — every agent node has agentId, and
    // no opaque token survived into the reusable workflow.
    const draftNode = savedDef.nodes.find((n) => n.id === 'draft')
    const reviewNode = savedDef.nodes.find((n) => n.id === 'review')
    expect(draftNode?.agentId).toBe(writerId)
    expect(reviewNode?.agentId).toBe(auditorId)
    expect(JSON.stringify(savedDef)).not.toContain('member#')
  })
})

describe('RFC-223 AC16 — two-owner same-name dynamic members stay id-canonical', () => {
  test('generate maps tokens to both frozen ids and execute selects each exact runtime profile', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aw-rfc223-ac16-'))
    const appHome = join(root, 'home')
    const repoPath = join(root, 'repo')
    const configCapturePath = join(root, 'runtime-config.jsonl')
    const argvCapturePath = join(root, 'runtime-argv.jsonl')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(repoPath, { recursive: true })

    const db = createInMemoryDb(MIGRATIONS)
    try {
      await runTestGit(['-C', repoPath, 'init', '-q', '-b', 'main'], 10_000)
      await runTestGit(['-C', repoPath, 'config', 'user.email', 'rfc223@test.invalid'], 10_000)
      await runTestGit(['-C', repoPath, 'config', 'user.name', 'RFC 223'], 10_000)
      await runTestGit(['-C', repoPath, 'commit', '-q', '--allow-empty', '-m', 'fixture'], 10_000)

      const ownerA = await createUser(db, {
        username: 'ac16-owner-a',
        displayName: 'AC16 owner A',
        role: 'user',
        password: 'longEnoughPasswordA',
      })
      const ownerB = await createUser(db, {
        username: 'ac16-owner-b',
        displayName: 'AC16 owner B',
        role: 'user',
        password: 'longEnoughPasswordB',
      })
      await db.insert(runtimes).values([
        {
          id: ulid(),
          name: 'ac16-owner-a-runtime',
          protocol: 'opencode',
          model: 'model/ac16-owner-a',
        },
        {
          id: ulid(),
          name: 'ac16-owner-b-runtime',
          protocol: 'opencode',
          model: 'model/ac16-owner-b',
        },
      ])

      const sharedName = 'shared-dynamic-member'
      const agentBase = {
        name: sharedName,
        description: 'same display identity, different canonical owner/id',
        outputs: ['out'],
        syncOutputsOnIterate: true,
        permission: {},
        skills: [],
        dependsOn: [],
        mcp: [],
        plugins: [],
        frontmatterExtra: {},
      }
      // Insert B first so an accidental name + first-row lookup deterministically
      // sends the owner-A node to the wrong tenant.
      const agentB = await createAgent(
        db,
        {
          ...agentBase,
          runtime: 'ac16-owner-b-runtime',
          bodyMd: 'AC16_OWNER_B_SYSTEM_PROMPT',
        },
        { ownerUserId: ownerB.id },
      )
      const agentA = await createAgent(
        db,
        {
          ...agentBase,
          runtime: 'ac16-owner-a-runtime',
          bodyMd: 'AC16_OWNER_A_SYSTEM_PROMPT',
        },
        { ownerUserId: ownerA.id },
      )

      const config: WorkgroupRuntimeConfig = {
        workgroupId: 'wg-ac16-same-name',
        workgroupName: 'ac16-same-name',
        mode: 'dynamic_workflow',
        leaderMemberId: null,
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 5,
        completionGate: false,
        instructions: '按冻结成员身份执行',
        goal: '验证同名成员不会串租户',
        members: [
          {
            id: 'member-owner-a',
            memberType: 'agent',
            agentName: sharedName,
            agentId: agentA.id,
            userId: null,
            displayName: 'owner-a-member',
            roleDesc: 'first',
          },
          {
            id: 'member-owner-b',
            memberType: 'agent',
            agentName: sharedName,
            agentId: agentB.id,
            userId: null,
            displayName: 'owner-b-member',
            roleDesc: 'second',
          },
        ],
      }
      const generated = {
        nodes: [
          {
            id: 'owner-a-step',
            agentToken: 'member#1',
            promptTemplate: 'AC16_OWNER_A_NODE',
            inputs: [],
          },
          {
            id: 'owner-b-step',
            agentToken: 'member#2',
            promptTemplate: 'AC16_OWNER_B_NODE {{source}}',
            inputs: [{ port: 'source', from: { nodeId: 'owner-a-step', portName: 'out' } }],
          },
        ],
        edges: [],
      }

      const taskId = await seedTask(db, config, initialDwState(), ownerA.id)
      await db.update(tasks).set({ repoPath, worktreePath: repoPath }).where(eq(tasks.id, taskId))

      const { hooks } = scriptedHooks([
        {
          status: 'done',
          outputs: { [ORCHESTRATOR_WORKFLOW_PORT]: JSON.stringify(generated) },
        },
      ])
      const generateResult = await runDynamicWorkflowGenerate({ db, taskId, log, hooks })
      expect(generateResult).toMatchObject({ kind: 'awaiting_review' })

      const generatedDw = (await loadWorkgroupTaskState(db, taskId)).dwState
      const generatedDef = WorkflowDefinitionSchema.parse(generatedDw?.generatedDef)
      const idByNode = new Map(
        generatedDef.nodes.map((node) => [node.id, (node as Record<string, unknown>).agentId]),
      )
      expect(idByNode.get('owner-a-step')).toBe(agentA.id)
      expect(idByNode.get('owner-b-step')).toBe(agentB.id)
      expect(JSON.stringify(generatedDef)).not.toContain('member#')

      const holder = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).find(
        (run) => run.rerunCause === DW_GATE_CAUSE,
      )
      expect(holder?.status).toBe('awaiting_review')
      await setNodeRunStatus({
        db,
        nodeRunId: holder!.id,
        to: 'done',
        allowedFrom: ['awaiting_review'],
        reason: 'ac16-test-approved',
      })
      const { rejectionComment: _comment, ...dwRest } = generatedDw as DwState

      await withEnv(
        {
          MOCK_OPENCODE_OUTPUTS: JSON.stringify({ out: 'done' }),
          MOCK_OPENCODE_CAPTURE_CONFIG_TO: configCapturePath,
          MOCK_OPENCODE_CAPTURE_ARGV_TO: argvCapturePath,
        },
        () =>
          resumeDynamicWorkflowExecution(
            db,
            taskId,
            {
              db,
              appHome,
              opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
              awaitScheduler: true,
              defaultPerNodeTimeoutMs: 10_000,
              defaultNodeRetries: 0,
            },
            {
              workflowSnapshot: JSON.stringify(generatedDef),
              dw: { ...dwRest, phase: 'executing' },
            },
          ),
      )

      const finalTask = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
      expect(finalTask?.status).toBe('done')

      const configRows = readFileSync(configCapturePath, 'utf-8')
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              agent: string
              model: string | null
              variant: string | null
              temperature: number | null
            },
        )
      const argvRows = readFileSync(argvCapturePath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { agent: string; prompt: string })
      expect(configRows).toEqual([
        { agent: sharedName, model: 'model/ac16-owner-a', variant: null, temperature: null },
        { agent: sharedName, model: 'model/ac16-owner-b', variant: null, temperature: null },
      ])
      expect(argvRows).toHaveLength(2)
      expect(argvRows[0]).toMatchObject({ agent: sharedName })
      expect(argvRows[0]?.prompt).toContain('AC16_OWNER_A_NODE')
      expect(argvRows[1]).toMatchObject({ agent: sharedName })
      expect(argvRows[1]?.prompt).toContain('AC16_OWNER_B_NODE')
    } finally {
      abortAllActiveTasks('rfc223-ac16-test-cleanup')
      db.$client.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
