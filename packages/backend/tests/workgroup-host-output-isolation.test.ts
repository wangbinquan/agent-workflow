// RFC-184 —— 工作组 host 轮输出隔离。
//
// 为什么这套测试存在：线上任务 01KXFE9668F0TJ7D2P720F42SE（全自动 leader_worker）
// 第一轮 leader 就以 `port-validation-path-empty-path` 秒挂。根因＝host 轮复用成员真实
// agent（`coder`，声明 outputKinds:{...:markdown_file}）原样喂通用 runNode；leader 按
// 协议只产 wg_assignments+wg_decision，漏产的业务端口被 parseEnvelope 补空串 → RFC-049
// 逐 kind 校验按 path<md> 拒空串 → 整个任务挂。且工作组引擎测试全部 stub 掉 runHostNode
// （rfc164-workgroup-engine.test.ts），真实 runNode 路径从未 e2e——这套测试正是补这个缺口。
//
// 锁三件事：
//   1. wgHostRolePorts 与 renderWgProtocolBlock 的 <port> 清单逐 role 对齐（镜像锁，
//      防协议块加/删端口而声明列表漂移）。
//   2. runNode 真实路径 红→绿：不投影（原样带 markdown_file outputKinds）→ 秒挂；
//      投影（outputs=wg 端口、outputKinds 清空）→ done、outputs 带 wg 端口、无校验错。
//   3. §2.4 持久化守卫：投影 + persistDeclaredOutputs:false → node_run_outputs 零行
//      （保持"host 轮零 output 行"不变式，防 clarify 老化 runIdsWithOutput 误吞已答 Q&A）；
//      缺省则落库——证明守卫只作用 host 轮。
// 外加源码文本锁，兜住 scheduler runHostNode / workgroupRunner 三处接线（真实 runHostNode
// 需 iso+git，单测难触，故文本锁兜底）。

import type { Agent, WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {
  WG_PORT_ASSIGNMENTS,
  WG_PORT_DECISION,
  WG_PORT_MESSAGES,
  WG_PORT_RESULT,
  WG_PORT_TASKS_ADD,
} from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { renderWgProtocolBlock, wgHostRolePorts } from '../src/services/workgroup/context'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

// ---------------------------------------------------------------------------
// 1. wgHostRolePorts —— 逐 role 端口 + 与 renderWgProtocolBlock 的镜像锁
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<WorkgroupRuntimeConfig> = {}): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 10,
    completionGate: false,
    autonomous: true, // clarify 邀请块无关本测试
    instructions: '',
    goal: 'audit the services',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '',
      },
    ],
    ...overrides,
  } as WorkgroupRuntimeConfig
}

/** ports the protocol block ACTUALLY instructs the agent to emit, from its text. */
function portsInProtocolBlock(
  role: 'leader' | 'worker' | 'fc_member',
  batch?: { count: number },
): Set<string> {
  const block = renderWgProtocolBlock(
    role,
    cfg({ mode: role === 'fc_member' ? 'free_collab' : 'leader_worker' }),
    '',
    undefined,
    batch,
  )
  const found = new Set<string>()
  for (const m of block.matchAll(/<port name="(wg_[^"]+)">/g)) found.add(m[1]!)
  return found
}

