// RFC-243 PR-4 — call-workgroup 节点端到端（design §6.3）。
//
// Locks in:
//   1. 父工作流的 call-workgroup 节点从冻结闭包（workgroups 叶：完整 roster）
//      经 startWorkgroupTaskFromFrozen 起独立工作组子任务：leader 派单 →
//      worker 干活 → leader declare done 全链在子任务内真实跑通
//      （scenario-opencode 真子进程，rfc186 同 harness）。
//   2. goalTemplate 父侧渲染：{{port}} 展开为上游端口值，渲染产物是子任务的
//      字面 goal（落 workgroup_config_json）。
//   3. 结果锚（§6.4）：engine done 分支 stamp result_message_id → 调用行
//      `result` 端口 = leader done decision 的 body → 父 output 节点消费。
//   4. 子任务行：workgroupId 判别（taskExecutionKind='workgroup'）+
//      parentTaskId/spaceKind='inherited' 正交并存。
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { and, eq } from 'drizzle-orm'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows, workgroupTaskState } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { createAgent } from '../src/services/agent'
import { createWorkgroup } from '../src/services/workgroups'
import { abortAllActiveTasks } from '../src/services/task'
import { __resetRecoveryCountersForTest } from '../src/services/recovery'
import { buildActor } from '../src/auth/actor'
import { runGit } from '../src/util/git'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')
const FLOW_TIMEOUT_MS = 30_000
setDefaultTimeout(FLOW_TIMEOUT_MS + 10_000)

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc243-wg-'))
  const appHome = join(tmp, 'home')
  const stateDir = join(tmp, 'state')
  const planFile = join(tmp, 'plan.json')
  const repoPath = join(tmp, 'repo')
  const worktreePath = join(tmp, 'wt')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  for (const p of [repoPath, worktreePath]) {
    mkdirSync(p, { recursive: true })
    await runGit(p, ['init', '-b', 'main'])
    await runGit(p, ['config', 'user.email', 't@t.test'])
    await runGit(p, ['config', 'user.name', 't'])
    writeFileSync(join(p, 'README.md'), '# r\n')
    await runGit(p, ['add', '.'])
    await runGit(p, ['commit', '-m', 'init'])
  }
  const previousPlan = process.env.SCENARIO_PLAN_FILE
  const previousState = process.env.SCENARIO_STATE_DIR
  process.env.SCENARIO_PLAN_FILE = planFile
  process.env.SCENARIO_STATE_DIR = stateDir
  const db = createInMemoryDb(MIGRATIONS)
  await seedTestDefaultOpencodeRuntime(db)
  return {
    db,
    appHome,
    repoPath,
    worktreePath,
    stateDir,
    planFile,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true })
      if (previousPlan === undefined) delete process.env.SCENARIO_PLAN_FILE
      else process.env.SCENARIO_PLAN_FILE = previousPlan
      if (previousState === undefined) delete process.env.SCENARIO_STATE_DIR
      else process.env.SCENARIO_STATE_DIR = previousState
    },
  }
}

const actor = buildActor({
  user: {
    id: 'u-rfc243',
    username: 'rfc243',
    displayName: 'rfc243',
    role: 'admin',
    status: 'active',
  },
  source: 'daemon',
})

async function seedAgent(db: DbClient, name: string): Promise<string> {
  const agent = await createAgent(db, {
    name,
    description: name,
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: `you are ${name}`,
  })
  return agent.id
}

