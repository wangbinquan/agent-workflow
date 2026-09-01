// RFC-313 T8 — 会话升级的 scheduler 集成：接续链触顶后必须整体换一个干净会话重来。
//
// 为什么这条测试存在：RFC-042 之后，「agent 每次正常退出、每次说话、每次不吐信封」
// 这个最典型的场景里，全部重试都落在同一个越来越长的会话里（decideEnvelopeFollowup
// 只按上一次 attempt 的形态二选一，预算是一条直线烧下去的），一次干净重启都不会发生
// ——而根因若是「上下文打满 / 模型陷在循环里」，每条纠错提示还在加剧它。本文件用
// mock-opencode 的 argv 日志直接钉死 attempt 序列的**形状**：
//   ① 链触顶那一次必须无 `--session`（真的新会话）、prompt 是完整重渲染 + 告知段；
//   ② 关闭开关（sessionRestartBudget=0）下序列与 RFC-313 落地前逐格一致；
//   ③ 链中途崩溃只归零链长、**不**消耗升级预算（崩溃是别无选择，不是主动放弃）。
// 形状判定本身的真值表在 packages/shared/tests/rfc313-retry-shape.test.ts。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { RETRY_ATTEMPT_CAP_CEILING } from '../src/platform/contracts/retryAttemptCap'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunEvents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { countAgentTextEvents } from '../src/modules/task-execution/composition/nodeMechanics'
import { SqliteNodeExecutionPersistence } from '../src/modules/task-execution/infrastructure/sqliteNodeExecutionPersistence'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { mintNodeRun } from '../src/services/nodeRunMint'
import { ASSEMBLY_MAX_ATTEMPTS } from '../src/services/schedulerAssembly'
import { readNodeRunPrompt } from '../src/services/nodeRunPrompt'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const RESTART_NOTICE_MARK = 'Note on an earlier attempt'
const PROMPT_TEMPLATE = 'RFC313-TEMPLATE-MARKER: do the work'

const nodePersistence = (db: DbClient) => new SqliteNodeExecutionPersistence(db)

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  argvLog: string
  counterFile: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc313-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const argvLog = join(appHome, 'argv.log')
  writeFileSync(argvLog, '')
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    argvLog,
    counterFile: join(appHome, 'counter'),
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: 'rfc-313',
    outputs: JSON.stringify(['design']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

function singleAgentDef(agentId: string): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [],
    nodes: [
      { id: 'n1', kind: 'agent-single', agentId, agentName: 'a1', promptTemplate: PROMPT_TEMPLATE },
    ],
    edges: [],
  }
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

/** 每次 spawn 是否带了 `--session`（true = 续跑同一个会话）。 */
function resumeFlags(argvLogPath: string): boolean[] {
  return readFileSync(argvLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line).argv as string[]).includes('--session'))
}

async function attemptsOf(h: Harness, taskId: string) {
  const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  return rows.sort((a, b) => (a.retryIndex ?? 0) - (b.retryIndex ?? 0))
}

async function payloadsOf(h: Harness, nodeRunId: string): Promise<string[]> {
  const rows = await h.db.select().from(nodeRunEvents).where(eq(nodeRunEvents.nodeRunId, nodeRunId))
  return rows.map((r) => r.payload)
}

