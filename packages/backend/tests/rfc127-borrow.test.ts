// RFC-127 借壳顶替 — PR-A 借壳基建（dormant：无 stamp 时不改行为）。
//
// 锁两件可断言核心：
//   1. buildBorrowedAgent —— effective agent = X 的脑子 (body/model/runtime/
//      readonly) + 原节点 P 的输出端口契约 (outputs/outputKinds)。这是借壳的
//      纯函数核心（design §3.3 / Codex F2）：runNode 的渲染/校验/持久化都读
//      agent.outputs/outputKinds，传 effective agent 即全程用 P 的契约。
//   2. node_runs.agent_override_name (migration 0067) —— mint 工厂写出/默认 null。
//
// scheduler.runOneNode 的借壳解析 + F1 (effectiveResumeSessionId=undefined) 由
// PR-B 激活路径（dispatch stamp override）端到端覆盖；此处锁纯函数 + 列持久化。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { Agent } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns } from '../src/db/schema'
import { buildBorrowedAgent } from '../src/services/agent'
import { mintNodeRun } from '../src/services/nodeRunMint'

describe('RFC-127 buildBorrowedAgent — X 的脑子 + P 的输出端口契约', () => {
  const X = {
    name: 'X',
    bodyMd: 'X brain',
    runtime: 'rt-x',
    outputs: ['xout'],
    outputKinds: { xout: 'text' },
  } as unknown as Agent
  const P = {
    name: 'P',
    bodyMd: 'P brain',
    runtime: 'rt-p',
    outputs: ['code', 'notes'],
    outputKinds: { code: 'file' },
  } as unknown as Agent

  test('keeps X brain (name/body/readonly/runtime)', () => {
    const eff = buildBorrowedAgent(X, P)
    expect(eff.name).toBe('X')
    expect(eff.bodyMd).toBe('X brain')
    expect(eff.runtime).toBe('rt-x')
  })

  test('takes P output port contract (outputs/outputKinds)', () => {
    const eff = buildBorrowedAgent(X, P)
    expect(eff.outputs).toEqual(['code', 'notes'])
    expect(eff.outputKinds).toEqual({ code: 'file' })
  })

  test('does not mutate either input', () => {
    buildBorrowedAgent(X, P)
    expect(X.outputs).toEqual(['xout'])
    expect(P.bodyMd).toBe('P brain')
  })
})

describe('RFC-127 node_runs.agent_override_name persistence (migration 0067)', () => {
  const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
  const TASK_ID = 'task-borrow'
  let db: DbClient
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await db.run(sql`INSERT INTO workflows (id, name, definition) VALUES ('wf', 'f', '{}')`)
    await db.run(sql`
      INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
        base_branch, branch, status, inputs, started_at, schema_version)
      VALUES (${TASK_ID}, 'b', 'wf', '{}', '/tmp/r', '/tmp/w', 'main', 'b', 'running', '{}', 1, 1)
    `)
  })

  test('override persists; default null', async () => {
    const id = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n1',
      status: 'pending',
      cause: 'initial',
      overrides: { agentOverrideName: 'agent-x' },
    })
    const row = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!
    expect(row.agentOverrideName).toBe('agent-x')

    const id2 = await mintNodeRun(db, {
      taskId: TASK_ID,
      nodeId: 'n2',
      status: 'pending',
      cause: 'initial',
    })
    const row2 = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id2)))[0]!
    expect(row2.agentOverrideName).toBeNull()
  })
})

// runOneNode is a ~340-line hot-path function not directly unit-testable; this
// source-text lock is the minimum backstop that the borrow wiring (read override
// → buildBorrowedAgent → F1 session clear) isn't silently removed by a refactor.
// End-to-end (a borrowed pending row actually runs under X with P's contract) is
// covered by PR-B's integration once dispatch stamps the override.
describe('RFC-127 scheduler borrow wiring (source-level lock)', () => {
  const SCHEDULER_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')
  test('reads agent_override_name + builds effective agent + F1 clears session', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf8')
    // T1/T2: the pending row's override column is read before agent resolution.
    expect(src).toContain('agentOverrideName')
    // F2: effective agent = X's brain + P's output port contract.
    expect(src).toContain('buildBorrowedAgent(borrowed, nodeAgent)')
    // F1: a borrowed row (when NOT a same-attempt follow-up) drops to a fresh
    // session — `isBorrowed ? undefined`. Follow-up wins for borrowed too (P2).
    expect(src).toMatch(/isBorrowed\s*\?\s*undefined/)
  })
})

// RFC-127 AC-9 — borrow prompt isolation: the reassigner's identity / attribution NEVER
// reaches the borrowed run (沿用 RFC-099 / RFC-120 D8「归属不进 prompt」铁律). Two layers
// mirror rfc099-prompt-isolation: (1) source — the borrow wiring references no attribution
// column; (2) runtime — buildBorrowedAgent surfaces only X's agent def + P's output contract.
// If layer 1 goes red, someone wired an attribution column into the borrow path; do NOT
// "fix" the test — re-read RFC-127 proposal 目标 #6 / AC-9.
describe('RFC-127 AC-9 — borrow prompt isolation (attribution never reaches the borrowed run)', () => {
  const X = { name: 'X', bodyMd: 'X brain', outputs: ['xout'] } as unknown as Agent
  const P = {
    name: 'P',
    bodyMd: 'P brain',
    outputs: ['code'],
  } as unknown as Agent

  test('source: buildBorrowedAgent wires only agent def + P outputs (no attribution)', () => {
    const src = readFileSync(resolve(import.meta.dir, '..', 'src', 'services', 'agent.ts'), 'utf8')
    const i = src.indexOf('export function buildBorrowedAgent')
    expect(i).toBeGreaterThan(-1)
    const fn = src.slice(i, i + 240)
    expect(fn).toMatch(/\.\.\.borrowed/)
    expect(fn).not.toMatch(
      /confirmedBy|confirmed_by|userId|user_id|reassign|decidedBy|displayName|actor/i,
    )
  })

  test('source: borrow resolvers read graph node ids only — no attribution column', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'taskQuestionDispatch.ts'),
      'utf8',
    )
    const i = src.indexOf('export async function resolveBorrowForNode')
    const j = src.indexOf('async function buildFrontierMintPlan')
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    // resolveBorrowForNode + resolveDesigner/ImmediateBorrowForNode + isRoundEntryConsumed: they
    // read overrideTargetNodeId / defaultTargetNodeId (graph node ids) + askingNodeRunId (a run
    // id) + resolve agentName — NEVER the attribution columns (confirmedBy / confirmedByRole /
    // a reassigner user id / display name).
    const region = src.slice(i, j)
    expect(region).not.toMatch(/confirmedBy|confirmed_by|confirmedByRole|displayName/i)
  })

  test('runtime: the borrowed agent object carries no attribution field', () => {
    const eff = buildBorrowedAgent(X, P)
    // only X's agent def + P's outputs — no user id / role / reassigner leaks into the object
    // the runner later turns into prompt context.
    expect(JSON.stringify(eff)).not.toMatch(/confirmedBy|userId|reassign|decidedBy|displayName/i)
    expect(eff.name).toBe('X')
    expect(eff.outputs).toEqual(['code'])
  })
})
