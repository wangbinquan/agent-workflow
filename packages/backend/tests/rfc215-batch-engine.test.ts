// RFC-215 — fc 批量认领的引擎级（DB）行为锁（design §10-8..14）。
//
// 锁的行为：批 drive 全链（一批一 run、逐卡 done + 各自 result 消息）、
// wg_task_results 漏报的协议重试与耗尽后缺卡回 open、agent 自报 failed 回 open、
// attempt_count 认领计数与预算封顶（达 DEFAULT_PROTOCOL_RETRY_BUDGET 停止重开）、
// 批 shardKey 编码、崩溃恢复矩阵（§3.4：dispatched 失驱重配 / host 行 interrupted
// ⇒ redispatch / host 行 done ⇒ 收 done 不重跑）、游标单一归属（批 run 不推）。
import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { DEFAULT_PROTOCOL_RETRY_BUDGET, parseBatchShardKey } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
} from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { WG_MEMBER_NODE_ID } from '../src/services/workgroup/launch'
import {
  runWorkgroupEngine,
  type WorkgroupEngineHooks,
  type WorkgroupHostRunRequest,
  type WorkgroupHostRunResult,
} from '../src/services/workgroup/engine'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc215-batch-engine-test')

function fcCfg(): WorkgroupRuntimeConfig {
  return {
    workgroupId: 'wg1',
    workgroupName: 'squad',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 30,
    completionGate: false,
    instructions: 'x',
    goal: 'ship it',
    members: [
      {
        id: 'm-a',
        memberType: 'agent',
        agentName: 'wg-a',
        userId: null,
        displayName: 'alpha',
        roleDesc: '',
      },
    ],
  }
}

async function seedTask(db: DbClient, config: WorkgroupRuntimeConfig): Promise<string> {
  const taskId = ulid()
  await db.insert(workflows).values({
    id: ulid(),
    name: `host-${taskId}`,
    definition: '{}',
    builtin: true,
  })
  const wf = (await db.select().from(workflows).limit(1))[0]
  await db.insert(tasks).values({
    id: taskId,
    name: 'wg-batch-task',
    workflowId: wf?.id ?? ulid(),
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
  })
  await createAgent(db, {
    name: 'wg-a',
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'work',
  }).catch(() => undefined)
  return taskId
}

/** 直插 open 卡（跳过 initial 规划轮：budgetUsed>0 由预置 host 行保证）。
 *  显式递增 id：同毫秒 ulid() 不保证序，而均分按 id 升序切片（rfc189 同款坑）。 */
