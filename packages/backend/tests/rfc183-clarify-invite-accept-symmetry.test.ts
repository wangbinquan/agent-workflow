// RFC-183 — 反问「邀请 ⟺ 接受」对称收口（design/RFC-183-clarify-invite-accept-symmetry/）。
//
// 为什么这条测试存在：用户原则「不需要反问时不该给 agent 注入反问样例，反之同理」。
// 全仓审计后唯一双向不齐的活路径 = canvas `suppressed` 轮（评审驳回 / iterate 重产出
// × mandatory 接线）：prompt 零反问字节，runner 却接受自愿 <workflow-clarify> → 建
// session → park 等人。本文件锁定收口后的对称契约（谁動谁红）：
//
//   A. 主证（AC1/AC2）：directive='suppressed'（self 与 cross 一致）+ agent 发合法
//      clarify → failed + failureCode='clarify-forbidden' + 重产出专用措辞，无
//      clarify 结果（不建 session、不 park）。
//   B. 'delegated'（AC5）：工作组 / DW host 派发的新 directive——邀请随
//      workgroupProtocolBlock、接受权在 RFC-181 信封回调 + scheduler
//      clarify-no-channel 检查。runner 的 directive 判定链对其零裁决：无回调 →
//      照收（非自治组 park 路径的 runner 半边）；回调 true → RFC-181 autonomous
//      拒绝逐字节不变。
//   C. 未接线前置拒（AC2b，Codex 设计门二轮 P2#3）：kind:'none' 派发发合法 clarify
//      此前解析成 status='done' + 空 outputs——分片子运行 / 聚合等直调方只看
//      result.status，空产出伪装成功甚至合并 worktree。现由 runner 前置拒
//      （clarify-no-channel 消息、无 failureCode ⇒ 无 followup，对齐 scheduler
//      主路径补拒语义）。
//   D. 血统补丁（AC3b/AC3c，Codex 设计门 P2#1+P2#4）：clarify-answer /
//      cross-questioner 血统的技术性延续（process-retry / revival）不得退化
//      suppressed——continuesClarifyLineage 按持久 cause 链回溯；与 RFC-122 oracle
//      合成后维持 mandatory；对照组（review-reject 血统）维持 false。
//   E. 源码文本锁（AC7）：host 派发不得回退 `directive: 'suppressed'`；渲染与
//      runner 必须消费同一个 clarifyDispositionFor；oracle 必须吃血统判定。

import type { Agent, ClarifyChannelDirective, ClarifyDisposition } from '@agent-workflow/shared'
import { clarifyDispositionFor } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { resolveEffectiveClarifyChannel } from '../src/services/clarifyRounds'
import { continuesClarifyLineage } from '../src/services/nodeRunMint'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

// --- harness（沿用 rfc123-stop-enforcement 的 runNode 直驱形态） -------------

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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc183-symmetry-'))
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
  questions: [{ id: 'q1', title: 'Pick a DB?', kind: 'single', options: ['Postgres', 'MySQL'] }],
})

type ChannelOpt = { kind: 'none' } | { kind: 'self' | 'cross'; directive: ClarifyChannelDirective }

function runClarifyingNode(
  h: Harness,
  nodeRunId: string,
  channel: ChannelOpt,
  extra: { clarifySuppressed?: () => Promise<boolean> } = {},
) {
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
      clarifyChannel:
        channel.kind === 'none'
          ? { kind: 'none' }
          : { kind: channel.kind, directive: channel.directive, injectStopNotice: false },
      ...extra,
    }),
  )
}

// --- A. 主证：suppressed 拒绝（红→绿） ---------------------------------------