describe('RFC-313 会话升级', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('纯信封失败：接续 → 触顶升级（换会话）→ 再接续，共 (1+F)×(1+R) 次 attempt', async () => {
    const agentId = await seedAgent(h.db, 'a1')
    const taskId = await seedTask(h, singleAgentDef(agentId))
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc313',
        MOCK_OPENCODE_SKIP_ENVELOPE: '1',
        MOCK_OPENCODE_SESSION_ID_FOLLOWS_RESUME: '1', // 每次都正常退出、说了话、就是不吐信封
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          defaultNodeRetries: 1, // followupBudget
          sessionRestartBudget: 1, // restartBudget ⇒ cap = 2×2 = 4
        }),
    )

    // ① attempt 序列的形状：首发新会话 → 接续 → **升级换会话** → 接续。
    expect(resumeFlags(h.argvLog)).toEqual([false, true, false, true])

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')

    const rows = await attemptsOf(h, taskId)
    expect(rows.map((r) => r.retryIndex)).toEqual([0, 1, 2, 3])
    const restartRow = rows[2]!
    const followupRow = rows[1]!

    // ② 升级行：有 rfc313 审计事件、无 rfc042 续跑事件。
    const restartPayloads = await payloadsOf(h, restartRow.id)
    const restartAudit = restartPayloads.find((p) => p.includes('[rfc313/session-restart]'))
    expect(restartAudit).toBeTruthy()
    expect(restartAudit).toContain('"reason":"envelope-missing"')
    expect(restartAudit).toContain('"restartsUsed":1')
    expect(restartPayloads.some((p) => p.includes('[rfc042/envelope-followup]'))).toBe(false)

    // 接续行则相反——两种重试在事件流上可区分（用户拍板不新增 rerun cause，
    // 事件流就是唯一区分面）。
    const followupPayloads = await payloadsOf(h, followupRow.id)
    expect(followupPayloads.some((p) => p.includes('[rfc042/envelope-followup]'))).toBe(true)
    expect(followupPayloads.some((p) => p.includes('[rfc313/session-restart]'))).toBe(false)

    // ③ 会话本身必须是新的（不只是 argv 里少了个 --session）：升级行捕获到的
    //    native session id 与首发不同，而接续行与首发相同。
    expect(rows[0]!.opencodeSessionId).toBeTruthy()
    expect(followupRow.opencodeSessionId).toBe(rows[0]!.opencodeSessionId)
    expect(restartRow.opencodeSessionId).not.toBe(rows[0]!.opencodeSessionId)
    expect(rows[3]!.opencodeSessionId).toBe(restartRow.opencodeSessionId)

    // ④ nonce 必须换新：接续复用 nonce（同一个会话见过它），升级不能复用。
    expect(restartRow.envelopeNonce).not.toBe(rows[0]!.envelopeNonce)
    expect(followupRow.envelopeNonce).toBe(rows[0]!.envelopeNonce)

    // ⑤ prompt：升级是**完整重渲染 + 告知**；接续是短纠错提示、且绝不带告知。
    const runsDir = join(h.appHome, 'runs')
    const restartPrompt = readNodeRunPrompt(restartRow, runsDir) ?? ''
    const followupPrompt = readNodeRunPrompt(followupRow, runsDir) ?? ''
    const firstPrompt = readNodeRunPrompt(rows[0]!, runsDir) ?? ''
    expect(restartPrompt).toContain(PROMPT_TEMPLATE)
    expect(restartPrompt).toContain('<workflow-output')
    expect(restartPrompt).toContain(RESTART_NOTICE_MARK)
    expect(followupPrompt).not.toContain(PROMPT_TEMPLATE)
    expect(followupPrompt).not.toContain(RESTART_NOTICE_MARK)
    expect(firstPrompt).not.toContain(RESTART_NOTICE_MARK)
    // 告知排在协议块之后——最靠近回复位置的内容最显著。
    expect(restartPrompt.indexOf(RESTART_NOTICE_MARK)).toBeGreaterThan(
      restartPrompt.indexOf('<workflow-output'),
    )
  }, 120_000)

  test('关闭开关：sessionRestartBudget=0 时序列与 RFC-313 落地前逐格一致', async () => {
    const agentId = await seedAgent(h.db, 'a1')
    const taskId = await seedTask(h, singleAgentDef(agentId))
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc313_off',
        MOCK_OPENCODE_SKIP_ENVELOPE: '1',
        MOCK_OPENCODE_SESSION_ID_FOLLOWS_RESUME: '1',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          defaultNodeRetries: 1,
          sessionRestartBudget: 0, // ⇒ cap = 2×1 = 2，与落地前的 1+retries 相同
        }),
    )
    expect(resumeFlags(h.argvLog)).toEqual([false, true])
    const rows = await attemptsOf(h, taskId)
    expect(rows.length).toBe(2)
    for (const row of rows) {
      const payloads = await payloadsOf(h, row.id)
      expect(payloads.some((p) => p.includes('[rfc313/session-restart]'))).toBe(false)
      expect(readNodeRunPrompt(row, join(h.appHome, 'runs')) ?? '').not.toContain(
        RESTART_NOTICE_MARK,
      )
    }
  }, 120_000)

  test('链中途崩溃：归零链长但**不**消耗升级预算，之后仍能真正升级一次', async () => {
    // 首次 attempt 崩溃（exit 1 + 无信封）→ RFC-042 判据落空 → fresh（不吃预算）；
    // 其后每次都是「正常退出但没信封」→ 接续一次 → 触顶 → 升级。若崩溃错误地吃掉了
    // 升级预算，第三次就会变成又一次接续（--session），这条断言会立刻转红。
    const agentId = await seedAgent(h.db, 'a1')
    const taskId = await seedTask(h, singleAgentDef(agentId))
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EMIT_SESSION_ID: 'opc_rfc313_crash',
        MOCK_OPENCODE_SKIP_ENVELOPE: '1',
        MOCK_OPENCODE_SESSION_ID_FOLLOWS_RESUME: '1',
        MOCK_OPENCODE_FAIL_COUNTER: h.counterFile,
        MOCK_OPENCODE_FAIL_UNTIL: '1', // 第 1 次 exit 1
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          defaultNodeRetries: 1,
          sessionRestartBudget: 1,
        }),
    )
    // 崩溃 → fresh（无 session）→ 接续（有 session）→ 升级（无 session）
    expect(resumeFlags(h.argvLog)).toEqual([false, false, true, false])
    const rows = await attemptsOf(h, taskId)
    const restartRow = rows[3]!
    const payloads = await payloadsOf(h, restartRow.id)
    expect(payloads.some((p) => p.includes('[rfc313/session-restart]'))).toBe(true)
  }, 120_000)

  test('上限是乘积、与失败种类无关：纯崩溃的节点同样跑满 (1+F)×(1+R)', async () => {
    // 刻意钉住这个后果而不是让它暗中生效：升级预算只在**主动升级**时被消耗，但
    // attempt 上限是两个预算的乘积、不区分失败种类，所以一个每次都崩溃（永远走不到
    // 升级）的节点也会从 1+F 次涨到 (1+F)×(1+R) 次。这是 proposal 成本表里
    // 「最坏 attempt 4→8」的完整含义——用户逐项确认过的正是这个上限。
    const agentId = await seedAgent(h.db, 'a1')
    const taskId = await seedTask(h, singleAgentDef(agentId))
    await withEnv(
      {
        MOCK_OPENCODE_EXPECT_FOLLOWUP_ARGV: h.argvLog,
        MOCK_OPENCODE_EXIT_CODE: '9', // 每次都崩溃 ⇒ RFC-042 判据恒落空 ⇒ 恒 fresh
        MOCK_OPENCODE_SKIP_ENVELOPE: '1',
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
          defaultNodeRetries: 1,
          sessionRestartBudget: 1,
        }),
    )
    const flags = resumeFlags(h.argvLog)
    expect(flags.length).toBe(4) // (1+1)×(1+1)
    expect(flags).toEqual([false, false, false, false]) // 一次接续都没有
    const rows = await attemptsOf(h, taskId)
    for (const row of rows) {
      const payloads = await payloadsOf(h, row.id)
      // 升级预算一格没被消耗——崩溃从来不是"主动放弃会话"。
      expect(payloads.some((p) => p.includes('[rfc313/session-restart]'))).toBe(false)
    }
  }, 120_000)

  test('框架审计事件不得被算作「模型说过话」（实现门 P1-2 回归锁）', async () => {
    // 红→绿的那条红：三个框架审计事件（rfc042/rfc049/rfc313）与模型输出共用
    // kind='text'，且都写在**新铸的那一行**上。不排除的话，第 1 次之后每一次 attempt
    // 的计数恒 ≥1 ⇒ RFC-042「模型必须说过话」的判据当场失效 ⇒ 一个一个字都没吐的
    // 会话会被错误地续跑（复用脏树 + 旧 nonce + 短提示），而正解是换新会话重来。
    const taskId = await seedTask(h, singleAgentDef(await seedAgent(h.db, 'a1')))
    // 用仓内既有的铸行原语而不是手写 INSERT：手写行既缺必填列（nodePath 等），
    // 也会与真实铸行逐渐漂移。
    const runId = await mintNodeRun(h.db, {
      taskId,
      nodeId: 'n1',
      status: 'failed',
      cause: 'process-retry',
      retryIndex: 0,
      iteration: 0,
    })
    const ev = (payload: string) => ({
      nodeRunId: runId,
      ts: Date.now(),
      kind: 'text' as const,
      payload,
    })
    // 只有框架审计行 ⇒ 模型其实一个字没说 ⇒ 计数必须是 0
    await h.db.insert(nodeRunEvents).values(ev('[rfc313/session-restart] {"rfc":"RFC-313"}'))
    await h.db.insert(nodeRunEvents).values(ev('[rfc042/envelope-followup] {"rfc":"RFC-042"}'))
    await h.db.insert(nodeRunEvents).values(ev('[rfc049/port-validation-followup] {"port":"x"}'))
    expect(await countAgentTextEvents(nodePersistence(h.db), runId)).toBe(0)

    // 模型真说了话就必须算上（防止过滤写成把所有 text 都吃掉）
    await h.db.insert(nodeRunEvents).values(ev('I finished the audit but forgot the envelope.'))
    expect(await countAgentTextEvents(nodePersistence(h.db), runId)).toBe(1)
  })

  test('attempt 天花板严格低于装配骨架的 spec-bug 保险丝', () => {
    // 两个设置项相乘（50 × 10 = 561）会撞上保险丝，而保险丝的报错写的是「spec bug」
    // ——用它接住一个配置选择只会把运维引到错误方向。钳制放在 retryAttemptCap 里，
    // 这条断言锁住两个常量的大小关系，防止某天调保险丝时把它弄反。
    expect(RETRY_ATTEMPT_CAP_CEILING).toBeLessThan(ASSEMBLY_MAX_ATTEMPTS)
  })
})