let cardSeq = 0
async function seedOpenCard(db: DbClient, taskId: string, title: string): Promise<string> {
  cardSeq += 1
  const id = `CARD${String(cardSeq).padStart(4, '0')}${ulid().slice(8)}`
  await db.insert(workgroupAssignments).values({
    id,
    taskId,
    round: 0,
    source: 'self_claim',
    assigneeMemberId: null,
    title,
    briefMd: `brief of ${title}`,
    status: 'open',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

/** 预置一个 done 的 member 行，让 nothingStarted=false（跳过 fc_initial 群唤）。 */
async function seedPastRun(db: DbClient, taskId: string): Promise<void> {
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: WG_MEMBER_NODE_ID,
    status: 'done',
    rerunCause: 'wg-message-turn',
    shardKey: 'msg:m-a:0',
    startedAt: Date.now(),
  })
}

function scripted(member: WorkgroupHostRunResult[]): {
  hooks: WorkgroupEngineHooks
  requests: WorkgroupHostRunRequest[]
} {
  const requests: WorkgroupHostRunRequest[] = []
  const hooks: WorkgroupEngineHooks = {
    runHostNode: (req) => {
      requests.push(req)
      const next = member.shift()
      return Promise.resolve(
        next ?? { status: 'failed', outputs: {}, errorMessage: 'script exhausted' },
      )
    },
  }
  return { hooks, requests }
}

const batchDone = (
  ...entries: Array<{ task: number; status?: 'done' | 'failed'; summary: string }>
) =>
  ({
    status: 'done',
    outputs: { wg_task_results: JSON.stringify(entries) },
  }) satisfies WorkgroupHostRunResult

let db: DbClient
beforeEach(() => {
  db = createInMemoryDb(MIGRATIONS)
})

describe('RFC-215 engine — batch drive happy path', () => {
  test('one run claims BOTH cards; per-card done + result messages + batch shardKey', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const c1 = await seedOpenCard(db, taskId, 'card one')
    const c2 = await seedOpenCard(db, taskId, 'card two')
    const { hooks, requests } = scripted([
      batchDone({ task: 1, summary: 'one done' }, { task: 2, summary: 'two done' }),
    ])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')

    // 一批一 run：仅 1 次 host 调用，协议是批版（wg_task_results、禁 wg_result）。
    expect(requests).toHaveLength(1)
    expect(requests[0]?.hostOutputPorts).toContain('wg_task_results')
    expect(requests[0]?.hostOutputPorts).not.toContain('wg_result')
    expect(requests[0]?.workgroupProtocolBlock).toContain('wg_task_results')
    expect(requests[0]?.promptTemplate).toContain('batch of 2')
    expect(requests[0]?.promptTemplate).toContain('Task 1: card one')
    expect(requests[0]?.promptTemplate).toContain('Task 2: card two')

    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(cards.every((a) => a.status === 'done')).toBe(true)
    expect(new Set(cards.map((a) => a.resultMessageId)).size).toBe(2) // 逐卡独立 result
    expect(cards.every((a) => a.attemptCount === 1)).toBe(true) // 认领计数一次

    // 批 shardKey 编码可回解出成员 + 两张卡。
    const memberRows = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === WG_MEMBER_NODE_ID && r.rerunCause === 'wg-assignment',
    )
    expect(memberRows).toHaveLength(1)
    const parsed = parseBatchShardKey(memberRows[0]?.shardKey ?? null)
    expect(parsed?.memberId).toBe('m-a')
    expect(new Set(parsed?.assignmentIds)).toEqual(new Set([c1, c2]))

    const results = (
      await db.select().from(workgroupMessages).where(eq(workgroupMessages.taskId, taskId))
    ).filter((m) => m.kind === 'result')
    expect(results.map((m) => m.bodyMd).sort()).toEqual(['one done', 'two done'])
  })

  test('batch run does NOT advance the member cursor (G3 — message track owns it)', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    await seedOpenCard(db, taskId, 'solo')
    const { hooks } = scripted([batchDone({ task: 1, summary: 'ok' })])
    await runWorkgroupEngine({ db, taskId, log, hooks })
    const cursors = await db
      .select()
      .from(workgroupMemberCursors)
      .where(eq(workgroupMemberCursors.taskId, taskId))
    // 批 run 结束后成员游标不存在（从未被消息回合推进过）。
    expect(cursors).toHaveLength(0)
  })
})

