import { rimrafDir } from './helpers/cleanup'
// RFC-142 — 评审历史信息全量回显：多文档分轮（rounds）+ G4 混代修复。
//
// WHY THIS FILE EXISTS (regression intent):
//   - groupDocVersionRounds 纯函数：generation 分组 / legacy(NULL) 按 iteration
//     归并且排前 / refresh 同 iteration 两代分两轮 / 轮级 decision·reason·decider
//     派生（rejected 共享原因、iterated 轮级 null、superseded 'upstream-refreshed'）
//     / isCurrent（pending 轮优先，否则最新轮）/ 成员 itemIndex 升序。
//   - listReviewRounds：iterate 两轮全字段；已决策成员 commentCount 计冻结
//     commentsJson（决策删 live 行后原实现恒 0——RFC-142 顺带修复）。
//   - G4（先红后绿）：upstream refresh 在同一 reviewIteration 留两代后，
//     getReviewDetail 的已决策轮必须只取最高代——旧实现只按 max reviewIteration
//     过滤，superseded 旧代混进 documents（itemIndex 重复、条目翻倍）。
//   - GET /api/reviews/:nodeRunId/rounds 的 ACL 与 /versions 同门：任务不可见
//     403 task-not-visible；未知 nodeRunId 404。
// 如果本文件变红，先对照 design/RFC-142-review-history-echo/design.md D3-D5。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Hono } from 'hono'
import { createSession } from '../src/auth/sessionStore'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskCollaborators,
  tasks,
  workflows,
} from '../src/db/schema'
import { createApp } from '../src/server'
import {
  dispatchReviewNode,
  getReviewDetail,
  groupDocVersionRounds,
  listReviewRounds,
  submitReviewDecision,
  type RoundGroupRow,
} from '../src/services/review'
import { createUser } from '../src/services/users'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// 纯函数层 — groupDocVersionRounds
// ---------------------------------------------------------------------------

function mkRow(over: Partial<RoundGroupRow> & { id: string }): RoundGroupRow {
  return {
    reviewIteration: 0,
    roundGeneration: null,
    itemIndex: 0,
    decision: 'pending',
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    createdAt: 1000,
    ...over,
  }
}