describe('RFC-243 e2e — call-workgroup 全链', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => {
    abortAllActiveTasks('test-cleanup')
    __resetRecoveryCountersForTest()
    h?.cleanup()
  })

  test('冻结闭包起工作组子任务 → leader/worker 真实回合 → result 锚回填父端口', async () => {
    const leadId = await seedAgent(h.db, 'wg-lead')
    const writerId = await seedAgent(h.db, 'wg-writer')
    const group = await createWorkgroup(
      h.db,
      {
        name: 'e2e-wg',
        description: '',
        instructions: '章程：小步快跑',
        mode: 'leader_worker',
        leaderDisplayName: 'lead',
        autonomous: true,
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 8,
        completionGate: false,
        members: [
          { memberType: 'agent', agentId: leadId, displayName: 'lead', roleDesc: '协调' },
          { memberType: 'agent', agentId: writerId, displayName: 'writer', roleDesc: '产出' },
        ],
      } as Parameters<typeof createWorkgroup>[1],
      { ownerUserId: actor.user.id, actor },
    )

    // leader 第 1 轮派单、第 2 轮 declare done；worker 交付一张卡。
    writeFileSync(
      h.planFile,
      JSON.stringify({
        'wg-lead': [
          {
            output: {
              wg_assignments: JSON.stringify([
                { member: 'writer', title: 'write alpha', brief: 'create alpha.txt' },
              ]),
              wg_decision: JSON.stringify({ action: 'continue' }),
            },
          },
          {
            output: {
              wg_decision: JSON.stringify({ action: 'done', summary: 'ALPHA DELIVERED' }),
            },
          },
        ],
        'wg-writer': [{ output: { wg_result: JSON.stringify({ summary: 'wrote alpha.txt' }) } }],
      }),
    )

    // 父工作流：input → call-workgroup(goalTemplate 渲染 {{req}}) → output。
    const parentDef = {
      $schema_version: 4,
      inputs: [{ kind: 'text', key: 'req', label: 'r' }],
      nodes: [
        { id: 'pin', kind: 'input', inputKey: 'req' } as WorkflowNode,
        {
          id: 'callwg',
          kind: 'call-workgroup',
          workgroupName: 'e2e-wg',
          goalTemplate: '目标：{{req}}',
        } as WorkflowNode,
        {
          id: 'pout',
          kind: 'output',
          ports: [{ name: 'report', bind: { nodeId: 'callwg', portName: 'result' } }],
        } as WorkflowNode,
      ],
      edges: [
        {
          id: 'pe1',
          source: { nodeId: 'pin', portName: 'req' },
          target: { nodeId: 'callwg', portName: 'req' },
        },
      ],
    } as unknown as WorkflowDefinition
    const parentWorkflowId = ulid()
    await h.db.insert(workflows).values({
      id: parentWorkflowId,
      name: 'parent-wg-wf',
      definition: JSON.stringify(parentDef),
    })
    const closure = JSON.stringify({
      workflows: {},
      workgroups: { 'e2e-wg': { id: group.id, version: group.version, group } },
    })
    const parentTaskId = ulid()
    await h.db.insert(tasks).values({
      id: parentTaskId,
      name: 'rfc243-wg-parent',
      workflowId: parentWorkflowId,
      workflowSnapshot: JSON.stringify(parentDef),
      repoPath: h.repoPath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${parentTaskId}`,
      status: 'pending',
      inputs: JSON.stringify({ req: '产出 alpha' }),
      startedAt: Date.now(),
      launchOrigin: 'webhook',
      refClosureJson: closure,
    })

    await runTask({
      db: h.db,
      taskId: parentTaskId,
      appHome: h.appHome,
      binaryOverride: ['bun', 'run', SCENARIO_STUB],
      defaultNodeRetries: DEFAULT_PROTOCOL_RETRY_BUDGET,
      defaultPerNodeTimeoutMs: 10_000,
    })

    const parent = (await h.db.select().from(tasks).where(eq(tasks.id, parentTaskId)))[0]!
    expect(parent.status).toBe('done')

    const children = await h.db.select().from(tasks).where(eq(tasks.parentTaskId, parentTaskId))
    expect(children.length).toBe(1)
    const child = children[0]!
    expect(child.status).toBe('done')
    expect(child.spaceKind).toBe('inherited')
    expect(child.workgroupId).toBe(group.id)
    expect(child.launchOrigin).toBe(parent.launchOrigin)
    // goalTemplate 渲染进冻结 config（{{req}} → 上游端口值）。
    expect(child.workgroupConfigJson ?? '').toContain('目标：产出 alpha')

    // 结果锚已 stamp 且指向 leader done decision。
    const state = (
      await h.db.select().from(workgroupTaskState).where(eq(workgroupTaskState.taskId, child.id))
    )[0]!
    expect(state.resultMessageId).not.toBeNull()

    const callRow = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, parentTaskId), eq(nodeRuns.nodeId, 'callwg')))
    ).find((r) => r.parentNodeRunId === null)!
    expect(callRow.status).toBe('done')
    expect(callRow.childTaskId).toBe(child.id)
    const callOutputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, callRow.id))
    expect(callOutputs.find((o) => o.portName === 'result')?.content).toBe('ALPHA DELIVERED')

    // 父 output 节点消费 result。
    const outRow = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, parentTaskId), eq(nodeRuns.nodeId, 'pout')))
    )[0]!
    const outPorts = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, outRow.id))
    expect(outPorts.find((o) => o.portName === 'report')?.content).toBe('ALPHA DELIVERED')
  })
})