describe('RFC-215 engine — under-reporting & self-reported failure', () => {
  test('missing entry → protocol retries → exhaustion: reported card lands, missing card reopens', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const c1 = await seedOpenCard(db, taskId, 'reported')
    const c2 = await seedOpenCard(db, taskId, 'ghost')
    const short = batchDone({ task: 1, summary: 'only one' })
    const { hooks, requests } = scripted([
      // 漏报轮 ×(1 + WG_PROTOCOL_RETRIES) 耗尽 → c1 落 done、c2 回 open
      short,
      short,
      short,
      short,
      // 引擎下一 pass 把 c2 重新配成单卡批 → 全报 → 收敛
      batchDone({ task: 1, summary: 'ghost finally done' }),
    ])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests.length).toBe(5)
    // 重试轮 prompt 点名缺卡 + 明示不用 wg_result。
    expect(requests[1]?.promptTemplate).toContain('missing entries for Task 2')

    const byId = new Map(
      (
        await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.taskId, taskId))
      ).map((a) => [a.id, a]),
    )
    expect(byId.get(c1)?.status).toBe('done')
    expect(byId.get(c2)?.status).toBe('done')
    // c1 认领 1 次；c2 认领 2 次（首批 + 重开后的单卡批）。
    expect(byId.get(c1)?.attemptCount).toBe(1)
    expect(byId.get(c2)?.attemptCount).toBe(2)
  })

  test('stray wg_result (no wg_task_results) is NOT silently dropped — retry names the right port', async () => {
    // 设计门 ③F5：批 run 里模型习惯性发 wg_result 属 undeclared 端口，envelope 层
    // kept-but-flagged 不进 outputs——必须因缺 wg_task_results 进协议重试并点名换端口。
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    await seedOpenCard(db, taskId, 'misport')
    const { hooks, requests } = scripted([
      { status: 'done', outputs: { wg_result: JSON.stringify({ summary: 'wrong port' }) } },
      batchDone({ task: 1, summary: 'right port now' }),
    ])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(2)
    expect(requests[1]?.promptTemplate).toContain('missing required port wg_task_results')
    expect(requests[1]?.promptTemplate).toContain('does NOT use wg_result')
  })

  test('status:"failed" entry reopens that card only; budget caps re-opens at the shared constant', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const c1 = await seedOpenCard(db, taskId, 'stubborn')
    const failEntry = batchDone({ task: 1, status: 'failed', summary: 'cannot do it' })
    // 每次认领 attempt+1：3 次自报失败后 attempt=3=预算 ⇒ 不再重开，卡留 failed。
    const { hooks, requests } = scripted([failEntry, failEntry, failEntry])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    // 清单 drained（failed 不算 open/active）⇒ 正常收敛。
    expect(result.kind).toBe('ok')
    expect(requests.length).toBe(DEFAULT_PROTOCOL_RETRY_BUDGET)
    const card = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, c1))
    )[0]
    expect(card?.status).toBe('failed')
    expect(card?.attemptCount).toBe(DEFAULT_PROTOCOL_RETRY_BUDGET)
    const failNotes = (
      await db.select().from(workgroupMessages).where(eq(workgroupMessages.taskId, taskId))
    ).filter((m) => m.kind === 'system' && m.bodyMd.includes('reported failed'))
    expect(failNotes.length).toBe(DEFAULT_PROTOCOL_RETRY_BUDGET)
  })

  test('whole-run failure reopens the whole batch (within budget)', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const c1 = await seedOpenCard(db, taskId, 'x1')
    const c2 = await seedOpenCard(db, taskId, 'x2')
    const { hooks } = scripted([
      { status: 'failed', outputs: {}, errorMessage: 'proc crashed' },
      batchDone({ task: 1, summary: 'x1 ok' }, { task: 2, summary: 'x2 ok' }),
    ])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(cards.every((a) => a.status === 'done')).toBe(true)
    expect(new Set([byIdOf(cards, c1)?.attemptCount, byIdOf(cards, c2)?.attemptCount])).toEqual(
      new Set([2]),
    )
  })
})

function byIdOf<T extends { id: string }>(rows: readonly T[], id: string): T | undefined {
  return rows.find((r) => r.id === id)
}