describe('RFC-142 — groupDocVersionRounds（纯函数）', () => {
  test('generation 分组升序；iterated 轮级 reason 为 null；pending 轮 isCurrent', () => {
    const rounds = groupDocVersionRounds([
      mkRow({
        id: 'a0',
        roundGeneration: 1,
        itemIndex: 0,
        decision: 'iterated',
        decisionReason: '### Comment 1\nrendered',
        decidedAt: 2000,
        decidedBy: 'alice',
        decidedByRole: 'owner',
      }),
      mkRow({
        id: 'a1',
        roundGeneration: 1,
        itemIndex: 1,
        decision: 'iterated',
        decisionReason: null,
        decidedAt: 2100,
        decidedBy: 'carol',
        decidedByRole: 'user',
      }),
      mkRow({ id: 'b0', roundGeneration: 2, reviewIteration: 1, itemIndex: 0, createdAt: 3000 }),
      mkRow({ id: 'b1', roundGeneration: 2, reviewIteration: 1, itemIndex: 1, createdAt: 2900 }),
    ])
    expect(rounds.map((r) => r.roundKey)).toEqual(['g1', 'g2'])
    const [r1, r2] = [rounds[0]!, rounds[1]!]
    expect(r1.decision).toBe('iterated')
    // iterated 的 decisionReason 是渲染态评论块（与冻结评论重复）——轮级必须为 null。
    expect(r1.decisionReason).toBeNull()
    // decider 取 decidedAt 最大的成员。
    expect(r1.decidedBy).toBe('carol')
    expect(r1.decidedByRole).toBe('user')
    expect(r1.decidedAt).toBe(2100)
    expect(r1.isCurrent).toBe(false)
    expect(r2.decision).toBe('pending')
    expect(r2.isCurrent).toBe(true)
    expect(r2.createdAt).toBe(2900) // min(member.createdAt)
    expect(r2.reviewIteration).toBe(1)
    expect(r2.roundGeneration).toBe(2)
  })

  test('rejected 轮级 reason 取成员共享退回原因；approved 为 null', () => {
    const rejected = groupDocVersionRounds([
      mkRow({ id: 'a0', roundGeneration: 1, decision: 'rejected', decisionReason: 'too vague' }),
      mkRow({
        id: 'a1',
        roundGeneration: 1,
        itemIndex: 1,
        decision: 'rejected',
        decisionReason: 'too vague',
      }),
    ])
    expect(rejected[0]!.decisionReason).toBe('too vague')
    const approved = groupDocVersionRounds([
      mkRow({ id: 'b0', roundGeneration: 1, decision: 'approved', decidedAt: 1 }),
    ])
    expect(approved[0]!.decision).toBe('approved')
    expect(approved[0]!.decisionReason).toBeNull()
  })

  test('legacy NULL generation 按 reviewIteration 归并且排在 generation 轮之前', () => {
    const rounds = groupDocVersionRounds([
      mkRow({ id: 'g0', roundGeneration: 5, reviewIteration: 1, itemIndex: 0 }),
      mkRow({
        id: 'l0',
        roundGeneration: null,
        reviewIteration: 0,
        itemIndex: 0,
        decision: 'iterated',
      }),
      mkRow({
        id: 'l1',
        roundGeneration: null,
        reviewIteration: 0,
        itemIndex: 1,
        decision: 'iterated',
      }),
    ])
    expect(rounds.map((r) => r.roundKey)).toEqual(['i0-legacy', 'g5'])
    expect(rounds[0]!.members.map((m) => m.id)).toEqual(['l0', 'l1'])
    expect(rounds[0]!.roundGeneration).toBeNull()
    expect(rounds[1]!.isCurrent).toBe(true)
  })

  test('refresh：同一 reviewIteration 两代分两轮；superseded 带系统原因；全决策时末轮 isCurrent', () => {
    const rounds = groupDocVersionRounds([
      mkRow({
        id: 's0',
        roundGeneration: 1,
        decision: 'superseded',
        decisionReason: 'upstream-refreshed',
        decidedBy: 'system',
        decidedAt: 100,
      }),
      mkRow({ id: 'n0', roundGeneration: 2, decision: 'iterated', decidedAt: 200 }),
    ])
    expect(rounds.length).toBe(2)
    expect(rounds[0]!.roundKey).toBe('g1')
    expect(rounds[0]!.decision).toBe('superseded')
    expect(rounds[0]!.decisionReason).toBe('upstream-refreshed')
    expect(rounds[0]!.decidedBy).toBe('system')
    expect(rounds[1]!.isCurrent).toBe(true)
    expect(rounds[0]!.reviewIteration).toBe(rounds[1]!.reviewIteration)
  })

  test('成员按 itemIndex 升序；单文档行（itemIndex NULL）不产轮', () => {
    const rounds = groupDocVersionRounds([
      mkRow({ id: 'c2', roundGeneration: 1, itemIndex: 2 }),
      mkRow({ id: 'c0', roundGeneration: 1, itemIndex: 0 }),
      mkRow({ id: 'c1', roundGeneration: 1, itemIndex: 1 }),
      mkRow({ id: 'single', roundGeneration: null, itemIndex: null }),
    ])
    expect(rounds.length).toBe(1)
    expect(rounds[0]!.members.map((m) => m.id)).toEqual(['c0', 'c1', 'c2'])
    expect(groupDocVersionRounds([mkRow({ id: 'only-single', itemIndex: null })])).toEqual([])
  })

  test('防御：轮内决策异质标 hasMixedDecisions，decision 取首个非 pending', () => {
    const rounds = groupDocVersionRounds([
      mkRow({ id: 'm0', roundGeneration: 1, itemIndex: 0, decision: 'approved', decidedAt: 1 }),
      mkRow({ id: 'm1', roundGeneration: 1, itemIndex: 1, decision: 'pending' }),
    ])
    expect(rounds[0]!.hasMixedDecisions).toBe(true)
    expect(rounds[0]!.decision).toBe('approved')
  })
})

