// RFC-123 follow-up — enforce STOP CLARIFYING against a disobedient agent.
//
// 用户报（2026-06-29，RFC-123 之后）：「一个节点被跨节点反问了，但是没有自动切换为
// 继续反问」。根因 = 一个**显式停止**的节点（画布 toggle='stop' 或最新已答 'stop'
// directive），其 agent 不听 STOP CLARIFYING 指令、仍发出 <workflow-clarify>，而框架
// 当时只拦 output、不拦 clarify（runner else-if kind==='clarify' 照收）→ 节点"又被反问"
// 了，开关仍正确显示停止。RFC-123 让 toggle 真实持久化后才让这个"停了却还在问"显形。
// 用户拍板「强制停止」。
//
// 本文件锁定（对称于现有 clarify-required 的 output 拒绝）：
//   A. decideEnvelopeFollowup：`clarify-forbidden:` 前缀 → 同会话 followup、
//      reason='envelope-missing'（renderer 在 hasClarify=false 时渲染 output 协议）。
//   B. runner 强制：runNode(clarifyChannel.directive='stopped'——RFC-148 ADT，历史
//      clarifyStopped=true + hasClarifyChannel=false 对) + agent 发 clarify →
//      status='failed'、errorMessage 以 'clarify-forbidden' 开头、无 clarify
//      结果（不建会话）。
//   C.（RFC-183 反转）directive='suppressed'（review 重跑）+ 发 clarify → 同样
//      **拒绝**（重产出措辞）。历史上这档"接受但不邀请"是注入⟺接受唯一不对称的
//      活路径——prompt 零反问字节却收自愿反问；RFC-183 用户拍板改拒绝（工作组
//      host 轮的接受路径改挂 'delegated'，见 rfc183-clarify-invite-accept-symmetry）。
//   D. 源码 wiring 守卫：scheduler 算 clarifyStopped（仅显式 stop）+ 折进
//      clarifyChannel.directive；runner 经 RFC-183 clarifyDispositionFor 分类器拒。

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'
import { decideEnvelopeFollowup, type PreviousAttemptShape } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

// --- A. decideEnvelopeFollowup pure ----------------------------------------

// RFC-145: decide 入参从 errorMessage 前缀换 failureCode 列（runner 产出点自述）。
const PREV_BASE: PreviousAttemptShape = {
  status: 'failed',
  exitCode: 0,
  failureCode: 'clarify-forbidden',
  sessionId: 'opc_session_abc',
  agentTextCount: 10,
}

describe('RFC-123 A: decideEnvelopeFollowup clarify-forbidden', () => {
  test('clarify-forbidden → followup, reason=envelope-missing（renderer 在 stop 下渲染 output 协议）', () => {
    expect(decideEnvelopeFollowup(PREV_BASE)).toEqual({
      followup: true,
      reason: 'envelope-missing',
      failures: [],
    })
  })

  test('crashed (exitCode!==0) → 不 followup（沿用既有守卫）', () => {
    expect(decideEnvelopeFollowup({ ...PREV_BASE, exitCode: 137 })).toEqual({ followup: false })
  })
})

// --- B / C. runner enforcement ---------------------------------------------

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: ulid(),
    name: 'asker',
    description: 'an agent that may clarify',
    outputs: ['summary'],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'You may ask back.',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc123-stop-'))
  const worktreePath = join(appHome, 'worktree-fake')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
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

async function insertPendingNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'asker', status: 'pending' })
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
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

const CLARIFY_BODY = JSON.stringify({
  questions: [
    {
      id: 'q1',
      title: 'Pick a DB?',
      kind: 'single',
      recommended: true,
      options: ['Postgres', 'MySQL'],
    },
  ],
})

function runStoppedNode(h: Harness, nodeRunId: string, opts: { stopped?: true }) {
  return withEnv({ MOCK_OPENCODE_CLARIFY_BODY: CLARIFY_BODY }, () =>
    runNode({
      taskId: h.taskId,
      nodeRunId,
      nodeId: 'asker',
      agent: makeAgent(),
      inputs: {},
      worktreePath: h.worktreePath,
      templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
      skills: [],
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      db: h.db,
      // RFC-148: both variants keep ask-back OFF (directive !== 'mandatory' —
      // the historical effectiveHasClarifyChannel=false). B = explicit stop
      // ('stopped'; was clarifyStopped=true); C = review-rerun suppression
      // ('suppressed'; was clarifyStopped omitted).
      clarifyChannel: {
        kind: 'self',
        directive: opts.stopped === true ? 'stopped' : 'suppressed',
        injectStopNotice: false,
      },
    }),
  )
}