describe('RFC-215 engine — crash recovery matrix (§3.4)', () => {
  test('dispatched card with NO host run (crash between CAS and mint) is re-batched and finishes', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const cardId = ulid()
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 0,
      source: 'self_claim',
      assigneeMemberId: 'm-a', // 崩溃前已 CAS dispatched
      title: 'orphan',
      briefMd: 'b',
      status: 'dispatched',
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const { hooks, requests } = scripted([batchDone({ task: 1, summary: 'recovered' })])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(1)
    const card = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId))
    )[0]
    expect(card?.status).toBe('done')
    // 恢复批不重复计数（attempt 只在 open→dispatched 认领时 +1）。
    expect(card?.attemptCount).toBe(1)
  })

  test('running card whose batch host row is INTERRUPTED → reconcile redispatch → re-run', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const cardId = ulid()
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: WG_MEMBER_NODE_ID,
      status: 'interrupted', // boot reaper 打断（真崩溃形态：无 pending 可领养）
      rerunCause: 'wg-assignment',
      shardKey: `batch:m-a:${cardId}`,
      startedAt: Date.now(),
    })
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 0,
      source: 'self_claim',
      assigneeMemberId: 'm-a',
      title: 'mid-run crash',
      briefMd: 'b',
      status: 'running',
      nodeRunId: runId,
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const { hooks, requests } = scripted([batchDone({ task: 1, summary: 're-done' })])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(1) // 恢复批重跑一次
    const card = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId))
    )[0]
    expect(card?.status).toBe('done')
  })

  test('running card whose batch host row is DONE → reconcile closes it done WITHOUT re-running', async () => {
    // v1 的 reconcile 按 shardKey===cardId 匹配批行恒空 ⇒ 误 redispatch 重跑已
    // 完成的工作（设计门 ①P1-2=②F4=③F1）。nodeRunId 直查修复后：0 次 host 调用。
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const cardId = ulid()
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: WG_MEMBER_NODE_ID,
      status: 'done',
      rerunCause: 'wg-assignment',
      shardKey: `batch:m-a:${cardId}`,
      startedAt: Date.now(),
    })
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 0,
      source: 'self_claim',
      assigneeMemberId: 'm-a',
      title: 'landed but unsettled',
      briefMd: 'b',
      status: 'running',
      nodeRunId: runId,
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const { hooks, requests } = scripted([])
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(0) // 不重跑
    const card = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId))
    )[0]
    expect(card?.status).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// 实现门对抗自评审（2026-07-21）回归锁 — C-1 / C-2 / C-3(c)
// ---------------------------------------------------------------------------

describe('RFC-215 impl-gate C-1 — unresolvable member agent converges instead of spinning', () => {
  test('open cards get claimed+failed-settled; budget exhausts to failed; zero host calls; bounded messages', async () => {
    // 生产可达：fc 任务运行中删除/重命名 roster 成员的 agent（deleteAgent 对
    // 工作组 roster 引用无守卫、注释明示允许悬垂）。旧版 agent-null 分支把
    // open 卡原样留池，而 deriveWakeSet 不感知 agent 可解析性 ⇒ 每 pass 重派
    // 同一批：不 mint ⇒ budgetUsed 不增、items 恒非空 ⇒ 引擎空转 + 每圈一条
    // system 消息（房间消息无限增长）。修复后：open 卡认领（bumpAttempt）+
    // 失败收尾，attempt_count 预算封顶 → failed 终态，与单卡时代收敛语义一致。
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const c1 = await seedOpenCard(db, taskId, 'doomed one')
    const c2 = await seedOpenCard(db, taskId, 'doomed two')
    await db.delete(agents).where(eq(agents.name, 'wg-a'))
    const { hooks, requests } = scripted([])
    for (let pass = 0; pass < DEFAULT_PROTOCOL_RETRY_BUDGET + 2; pass++) {
      const result = await runWorkgroupEngine({ db, taskId, log, hooks })
      expect(result.kind).toBe('ok')
    }
    expect(requests).toHaveLength(0) // agent 不可解析：绝不 spawn
    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    for (const id of [c1, c2]) {
      const card = byIdOf(cards, id)
      expect(card?.status).toBe('failed')
      expect(card?.attemptCount).toBe(DEFAULT_PROTOCOL_RETRY_BUDGET)
    }
    // 消息有界：收敛后（卡全终态）不再有新的 skip 消息。
    const msgs = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    const skips = msgs.filter((m) => m.bodyMd.includes('agent unresolvable'))
    expect(skips.length).toBeGreaterThan(0)
    expect(skips.length).toBeLessThanOrEqual(DEFAULT_PROTOCOL_RETRY_BUDGET + 2)
  })
})