describe('RFC-184 — wgHostRolePorts', () => {
  test('leader emits assignments + messages + decision', () => {
    expect(new Set(wgHostRolePorts('leader'))).toEqual(
      new Set([WG_PORT_ASSIGNMENTS, WG_PORT_MESSAGES, WG_PORT_DECISION]),
    )
  })
  test('worker emits result + messages (no assignments / decision / tasks_add)', () => {
    expect(new Set(wgHostRolePorts('worker'))).toEqual(new Set([WG_PORT_RESULT, WG_PORT_MESSAGES]))
  })
  test('fc_member additionally emits tasks_add', () => {
    expect(new Set(wgHostRolePorts('fc_member'))).toEqual(
      new Set([WG_PORT_RESULT, WG_PORT_MESSAGES, WG_PORT_TASKS_ADD]),
    )
  })

  // 镜像锁：声明去解析的端口集合 == 协议块让 agent 产出的端口集合。任一侧漂移即红。
  test.each(['leader', 'worker', 'fc_member'] as const)(
    '%s port list mirrors renderWgProtocolBlock exactly',
    (role) => {
      expect(new Set(wgHostRolePorts(role))).toEqual(portsInProtocolBlock(role))
    },
  )

  // RFC-215 批分支镜像锁（实现门 C-3(a) 补交——design §6.2/§10-18 承诺）：批协议
  // 块换 wg_task_results、禁 wg_result，解析端口集合必须与协议块文本恒等；任一侧
  // （含 wg_tasks_add）漂移即红。含 N=1 批（恢复批只剩一卡也是批）。
  test.each([1, 2, 5])(
    'fc_member batch(count=%i) port list mirrors the batch protocol block',
    (count) => {
      expect(new Set(wgHostRolePorts('fc_member', { count }))).toEqual(
        portsInProtocolBlock('fc_member', { count }),
      )
    },
  )

  test('fc_member batch swaps wg_result for wg_task_results (tasks_add kept)', () => {
    const batch = new Set(wgHostRolePorts('fc_member', { count: 2 }))
    expect(batch.has('wg_task_results')).toBe(true)
    expect(batch.has('wg_result')).toBe(false)
    expect(batch.has(WG_PORT_MESSAGES)).toBe(true)
    expect(batch.has(WG_PORT_TASKS_ADD)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2 & 3. runNode 真实路径：红→绿 + 持久化守卫
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

// 复刻 `coder`：声明业务端口 software_design/test_design，两者 markdown_file。
function makeCoderAgent(): Agent {
  return {
    id: ulid(),
    name: 'coder',
    description: '',
    outputs: ['software_design', 'test_design'],
    outputKinds: { software_design: 'markdown_file', test_design: 'markdown_file' },
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
}

// scheduler runHostNode 对 host 轮做的投影：outputs→wg 端口、outputKinds 清空。
function projectLeader(agent: Agent): Agent {
  return { ...agent, outputs: wgHostRolePorts('leader'), outputKinds: undefined } as Agent
}

// leader 按协议只发 wg_assignments + wg_decision（不发 wg_messages，也不发自己的业务端口）。
const LEADER_ENVELOPE =
  '<workflow-output>\n' +
  `<port name="wg_assignments">[{"member":"planner","title":"t","brief":"b"}]</port>\n` +
  `<port name="wg_decision">{"action":"continue"}</port>\n` +
  '</workflow-output>'

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-wg-host-iso-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function insertNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'pending',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
  })
  return id
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
}

function runLeader(
  h: Harness,
  nodeRunId: string,
  agent: Agent,
  opts: { persistDeclaredOutputs?: boolean } = {},
): Promise<Awaited<ReturnType<typeof runNode>>> {
  return withEnv(
    {
      MOCK_OPENCODE_RAW_AGENT_TEXT: LEADER_ENVELOPE,
      MOCK_OPENCODE_EVENTS: '[]',
      MOCK_OPENCODE_EMIT_SESSION_ID: '1',
      OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
    },
    () =>
      runNode({
        taskId: h.taskId,
        nodeRunId,
        nodeId: 'n1',
        agent,
        inputs: {},
        worktreePath: h.worktreePath,
        templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
        // host 轮总带 wg 协议块（替换 agent-outputs 协议）
        workgroupProtocolBlock: 'WG PROTOCOL',
        skills: [],
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
        db: h.db,
        ...(opts.persistDeclaredOutputs !== undefined
          ? { persistDeclaredOutputs: opts.persistDeclaredOutputs }
          : {}),
      }),
  )
}

async function outputRows(db: DbClient, nodeRunId: string) {
  return db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
}

describe('RFC-184 — host projection over real runNode', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  // 红：不投影（原样 coder，带 markdown_file outputKinds）→ 漏产的 software_design 被补空串
  // → RFC-049 按 path<md> 拒空串 → 秒挂。这是 F42SE 的机制锁：谁将来误删投影，这条立刻红。
  test('WITHOUT projection: coder-as-leader dies with port-validation-path-empty-path', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await runLeader(h, nodeRunId, makeCoderAgent())
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('port-validation-path-empty-path')
  })

  // 绿：投影后（outputs=wg 端口、outputKinds 清空）→ done、拿到 wg 端口、无校验错。
  test('WITH projection: leader turn succeeds and returns wg ports', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await runLeader(h, nodeRunId, projectLeader(makeCoderAgent()), {
      persistDeclaredOutputs: false,
    })
    expect(result.status).toBe('done')
    expect(result.errorMessage).toBeUndefined()
    expect(result.outputs[WG_PORT_ASSIGNMENTS]).toContain('planner')
    expect(result.outputs[WG_PORT_DECISION]).toContain('continue')
    // 漏产的 wg_messages 以空串回到 result.outputs——正是 scheduler projectOutputs 过滤的对象。
    expect(result.outputs[WG_PORT_MESSAGES]).toBe('')
  })

  // §2.4 守卫：投影 + persistDeclaredOutputs:false → node_run_outputs 零行。
  test('host run persists ZERO node_run_outputs rows (clarify-aging invariant)', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await runLeader(h, nodeRunId, projectLeader(makeCoderAgent()), {
      persistDeclaredOutputs: false,
    })
    expect(result.status).toBe('done')
    expect(await outputRows(h.db, nodeRunId)).toHaveLength(0)
  })

  // 对照：同样投影 agent，但不传守卫（缺省 persist）→ 落库。证明"零行"确由守卫产生，
  // 而非投影本身；也证明守卫只作用于 host 轮（缺省＝普通节点行为）。
  test('WITHOUT the guard the same run WOULD persist rows (guard is load-bearing)', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const result = await runLeader(h, nodeRunId, projectLeader(makeCoderAgent()))
    expect(result.status).toBe('done')
    expect((await outputRows(h.db, nodeRunId)).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. 源码文本锁 —— scheduler / workgroupRunner / runner 接线（真实 runHostNode 单测难触）
// ---------------------------------------------------------------------------

describe('RFC-184 — source wiring locks', () => {
  const SRC = resolve(import.meta.dir, '..', 'src', 'services')
  const read = (f: string) => readFileSync(join(SRC, f), 'utf8')

  test('workgroupRunner wires hostOutputPorts at all three host call sites', () => {
    const src = read('workgroup/runner.ts')
    const count = (src.match(/hostOutputPorts:/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(3)
  })

  test('scheduler runHostNode projects (clears outputKinds), skips persistence, and filters empties', () => {
    const src = read('scheduler.ts')
    expect(src).toContain('outputKinds: undefined')
    expect(src).toContain('persistDeclaredOutputs: false')
    expect(src).toContain("v !== ''")
  })

  test('runner persist block is guarded by persistDeclaredOutputs !== false', () => {
    const src = read('runner.ts')
    expect(src).toContain('opts.persistDeclaredOutputs !== false')
  })
})