describe('RFC-183 A: suppressed 重产出轮拒绝自愿反问（self 与 cross 一致）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test("self：directive='suppressed' + 合法 clarify → failed clarify-forbidden（重产出措辞）、无 clarify 结果", async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runClarifyingNode(h, nodeRunId, { kind: 'self', directive: 'suppressed' })
    expect(result.status).toBe('failed')
    expect(result.errorMessage ?? '').toMatch(/^clarify-forbidden/)
    expect(result.errorMessage ?? '').toContain('re-production round does not accept ask-back')
    expect(result.clarify).toBeUndefined()
    const row = (await h.db.select().from(nodeRuns))[0]
    expect(row?.failureCode).toBe('clarify-forbidden')
  })

  test("cross：directive='suppressed' 同拒——不进入解析、不建 cross session 的 runner 半边", async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runClarifyingNode(h, nodeRunId, { kind: 'cross', directive: 'suppressed' })
    expect(result.status).toBe('failed')
    expect(result.errorMessage ?? '').toMatch(/^clarify-forbidden/)
    expect(result.clarify).toBeUndefined()
  })

  test('stopped 措辞不漂移（RFC-123 逐字节保留，与 suppressed 新措辞可分辨）', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runClarifyingNode(h, nodeRunId, { kind: 'self', directive: 'stopped' })
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe(
      'clarify-forbidden: node is in STOP CLARIFYING mode; emit <workflow-output>, not <workflow-clarify>',
    )
  })
})

// --- B. delegated：接受权外置，runner 零裁决 ----------------------------------

describe("RFC-183 B: 'delegated'（host 轮）——runner 不按 directive 拒", () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('无回调（非自治组的 runner 半边）：clarify 照收', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runClarifyingNode(h, nodeRunId, { kind: 'self', directive: 'delegated' })
    expect(result.status).toBe('done')
    expect(result.clarify).toBeDefined()
    expect(result.clarify?.questions).toHaveLength(1)
  })

  test('RFC-181 信封回调 true（自治组）：拒绝措辞逐字节不变', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runClarifyingNode(
      h,
      nodeRunId,
      { kind: 'self', directive: 'delegated' },
      { clarifySuppressed: () => Promise.resolve(true) },
    )
    expect(result.status).toBe('failed')
    expect(result.errorMessage).toBe(
      'clarify-forbidden: ask-back is OFF in this autonomous group; proceed with your best judgment and emit <workflow-output>',
    )
    expect(result.clarify).toBeUndefined()
  })
})

// --- C. 未接线前置拒（P2#3） --------------------------------------------------

describe("RFC-183 C: kind:'none' 自愿反问由 runner 前置拒（分片/聚合直调方不再见伪 done）", () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('合法 clarify + 无通道 → failed clarify-no-channel、无 clarify 结果、无 failureCode（无 followup）', async () => {
    const nodeRunId = await insertPendingNodeRun(h.db, h.taskId)
    const result = await runClarifyingNode(h, nodeRunId, { kind: 'none' })
    expect(result.status).toBe('failed')
    expect(result.errorMessage ?? '').toMatch(/^clarify-no-channel/)
    expect(result.clarify).toBeUndefined()
    const row = (await h.db.select().from(nodeRuns))[0]
    expect(row?.failureCode).toBeNull()
  })
})

// --- D. 血统补丁（P2#1 + P2#4）：纯函数 + 与 RFC-122 oracle 合成 ---------------