describe('RFC-215 impl-gate C-2 — adopted pre-215 single-card fc row gets a single-card prompt', () => {
  test('prompt is the lw-shape assignment block; no wg_task_results / batch-of contradiction', async () => {
    // 升级窗口：pre-215 铸出的 fc 单卡行（shardKey = 卡 id）被领养续跑时走
    // driveAssignmentTurn——其协议块/hostOutputPorts/解析侧全是 wg_result 单卡
    // 形态。旧版 composeMemberPrompt 对 fc 恒渲染批文案（Report EACH in
    // wg_task_results），同一 prompt 互斥指令并存，按任务块发 wg_task_results
    // 即烧协议重试。修复：singleCard 走单卡块。
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const cardId = ulid()
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: WG_MEMBER_NODE_ID,
      status: 'pending', // crash before spawn — adoption path
      rerunCause: 'wg-assignment',
      shardKey: cardId, // pre-215 single-card key
      startedAt: Date.now(),
    })
    await db.insert(workgroupAssignments).values({
      id: cardId,
      taskId,
      round: 0,
      source: 'self_claim',
      assigneeMemberId: 'm-a',
      title: 'legacy single',
      briefMd: 'b',
      status: 'running',
      nodeRunId: runId,
      attemptCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    // fake-hook harness 限制：真实 runHostNode 会把 host 行落终态；假 hook 不落库
    // 的话 pending 领养行每圈仍是 pending、被无限重领养（引擎按 DB 状态扫）。
    const requests: WorkgroupHostRunRequest[] = []
    const hooks: WorkgroupEngineHooks = {
      runHostNode: async (req) => {
        requests.push(req)
        await db.update(nodeRuns).set({ status: 'done' }).where(eq(nodeRuns.id, req.nodeRunId))
        return { status: 'done', outputs: { wg_result: JSON.stringify({ summary: 'ok' }) } }
      },
    }
    const result = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(result.kind).toBe('ok')
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.promptTemplate).toContain('## Your assignment')
    expect(req.promptTemplate).not.toContain('batch of')
    expect(req.promptTemplate).not.toContain('wg_task_results')
    expect(req.hostOutputPorts).toContain('wg_result')
    expect(req.hostOutputPorts).not.toContain('wg_task_results')
    const card = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId))
    )[0]
    expect(card?.status).toBe('done')
  })
})

describe('RFC-215 impl-gate C-3(c) — dual-track: same member serves batch AND message turn in one pass', () => {
  test('one engine pass yields both a batch run and a message run for the same member', async () => {
    const taskId = await seedTask(db, fcCfg())
    await seedPastRun(db, taskId)
    const cardId = await seedOpenCard(db, taskId, 'parallel card')
    await db.insert(workgroupMessages).values({
      id: ulid(),
      taskId,
      round: 0,
      authorKind: 'human',
      authorUserId: 'u1',
      kind: 'chat',
      bodyMd: '@alpha please look',
      mentionsJson: JSON.stringify(['m-a']),
      createdAt: Date.now(),
    })
    // 并发性断言：两轨请求都出现在同一次引擎调用内即达成——收到双请求后
    // abort 收口（收敛语义由本文件其它用例锁；假 hook 不落行状态，消息轨的
    // 完整收敛在 harness 下不可依赖）。
    const ac = new AbortController()
    const requests: WorkgroupHostRunRequest[] = []
    const hooks: WorkgroupEngineHooks = {
      runHostNode: (req) => {
        requests.push(req)
        if (requests.length >= 2) queueMicrotask(() => ac.abort())
        return Promise.resolve(
          (req.hostOutputPorts ?? []).includes('wg_task_results')
            ? batchDone({ task: 1, summary: 'card ok' })
            : { status: 'done', outputs: { wg_messages: '[]' } },
        )
      },
    }
    const result = await runWorkgroupEngine({ db, taskId, log, hooks, signal: ac.signal })
    expect(['ok', 'canceled']).toContain(result.kind)
    expect(requests).toHaveLength(2)
    const ports = requests.map((r) => r.hostOutputPorts ?? [])
    expect(ports.some((p) => p.includes('wg_task_results'))).toBe(true) // 任务轨（批）
    expect(ports.some((p) => p.includes('wg_result') && !p.includes('wg_task_results'))).toBe(true) // 消息轨
    const keys = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
      .filter((r) => r.nodeId === WG_MEMBER_NODE_ID && r.shardKey !== null)
      .map((r) => r.shardKey ?? '')
    expect(keys.some((k) => k.startsWith('batch:m-a:') && k.includes(cardId))).toBe(true)
    expect(keys.some((k) => k.startsWith('msg:m-a'))).toBe(true)
    const card = (
      await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, cardId))
    )[0]
    expect(card?.status).toBe('done') // 批轨照常逐卡落 done
  })
})