describe('RFC-123 B/C: runner rejects disobedient clarify only when explicitly stopped', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test("B: directive='stopped' + agent emits clarify → failed clarify-forbidden, no clarify result", async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runStoppedNode(h, nodeRunId, { stopped: true })
    expect(result.status).toBe('failed')
    expect(result.errorMessage ?? '').toMatch(/^clarify-forbidden/)
    expect(result.clarify).toBeUndefined()
  })

  test("C (RFC-183 反转): directive='suppressed' + agent emits clarify → rejected too (re-production wording)", async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runStoppedNode(h, nodeRunId, {})
    expect(result.status).toBe('failed')
    expect(result.errorMessage ?? '').toMatch(/^clarify-forbidden/)
    expect(result.errorMessage ?? '').toContain('re-production round does not accept ask-back')
    expect(result.clarify).toBeUndefined()
  })
})

// --- D. source wiring guards ------------------------------------------------

describe('RFC-123 D: stop-enforcement wiring guards', () => {
  const schedulerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const runnerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
    'utf8',
  )
  const norm = (s: string) => s.replace(/\s+/g, ' ')

  test('scheduler computes clarifyStopped from EXPLICIT stop only + folds it into the channel directive', () => {
    // RFC-132 (PR-C §7): a 'stop' answer writes the per-node clarify state (setNodeClarifyDirective),
    // so nodeStopOverride ALONE captures both the canvas toggle AND a latest answered 'stop' — the
    // former `|| clarifyContext?.directive === 'stop'` disjunct is gone (the flat context carries no
    // directive).
    expect(norm(schedulerSrc)).toContain(
      'const clarifyStopped = hasClarifyChannel && nodeStopOverride',
    )
    // RFC-148: the threading is no longer a scattered `clarifyStopped: true`
    // opt — the explicit stop lands as the ClarifyChannel ADT's 'stopped'
    // directive. RFC-165 (F12) slotted 'optional' between stopped and the
    // mandatory/suppressed pair (precedence stopped > optional >
    // mandatory/suppressed) — the lock follows the new ladder.
    expect(norm(schedulerSrc)).toContain(
      "directive: clarifyStopped ? ('stopped' as const) : clarifyOptional ? ('optional' as const) : effectiveHasClarifyChannel ? ('mandatory' as const) : ('suppressed' as const)",
    )
  })

  test('followup mapping: clarify-forbidden → re-demand output（RFC-145 查表格）', () => {
    // RFC-145: the mapping moved from the scheduler's startsWith chain into the
    // shared FOLLOWUP_POLICY table — the explicit downgrade row is the contract.
    const promptSrc = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts'),
      'utf-8',
    )
    expect(norm(promptSrc)).toContain("'clarify-forbidden': { reason: 'envelope-missing' }")
  })

  test('runner rejects clarify when explicitly stopped（且置 clarify-forbidden 码）', () => {
    // RFC-183: the stopped guard folded into the unified reject branch driven
    // by the shared clarifyDispositionFor classifier ('stopped' and
    // 'suppressed' both map to disposition 'reject'); the RFC-123 stop-round
    // wording is preserved byte-exact and picked by channel.directive.
    expect(norm(runnerSrc)).toContain(
      "const clarifyRejectDirective = clarifyDisposition === 'reject'",
    )
    expect(norm(runnerSrc)).toContain(
      "kind === 'clarify' && channel.kind !== 'none' && clarifyRejectDirective",
    )
    expect(norm(runnerSrc)).toContain(
      'node is in STOP CLARIFYING mode; emit <workflow-output>, not <workflow-clarify>',
    )
    expect(norm(runnerSrc)).toContain('CLARIFY_FORBIDDEN_PREFIX')
    expect(norm(runnerSrc)).toContain("failureCode = 'clarify-forbidden'")
  })
})
