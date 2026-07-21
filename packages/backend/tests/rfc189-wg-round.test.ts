// RFC-189 — 轮序数 vs 重试数上游拆分：wg_round 列 + retryIndex 回归纯 attempt。
//
// 锁四件事：
//   1. 迁移 0095 回填互 oracle：对 0094 时代的合成行（lw：initial/协议重试/
//      gate/canceled/clarify 混排 + member assignment/msg 行；fc：member 行）
//      跑 0095，断言 wg_round 与「旧派生口径」逐行相等；fc 行与 clarify 行
//      保持 NULL。
//   2. 引擎打戳：lw 一轮派单→worker→第二轮 done——leader 两行 wgRound=1,2、
//      retryIndex 全 0；worker 行 wgRound=继承派单轮；协议重试三连滑——四行
//      同 wgRound、retryIndex=0..3、maxRounds 只烧一轮（AC-4 换 oracle 重锁）。
//   3. 领养打戳：引擎外 mint 的 pending leader 行（崩溃残留/答复续跑形态）被
//      adopt 时就地 stampWgRound，账本计一轮不重复。
//   4. fc 免疫：fc 行 wgRound 恒 NULL、轮预算仍按行计数。
//
// 迁移方式：把 migrations 目录复制到临时目录并截断 journal 至 0094 → 建库插行
// → 换回完整目录再 migrate（drizzle 按 journal 差量补跑 0095）。

import { describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, asc, eq, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows, workgroupAssignments } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import {
  runWorkgroupEngine,
  type WorkgroupEngineHooks,
  type WorkgroupHostRunRequest,
  type WorkgroupHostRunResult,
} from '../src/services/workgroupRunner'
import { buildWorkgroupHostSnapshot } from '../src/services/workgroupLaunch'
import { createLogger } from '../src/util/log'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('rfc189-test')

// ---------------------------------------------------------------------------
// 1. 迁移回填互 oracle
// ---------------------------------------------------------------------------

function partialMigrationsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-rfc189-mig-'))
  cpSync(MIGRATIONS, dir, { recursive: true })
  // 截断 journal 到 0095 之前（构造"0095 尚未应用"的部分迁移目录）。
  // RFC-193 起 0095 不再是最后一条 —— 按 tag 定位截断点，后续新增 migration
  // 不再反复弄红这里（原实现硬编码「尾条 == 0095」）。
  const journalPath = join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  const cut = journal.entries.findIndex((e) => e.tag === '0095_rfc189_wg_round')
  expect(cut).toBeGreaterThan(0)
  for (const dropped of journal.entries.slice(cut)) {
    rmSync(join(dir, `${dropped.tag}.sql`))
  }
  journal.entries = journal.entries.slice(0, cut)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dir
}

interface SynthRow {
  nodeId: string
  status: string
  cause: string | null
  shardKey?: string | null
}

/** 旧派生口径（迁移里冻结的那份）的 JS oracle：qualifying = 非 canceled 且
 *  cause ∉ {wg-gate, wg-protocol-retry}，非 qualifying 行继承当前轮号。 */
function oracleRounds(rows: SynthRow[]): Array<number> {
  let n = 0
  return rows.map((r) => {
    const qualifying =
      r.status !== 'canceled' && r.cause !== 'wg-gate' && r.cause !== 'wg-protocol-retry'
    if (qualifying) n++
    return n
  })
}