// ---------------------------------------------------------------------------
// 集成层 — listReviewRounds + getReviewDetail G4（复用 review-multidoc 夹具形态）
// ---------------------------------------------------------------------------

describe('RFC-142 — listReviewRounds / getReviewDetail 混代（集成）', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc142-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    rimrafDir(appHome)
    rimrafDir(worktree)
  })

  const PATHS = ['cases/a.md', 'cases/b.md', 'cases/c.md']

  async function seed(): Promise<{
    taskId: string
    task: typeof tasks.$inferSelect
    definition: WorkflowDefinition
    reviewNode: WorkflowNode
  }> {
    await db.insert(agentsTable).values({
      id: ulid(),
      name: 'caseGen',
      description: '',
      outputs: JSON.stringify(['cases']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: JSON.stringify({ outputKinds: { cases: 'list<path<md>>' } }),
      bodyMd: '',
    })
    const definition: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'src',
          kind: 'agent-single',
          agentName: 'caseGen',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'src', portName: 'cases' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      description: '',
      definition: JSON.stringify(definition),
      version: 1,
    })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'rounds',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: worktree,
      worktreePath: worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    const reviewNode = definition.nodes.find((n) => n.id === 'rev_1')!
    return { taskId, task, definition, reviewNode }
  }

  async function seedSrc(taskId: string, id: string, marker: string): Promise<void> {
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId: 'src',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now(),
      finishedAt: Date.now(),
    })
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: id, portName: 'cases', content: PATHS.join('\n') })
    for (const p of PATHS) {
      const abs = join(worktree, p)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, `# Case ${p} (${marker})\n\nsteps for ${p}\n`, 'utf8')
    }
  }

  async function insertComment(docVersionId: string, text: string): Promise<void> {
    await db.insert(reviewComments).values({
      id: ulid(),
      docVersionId,
      anchorSectionPath: 'p0',
      anchorParagraphIdx: 0,
      anchorOffsetStart: 0,
      anchorOffsetEnd: 4,
      selectedText: 'Case',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 0,
      commentText: text,
      createdAt: Date.now(),
    })
  }

  function pendingDocs(taskId: string) {
    return db
      .select()
      .from(docVersions)
      .where(and(eq(docVersions.taskId, taskId), eq(docVersions.decision, 'pending')))
      .orderBy(docVersions.itemIndex)
  }

  test('iterate 两轮：轮全字段 + 已决策成员 commentCount 计冻结评论（原实现恒 0）', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    await seedSrc(taskId, '01A_SRC', 'v1')
    const r1 = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(r1.kind).toBe('awaiting_review')
    const round1Docs = await pendingDocs(taskId)
    expect(round1Docs.length).toBe(3)
    const reviewNodeRunId = round1Docs[0]!.reviewNodeRunId

    // 第 0 篇挂一条评论后 iterate —— 决策会删 live 行、冻结进 commentsJson。
    await insertComment(round1Docs[0]!.id, 'tighten the steps')
    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
      author: 'alice',
      authorRole: 'owner',
    })

    // 模拟上游重跑完成：iterate 铸出的 fresh pending src 行置 done + 补输出。
    const srcRerun = (
      await db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            eq(nodeRuns.nodeId, 'src'),
            eq(nodeRuns.status, 'pending'),
          ),
        )
    )[0]!
    await db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, srcRerun.id))
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: srcRerun.id, portName: 'cases', content: PATHS.join('\n') })

    const r2 = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(r2.kind).toBe('awaiting_review')

    const rounds = await listReviewRounds(db, appHome, reviewNodeRunId)
    expect(rounds.length).toBe(2)
    const [old, cur] = [rounds[0]!, rounds[1]!]
    expect(old.roundKey).toBe('g1')
    expect(old.decision).toBe('iterated')
    expect(old.decisionReason).toBeNull() // iterated：意见在成员冻结评论里
    expect(old.decidedBy).toBe('alice')
    expect(old.decidedByRole).toBe('owner')
    expect(old.isCurrent).toBe(false)
    expect(old.reviewIteration).toBe(0)
    expect(old.members.map((m) => m.itemIndex)).toEqual([0, 1, 2])
    expect(old.members[0]!.decision).toBe('iterated')
    // RFC-142 顺带修复：已决策成员 commentCount 必须来自冻结 commentsJson。
    expect(old.members[0]!.commentCount).toBe(1)
    expect(old.members[1]!.commentCount).toBe(0)
    expect(cur.roundKey).toBe('g2')
    expect(cur.decision).toBe('pending')
    expect(cur.isCurrent).toBe(true)
    expect(cur.reviewIteration).toBe(1)
    expect(cur.members.length).toBe(3)

    // 第二轮也评论 + iterate 后（无 pending 轮）：getReviewDetail 落到已决策
    // 分支，commentCount 同样计冻结评论、documents 为最新代成员。评论落在
    // 第 0 篇（= currentVersion）上——Codex 实现门 P2 回归锁：已决策当前视图
    // 的 detail.comments 必须回冻结评论（live 行决策时已删，旧实现返回空，
    // 首篇「徽标有数、正文无评论」）。
    const round2Docs = await pendingDocs(taskId)
    await insertComment(round2Docs[0]!.id, 'still too loose')
    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 1,
    })
    const detail = await getReviewDetail(db, appHome, reviewNodeRunId)
    expect(detail.documents).toBeDefined()
    expect(detail.documents!.length).toBe(3)
    expect(detail.documents!.map((d) => d.itemIndex)).toEqual([0, 1, 2])
    expect(detail.documents![0]!.commentCount).toBe(1)
    // P2 修复断言：currentVersion（第 0 篇）已决策 → comments 来自冻结快照。
    expect(detail.currentVersion.id).toBe(round2Docs[0]!.id)
    expect(detail.comments.length).toBe(1)
    expect(detail.comments[0]!.commentText).toBe('still too loose')
    const roundsAfter = await listReviewRounds(db, appHome, reviewNodeRunId)
    expect(roundsAfter[1]!.isCurrent).toBe(true) // 无 pending → 末轮
  })

  test('G4 回归：refresh 同 iteration 两代，getReviewDetail 只取最高代（旧实现混代翻倍）', async () => {
    const { taskId, task, definition, reviewNode } = await seed()
    await seedSrc(taskId, '01A_SRC', 'old')
    const r1 = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(r1.kind).toBe('awaiting_review')
    const gen1 = await pendingDocs(taskId)
    const reviewNodeRunId = gen1[0]!.reviewNodeRunId

    // 审中上游出了更新的 done run（RFC-074 refresh）→ 旧代 superseded + 新代重铸。
    await seedSrc(taskId, '01B_SRC', 'new')
    const r2 = await dispatchReviewNode({
      db,
      taskId,
      task,
      appHome,
      definition,
      node: reviewNode,
      iteration: 0,
    })
    expect(r2.kind).toBe('awaiting_review')
    const gen2 = await pendingDocs(taskId)
    expect(gen2.length).toBe(3)
    expect(gen2[0]!.roundGeneration).toBe(2)

    // 决掉新代（iterate）→ 同一 reviewIteration 0 下：3 行 superseded(g1) + 3 行 iterated(g2)。
    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const detail = await getReviewDetail(db, appHome, reviewNodeRunId)
    // G4：只允许最高代成员——旧实现按 max reviewIteration 过滤会给出 6 条（itemIndex 重复）。
    expect(detail.documents!.length).toBe(3)
    expect(detail.documents!.map((d) => d.itemIndex)).toEqual([0, 1, 2])
    const gen2Ids = new Set(gen2.map((d) => d.id))
    for (const d of detail.documents!) expect(gen2Ids.has(d.docVersionId)).toBe(true)

    const rounds = await listReviewRounds(db, appHome, reviewNodeRunId)
    expect(rounds.map((r) => r.roundKey)).toEqual(['g1', 'g2'])
    expect(rounds[0]!.decision).toBe('superseded')
    expect(rounds[0]!.decisionReason).toBe('upstream-refreshed')
    expect(rounds[0]!.decidedBy).toBe('system')
    expect(rounds[1]!.decision).toBe('iterated')
    expect(rounds[1]!.isCurrent).toBe(true)
    expect(rounds[0]!.reviewIteration).toBe(rounds[1]!.reviewIteration)
  })

  test('单文档评审 → []', async () => {
    const { taskId } = await seed()
    const reviewRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
    writeFileSync(join(appHome, 'doc_versions/v1.md'), '# single')
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'src',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'doc_versions/v1.md',
      decision: 'pending',
      createdAt: Date.now(),
    })
    expect(await listReviewRounds(db, appHome, reviewRunId)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 路由层 — GET /api/reviews/:nodeRunId/rounds 的 ACL（与 /versions 同门）
// ---------------------------------------------------------------------------

const DAEMON_TOKEN = 'a'.repeat(64)

describe('RFC-142 — /rounds 路由 ACL', () => {
  let db: DbClient
  let app: Hono
  let appHome = ''
  let taskId = ''
  let reviewRunId = ''
  let owner = { id: '', token: '' }
  let stranger = { id: '', token: '' }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc142-http-'))
    appHome = join(tmp, 'appHome')
    mkdirSync(appHome, { recursive: true })
    process.env.AGENT_WORKFLOW_HOME = appHome
    app = createApp({
      token: DAEMON_TOKEN,
      configPath: '',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    async function mk(username: string) {
      const u = await createUser(db, {
        username,
        displayName: `dn-${username}`,
        role: 'user',
        password: 'longEnoughPassword',
      })
      const { token } = await createSession({ db, userId: u.id })
      return { id: u.id, token }
    }
    owner = await mk('alice142')
    stranger = await mk('dave142')

    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'src',
          kind: 'agent-single',
          agentName: 'caseGen',
          promptTemplate: '',
        } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'src', portName: 'cases' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db
      .insert(workflows)
      .values({ id: workflowId, name: 'wf', definition: JSON.stringify(definition) })
    taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 't142',
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: owner.id,
    })
    await db.insert(taskCollaborators).values({
      taskId,
      userId: owner.id,
      role: 'owner',
      addedBy: owner.id,
      addedAt: Date.now(),
    })
    reviewRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now(),
    })
    mkdirSync(join(appHome, 'dv'), { recursive: true })
    for (const i of [0, 1]) {
      writeFileSync(join(appHome, `dv/item${i}.md`), `# Item ${i}\n`)
      await db.insert(docVersions).values({
        id: ulid(),
        taskId,
        reviewNodeId: 'rev_1',
        reviewNodeRunId: reviewRunId,
        sourceNodeId: 'src',
        sourcePortName: 'cases',
        versionIndex: 1,
        reviewIteration: 0,
        bodyPath: `dv/item${i}.md`,
        decision: 'pending',
        itemIndex: i,
        itemPath: `cases/${i}.md`,
        selection: 'unselected',
        roundGeneration: 1,
        createdAt: Date.now(),
      })
    }
  })
  afterEach(() => {
    rimrafDir(appHome)
  })

  async function req(token: string, path: string): Promise<Response> {
    return await app.request(path, { headers: { Authorization: `Bearer ${token}` } })
  }

  test('陌生人 403 task-not-visible；owner 200 得轮；未知 nodeRunId 404', async () => {
    const forbidden = await req(stranger.token, `/api/reviews/${reviewRunId}/rounds`)
    expect(forbidden.status).toBe(403)
    const forbiddenBody = (await forbidden.json()) as { code?: string; error?: { code?: string } }
    expect(JSON.stringify(forbiddenBody)).toContain('task-not-visible')

    const ok = await req(owner.token, `/api/reviews/${reviewRunId}/rounds`)
    expect(ok.status).toBe(200)
    const rounds = (await ok.json()) as Array<{
      roundKey: string
      isCurrent: boolean
      members: Array<{ itemIndex: number; title: string }>
    }>
    expect(rounds.length).toBe(1)
    expect(rounds[0]!.roundKey).toBe('g1')
    expect(rounds[0]!.isCurrent).toBe(true)
    expect(rounds[0]!.members.map((m) => m.itemIndex)).toEqual([0, 1])
    expect(rounds[0]!.members[0]!.title).toBe('Item 0')

    const missing = await req(owner.token, `/api/reviews/${ulid()}/rounds`)
    expect(missing.status).toBe(404)
  })
})