describe('RFC-183 D: continuesClarifyLineage —— 技术性延续不掉血统', () => {
  test('五类输入：直接续跑 / process-retry 链 / revival 链 / 实质 cause 终止 / 空表', () => {
    // 直接 clarify-answer 续跑（与旧 isClarifyRerunCause 行为一致）
    expect(continuesClarifyLineage(['clarify-answer'])).toBe(true)
    expect(continuesClarifyLineage(['cross-clarify-questioner-rerun'])).toBe(true)
    // AC3b：进程级重试链（含连续两跳）
    expect(continuesClarifyLineage(['process-retry', 'clarify-answer'])).toBe(true)
    expect(continuesClarifyLineage(['process-retry', 'process-retry', 'clarify-answer'])).toBe(true)
    // AC3c：daemon 重启 revival 链（含混合链 revival→process-retry→answer）
    expect(continuesClarifyLineage(['revival', 'clarify-answer'])).toBe(true)
    expect(continuesClarifyLineage(['revival', 'process-retry', 'clarify-answer'])).toBe(true)
    // 对照组：实质 cause 终止回溯——用户手动重跑 / 新逻辑轮 / 评审驳回血统不继承
    expect(continuesClarifyLineage(['process-retry', 'review-reject'])).toBe(false)
    expect(continuesClarifyLineage(['retry-node', 'clarify-answer'])).toBe(false)
    expect(continuesClarifyLineage(['stale-redispatch', 'clarify-answer'])).toBe(false)
    expect(continuesClarifyLineage(['revival', 'initial'])).toBe(false)
    // 空表 / 全技术 cause / 遗留 null——判 false（与旧门的边界降级一致）
    expect(continuesClarifyLineage([])).toBe(false)
    expect(continuesClarifyLineage(['process-retry', 'revival'])).toBe(false)
    expect(continuesClarifyLineage([null, 'clarify-answer'])).toBe(false)
  })

  test('与 RFC-122 oracle 合成：评审中 clarify-answer 血统的重试/恢复轮维持 mandatory，重产出轮维持 suppressed', () => {
    const oracle = (causesNewestFirst: Array<string | null>) =>
      resolveEffectiveClarifyChannel({
        hasClarifyChannel: true,
        contextDirective: undefined,
        nodeStopOverride: false,
        reviewActive: true,
        isClarifyRerun: continuesClarifyLineage(causesNewestFirst),
      })
    // AC3：答案续跑轮本体
    expect(oracle(['clarify-answer'])).toBe(true)
    // AC3b：其 process-retry 轮
    expect(oracle(['process-retry', 'clarify-answer'])).toBe(true)
    // AC3c：其 revival 恢复轮
    expect(oracle(['revival', 'process-retry', 'clarify-answer'])).toBe(true)
    // 对照：评审驳回重产出轮自身的重试——仍 false（=directive 'suppressed' → runner 拒）
    expect(oracle(['process-retry', 'review-reject'])).toBe(false)
    expect(oracle(['review-reject'])).toBe(false)
  })
})

// --- E. 分类器 + 源码文本锁 ----------------------------------------------------

describe('RFC-183 E: 穷举分类器与注入⟺接受同源锁', () => {
  test('clarifyDispositionFor 全枚举（satisfies 完备性锚——新 directive 不选边即编译红）', () => {
    const MATRIX = {
      mandatory: 'invite-mandatory',
      optional: 'invite-optional',
      suppressed: 'reject',
      stopped: 'reject',
      delegated: 'external',
    } satisfies Record<ClarifyChannelDirective, ClarifyDisposition>
    for (const [directive, disposition] of Object.entries(MATRIX)) {
      expect(clarifyDispositionFor(directive as ClarifyChannelDirective)).toBe(
        disposition as ClarifyDisposition,
      )
    }
  })

  const schedulerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )
  const runnerSrc = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'runner.ts'),
    'utf8',
  )
  const promptSrc = readFileSync(
    resolve(import.meta.dir, '..', '..', 'shared', 'src', 'prompt.ts'),
    'utf8',
  )
  const norm = (s: string) => s.replace(/\s+/g, ' ')

  test("host 派发不得回退 directive:'suppressed'（AC7）", () => {
    expect(norm(schedulerSrc)).toContain(
      "clarifyChannel: { kind: 'self', directive: 'delegated', injectStopNotice: false }",
    )
    expect(norm(schedulerSrc)).not.toContain(
      "clarifyChannel: { kind: 'self', directive: 'suppressed'",
    )
  })

  test('渲染与 runner 消费同一个 clarifyDispositionFor（注入⟺接受同源）', () => {
    expect(norm(promptSrc)).toContain('clarifyDispositionFor(channel.directive)')
    expect(norm(runnerSrc)).toContain(
      'const clarifyDisposition = clarifyWired ? clarifyDispositionFor(channel.directive) : undefined',
    )
    expect(norm(runnerSrc)).toContain(
      "const clarifyRejectDirective = clarifyDisposition === 'reject'",
    )
    expect(norm(runnerSrc)).toContain("kind === 'clarify' && !clarifyWired")
  })

  test('oracle 吃血统判定而非裸 cause（P2#1/P2#4 防回退）', () => {
    expect(norm(schedulerSrc)).toContain('isClarifyRerun: clarifyLineageContinues')
    expect(norm(schedulerSrc)).toContain('continuesClarifyLineage(lineageCauses)')
  })
})