describe('RFC-189 迁移 0095 — 回填互 oracle', () => {
  test('lw 混排行回填 = 旧口径；assignment 行取 wa.round；fc/clarify 行 NULL', async () => {
    const partial = partialMigrationsDir()
    const db = createInMemoryDb(partial)

    const mkTask = async (mode: 'leader_worker' | 'free_collab'): Promise<string> => {
      const wfId = ulid()
      const taskId = ulid()
      // Same reason as the `tasks` INSERT below (RFC-211 T1 hit it for real):
      // drizzle emits EVERY HEAD column, so `workflows.example` (0103) made the
      // ORM form fail with "table workflows has no column named example" on this
      // 0094-frozen DB. Spell the 0094-era columns out.
      db.run(sql`
        INSERT INTO workflows (id, name, description, definition)
        VALUES (${wfId}, ${`wf-${taskId}`}, '', '{}')
      `)
      // NOTE (RFC-204 T2): this row is inserted into a table frozen at 0094,
      // but drizzle emits EVERY column of the HEAD schema in its INSERT — so
      // any later migration that merely ADDs a `tasks` column made this line
      // fail with "table tasks has no column named …". Spelling the columns out
      // keeps the fixture pinned to the 0094-era shape the test actually needs,
      // so future additive migrations don't re-red it (same intent as the
      // tag-based journal truncation above).
      db.run(sql`
        INSERT INTO tasks (
          id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
          base_branch, branch, status, inputs, started_at,
          workgroup_id, workgroup_config_json
        ) VALUES (
          ${taskId}, 't', ${wfId}, '{}', '/tmp/x', '/tmp/x',
          'main', ${`agent-workflow/${taskId}`}, 'done', '{}', ${Date.now()},
          'wg1', ${JSON.stringify({ mode })}
        )
      `)
      return taskId
    }

    const lwTask = await mkTask('leader_worker')
    const fcTask = await mkTask('free_collab')

    // lw leader 序列：initial → 协议重试 ×2 → gate → canceled → 第二轮。
    const lwLeaderRows: SynthRow[] = [
      { nodeId: '__wg_leader__', status: 'failed', cause: 'wg-leader-round' },
      { nodeId: '__wg_leader__', status: 'failed', cause: 'wg-protocol-retry' },
      { nodeId: '__wg_leader__', status: 'done', cause: 'wg-protocol-retry' },
      { nodeId: '__wg_leader__', status: 'awaiting_review', cause: 'wg-gate' },
      { nodeId: '__wg_leader__', status: 'canceled', cause: 'wg-leader-round' },
      { nodeId: '__wg_leader__', status: 'done', cause: 'clarify-answer' },
    ]
    // 0094 时代的行必须用裸 SQL 写入：drizzle 的 .values() 按当前 schema 全列
    // 生成 INSERT（含尚不存在的 wg_round），对旧库直接 prepare 失败。
    const insertOldRow = async (id: string, taskId: string, r: SynthRow): Promise<void> => {
      await db.run(
        sql`INSERT INTO node_runs (id, task_id, node_id, status, rerun_cause, shard_key, started_at)
            VALUES (${id}, ${taskId}, ${r.nodeId}, ${r.status}, ${r.cause}, ${r.shardKey ?? null}, ${Date.now()})`,
      )
    }
    // 显式递增 id：同毫秒 ulid() 不保证序，而回填窗口按 id 序扫描——测试的
    // oracle 假设 id 序 == 插入序，必须坐实。
    const lwLeaderIds: string[] = []
    for (const [i, r] of lwLeaderRows.entries()) {
      const id = `L${String(i).padStart(2, '0')}`
      lwLeaderIds.push(id)
      await insertOldRow(id, lwTask, r)
    }
    // lw member：assignment 行（取 wa.round=3）+ msg 行（窗口号）。
    // RFC-215 T2：与上面 tasks 同理——0094 冻结库上 drizzle 会按 HEAD schema 全列
    // 生成 INSERT（含 0105 的 attempt_count），必须裸 SQL 显式列钉住 0094 形状。
    const waId = ulid()
    await db.run(sql`
      INSERT INTO workgroup_assignments (
        id, task_id, round, source, assignee_member_id, title, brief_md,
        status, created_at, updated_at
      ) VALUES (
        ${waId}, ${lwTask}, 3, 'leader', 'm1', 't', 'b',
        'done', ${Date.now()}, ${Date.now()}
      )
    `)
    const lwMemberAssignId = 'M01'
    await insertOldRow(lwMemberAssignId, lwTask, {
      nodeId: '__wg_member__',
      status: 'done',
      cause: 'wg-assignment',
      shardKey: waId,
    })
    const lwMemberMsgId = 'M02'
    await insertOldRow(lwMemberMsgId, lwTask, {
      nodeId: '__wg_member__',
      status: 'done',
      cause: 'wg-message-turn',
      shardKey: 'msg:m1:0',
    })
    // clarify 载体行：不打戳。
    const lwClarifyId = 'Q01'
    await insertOldRow(lwClarifyId, lwTask, {
      nodeId: '__wg_clarify__',
      status: 'done',
      cause: null,
    })
    // fc member 行：不打戳。
    const fcMemberId = 'F01'
    await insertOldRow(fcMemberId, fcTask, {
      nodeId: '__wg_member__',
      status: 'done',
      cause: 'wg-assignment',
    })

    // 应用 0095（drizzle 按 __drizzle_migrations 差量补跑）。
    migrate(db, { migrationsFolder: MIGRATIONS })

    const expected = oracleRounds(lwLeaderRows)
    const leaderRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, lwTask), eq(nodeRuns.nodeId, '__wg_leader__')))
      .orderBy(asc(nodeRuns.id))
    expect(leaderRows.map((r) => r.wgRound)).toEqual(expected)

    const memberAssign = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, lwMemberAssignId))
    )[0]
    expect(memberAssign?.wgRound).toBe(3) // wa.round 权威覆盖
    const memberMsg = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, lwMemberMsgId)))[0]
    // 窗口号：member 分区按 id 序，assignment 行（qualifying）在前 → msg 行 = 2。
    expect(memberMsg?.wgRound).toBe(2)
    const clarify = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, lwClarifyId)))[0]
    expect(clarify?.wgRound).toBeNull()
    const fcRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, fcMemberId)))[0]
    expect(fcRow?.wgRound).toBeNull()
    rmSync(partial, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// 2/3/4. 引擎打戳（fake hooks，rfc164 模式）
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
    instructions: '',
    goal: 'goal',
    members: [
      {
        id: 'm-lead',
        memberType: 'agent',
        agentName: 'wg-planner',
        userId: null,
        displayName: 'planner',
        roleDesc: '',
      },
      {
        id: 'm-coder',
        memberType: 'agent',
        agentName: 'wg-coder',
        userId: null,
        displayName: 'coder',
        roleDesc: '',
      },
    ],
    ...overrides,
  }
}

async function seedEngineTask(db: DbClient, config: WorkgroupRuntimeConfig): Promise<string> {
  const taskId = ulid()
  await db.insert(workflows).values({ id: ulid(), name: `host-${taskId}`, definition: '{}' })
  const wf = (await db.select().from(workflows).limit(1))[0]
  await db.insert(tasks).values({
    id: taskId,
    name: 'wg-rfc189',
    workflowId: wf?.id ?? ulid(),
    workflowSnapshot: JSON.stringify(buildWorkgroupHostSnapshot(config)),
    repoPath: '/tmp/never',
    worktreePath: '/tmp/never-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
  })
  for (const name of ['wg-planner', 'wg-coder']) {
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
      bodyMd: 'x',
    }).catch(() => undefined)
  }
  return taskId
}

function scriptedHooks(script: {
  leader: WorkgroupHostRunResult[]
  member: WorkgroupHostRunResult[]
}): { hooks: WorkgroupEngineHooks; requests: WorkgroupHostRunRequest[] } {
  const requests: WorkgroupHostRunRequest[] = []
  const hooks: WorkgroupEngineHooks = {
    runHostNode: (req) => {
      requests.push(req)
      const q = req.nodeId === '__wg_leader__' ? script.leader : script.member
      const next = q.shift()
      return Promise.resolve(
        next ?? { status: 'failed', outputs: {}, errorMessage: `script exhausted ${req.nodeId}` },
      )
    },
  }
  return { hooks, requests }
}

const leaderDone = (summary = 'done'): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: { wg_decision: JSON.stringify({ action: 'done', summary }) },
})
const leaderDispatch = (): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: {
    wg_assignments: JSON.stringify([{ member: 'coder', title: 'do-x', brief: 'b' }]),
    wg_decision: JSON.stringify({ action: 'continue' }),
  },
})
const memberDone = (): WorkgroupHostRunResult => ({
  status: 'done',
  outputs: { wg_result: JSON.stringify({ summary: 'ok' }) },
})
const skipEnvelope = (): WorkgroupHostRunResult => ({
  status: 'failed',
  outputs: {},
  errorMessage: 'no envelope',
  failureCode: 'envelope-missing',
})

async function hostRows(db: DbClient, taskId: string) {
  return (
    await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).orderBy(asc(nodeRuns.id))
  ).filter((r) => r.nodeId === '__wg_leader__' || r.nodeId === '__wg_member__')
}

describe('RFC-189 引擎打戳（lw）', () => {
  test('两轮：leader wgRound=1,2 / retryIndex=0；worker 继承派单轮', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedEngineTask(db, cfg())
    const { hooks } = scriptedHooks({
      leader: [leaderDispatch(), leaderDone()],
      member: [memberDone()],
    })
    const res = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(res.kind).toBe('ok')
    const rows = await hostRows(db, taskId)
    const leaders = rows.filter((r) => r.nodeId === '__wg_leader__')
    expect(leaders.map((r) => r.wgRound)).toEqual([1, 2])
    expect(leaders.every((r) => r.retryIndex === 0)).toBe(true)
    const workers = rows.filter((r) => r.nodeId === '__wg_member__')
    expect(workers).toHaveLength(1)
    expect(workers[0]?.wgRound).toBe(1) // assignment.round = 派单时的轮
    expect(workers[0]?.retryIndex).toBe(0)
  })

  test('协议三连滑：四行同 wgRound、retryIndex=0..3、账本只烧一轮（AC-4 换 oracle）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedEngineTask(db, cfg({ maxRounds: 2 }))
    const { hooks } = scriptedHooks({
      leader: [skipEnvelope(), skipEnvelope(), skipEnvelope(), leaderDone()],
      member: [],
    })
    const res = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(res.kind).toBe('ok') // maxRounds=2 未被重试膨胀击穿
    const leaders = (await hostRows(db, taskId)).filter((r) => r.nodeId === '__wg_leader__')
    // 同毫秒 mint 的普通 ULID 不保证 id 序 → 断言用集合/排序口径（账本语义
    // 本就与行序无关：countRoundsUsed 走 max）。
    expect(leaders.map((r) => r.wgRound)).toEqual([1, 1, 1, 1])
    expect([...leaders.map((r) => r.retryIndex)].sort()).toEqual([0, 1, 2, 3])
    expect(leaders.filter((r) => r.rerunCause === 'wg-leader-round')).toHaveLength(1)
    expect(leaders.filter((r) => r.rerunCause === 'wg-protocol-retry')).toHaveLength(3)
  })

  test('领养打戳：引擎外 mint 的 pending leader 行被 adopt 时就地 stamp、账本计一轮', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedEngineTask(db, cfg())
    // 模拟崩溃残留：引擎外 mint 的 pending leader 行（无 wgRound）。
    const orphanId = ulid()
    await db.insert(nodeRuns).values({
      id: orphanId,
      taskId,
      nodeId: '__wg_leader__',
      status: 'pending',
      rerunCause: 'wg-leader-round',
      // Codex 实现门 P2-1 场景：领养行带存量 index（clarify-answer 续跑经标准
      // dispatch mint 的 max+1 形态）——后续协议重试必须从它续排，不得回 0 重复。
      retryIndex: 4,
      startedAt: Date.now(),
    })
    const { hooks } = scriptedHooks({
      // 领养轮先滑一次信封（触发协议重试）再 done + 派单（P2-2：effects 轮号
      // 必须与领养行的 stamp 同轮），worker 一单完成后 leader 第二轮收 done。
      leader: [skipEnvelope(), leaderDispatch(), leaderDone()],
      member: [memberDone()],
    })
    // 真实 runHostNode 会把行推进到终态；fake hook 不落库 → 手动补一层状态翻转，
    // 否则 orphan 永远 pending 被引擎二次领养（脚本耗尽 → 假失败）。
    const flipping: WorkgroupEngineHooks = {
      runHostNode: async (req) => {
        const result = await hooks.runHostNode(req)
        await db
          .update(nodeRuns)
          .set({ status: result.status === 'done' ? 'done' : 'failed' })
          .where(eq(nodeRuns.id, req.nodeRunId))
        return result
      },
    }
    const res = await runWorkgroupEngine({ db, taskId, log, hooks: flipping })
    expect(res.kind).toBe('ok')
    const adopted = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, orphanId)))[0]
    expect(adopted?.wgRound).toBe(1) // NULL-qualifying 尾巴计入后就地 stamp 为当前轮
    const leaders = (await hostRows(db, taskId)).filter((r) => r.nodeId === '__wg_leader__')
    // P2-1：领养轮的协议重试 retryIndex = 存量 4 续排为 5（同轮 wgRound=1），
    // 不回 0 造成 (node, shard, retry_index) 重复。
    const retryRow = leaders.find((r) => r.rerunCause === 'wg-protocol-retry')
    expect(retryRow?.retryIndex).toBe(5)
    expect(retryRow?.wgRound).toBe(1)
    // P2-2：领养轮派出的 assignment 与其 stamp 同轮（旧代码劈成 run=1 / 效果=2）。
    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(cards).toHaveLength(1)
    expect(cards[0]?.round).toBe(1)
    const worker = (await hostRows(db, taskId)).find((r) => r.nodeId === '__wg_member__')
    expect(worker?.wgRound).toBe(1)
  })
})

describe('RFC-189 fc 免疫', () => {
  test('fc 成员行 wgRound 恒 NULL，轮预算仍按行计数（maxRounds 生效）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedEngineTask(db, cfg({ mode: 'free_collab', leaderMemberId: null }))
    const { hooks } = scriptedHooks({
      leader: [],
      // fc initial burst：两个成员各一轮，各产出 wg_result（无 tasks_add → 收敛 done）。
      member: [memberDone(), memberDone()],
    })
    const res = await runWorkgroupEngine({ db, taskId, log, hooks })
    expect(res.kind).toBe('ok')
    const members = (await hostRows(db, taskId)).filter((r) => r.nodeId === '__wg_member__')
    expect(members.length).toBeGreaterThanOrEqual(2)
    expect(members.every((r) => r.wgRound === null)).toBe(true)
  })
})
