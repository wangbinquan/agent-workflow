// RFC-359 W7 —— `CollaborationRouteOperations` 持久化面的双引擎对拍。
//
// 为什么存在：合一前这一对是 `sqliteCollaborationRouteOperations.ts`（116 行纯转发，逐方法
// 打到 `legacySqlite*` 的中立实现上）+ `postgresqlCollaborationRouteOperations.ts`（2269 行
// 把同一批语义用原生 drizzle 重写了一遍）。两份实现的**方法集**一一对应，但重写本身就是漂移
// 的前提；本文件把端口契约写成**同一段断言**，`describeEachProvider` 在两个引擎上各跑一遍。
//
// 判据来源：`application/ports/collaborationRouteOperations.ts` 的端口契约，语义注释在
// `infrastructure/review.ts`（RFC-005 评论锚 / RFC-079 多文档 / RFC-158 摘要装配）、
// `taskQuestions.ts`（RFC-140 问题条目）与 `clarifyRounds.ts`（草稿）。

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, docVersions, nodeRuns, tasks, taskQuestions, workflows } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createCollaborationRouteOperations } from '@/modules/collaboration/infrastructure/collaborationRouteOperations'
import type {
  CollaborationRouteActor,
  CollaborationRoutePersistenceOperations,
} from '@/modules/collaboration/application/ports/collaborationRouteOperations'
import { createCollaborationClarifyDraftEventPublisher } from '@/modules/collaboration/infrastructure/collaborationClarifyDraftEventPublisher'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'

const ulid = monotonicFactory()

const WRITER = 'writer'
const REVIEW = 'rv'
const ASKER = 'asker'
const DESIGNER = 'designer'
const CLARIFY = 'cl'

let APP_HOME = ''

beforeAll(() => {
  APP_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-route-'))
})

afterAll(() => {
  if (APP_HOME !== '') rmSync(APP_HOME, { recursive: true, force: true })
})

const ACTOR: CollaborationRouteActor = Object.freeze({
  user: Object.freeze({
    id: 'u_actor',
    username: 'actor',
    displayName: 'Actor',
    role: 'admin' as const,
    status: 'active' as const,
  }),
  source: 'session' as const,
  permissions: new Set(['tasks:read:all' as const]),
})

// 合一后两个引擎装配的是同一个工厂；`describeEachProvider` 只换客户端。
function operations(db: ProviderNeutralDatabase): CollaborationRoutePersistenceOperations {
  return createCollaborationRouteOperations({
    db,
    clarifyDraftEvents: createCollaborationClarifyDraftEventPublisher(),
  })
}

function reviewDefinition(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: WRITER, kind: 'agent-single', agentName: 'agent-writer' } as WorkflowNode,
    {
      id: REVIEW,
      kind: 'review',
      title: 'Design Review',
      description: 'the round humans judge',
    } as unknown as WorkflowNode,
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'agent-designer' } as WorkflowNode,
    { id: CLARIFY, kind: 'clarify', title: 'cl' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_writer_review',
        source: { nodeId: WRITER, portName: 'out' },
        target: { nodeId: REVIEW, portName: 'in' },
      },
      {
        id: 'e_designer_asker',
        source: { nodeId: DESIGNER, portName: 'out' },
        target: { nodeId: ASKER, portName: 'in' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

function writeBody(relativePath: string, body: string): void {
  const absolute = join(APP_HOME, relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, body, 'utf8')
}

interface ReviewFixture {
  readonly taskId: string
  readonly reviewNodeRunId: string
  readonly versionIds: readonly string[]
}

async function seedTask(
  db: ProviderNeutralDatabase,
  overrides: { status?: string } = {},
): Promise<string> {
  const taskId = `t_${ulid()}`
  const definition = JSON.stringify(reviewDefinition())
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc359-w7-route',
    description: '',
    definition,
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359 w7 route',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: definition,
    repoPath: '/tmp/aw-rfc359-w7',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: (overrides.status ?? 'awaiting_review') as 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
    // 决定路径的 continuation 准入要核对 lineage；SQLite 上有触发器回填，PostgreSQL 还没有。
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
  return taskId
}

/** 手工问题的目标节点必须跑过（`manual-question-target-never-run`）。 */
async function seedDoneRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId: string,
): Promise<string> {
  const id = `nr_${ulid()}`
  await db
    .insert(nodeRuns)
    .values({ id, taskId, nodeId, status: 'done', retryIndex: 0, iteration: 0 })
  return id
}

/** 单文档评审轮：一个 awaiting_review 的 node_run + 两个版本（v1 已迭代、v2 未决）。 */
async function seedSingleDocReview(db: ProviderNeutralDatabase): Promise<ReviewFixture> {
  const taskId = await seedTask(db)
  const reviewNodeRunId = `nr_${ulid()}`
  await db.insert(nodeRuns).values({
    id: reviewNodeRunId,
    taskId,
    nodeId: REVIEW,
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 1,
  })
  const v1 = `dv_${ulid()}`
  const v2 = `dv_${ulid()}`
  writeBody(`reviews/${taskId}/v1.md`, '# Title one\n\nalpha beta gamma\n')
  writeBody(`reviews/${taskId}/v2.md`, '# Title two\n\nalpha beta gamma\n')
  await db.insert(docVersions).values([
    {
      id: v1,
      taskId,
      reviewNodeId: REVIEW,
      reviewNodeRunId,
      sourceNodeId: WRITER,
      sourcePortName: 'out',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: `reviews/${taskId}/v1.md`,
      commentsJson: '[]',
      decision: 'iterated',
      createdAt: 1_000,
      decidedAt: 1_500,
    },
    {
      id: v2,
      taskId,
      reviewNodeId: REVIEW,
      reviewNodeRunId,
      sourceNodeId: WRITER,
      sourcePortName: 'out',
      versionIndex: 2,
      reviewIteration: 1,
      bodyPath: `reviews/${taskId}/v2.md`,
      commentsJson: '[]',
      decision: 'pending',
      createdAt: 2_000,
    },
  ])
  return { taskId, reviewNodeRunId, versionIds: [v1, v2] }
}

/** 多文档评审轮：两个成员行（item_index 0/1），用于选择（selection）判据。 */
async function seedMultiDocReview(db: ProviderNeutralDatabase): Promise<ReviewFixture> {
  const taskId = await seedTask(db)
  const reviewNodeRunId = `nr_${ulid()}`
  await db.insert(nodeRuns).values({
    id: reviewNodeRunId,
    taskId,
    nodeId: REVIEW,
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
  })
  const ids = [`dv_${ulid()}`, `dv_${ulid()}`]
  const rows = ids.map((id, index) => {
    const bodyPath = `reviews/${taskId}/m${index}.md`
    writeBody(bodyPath, `# member ${index}\n\nbody ${index}\n`)
    return {
      id,
      taskId,
      reviewNodeId: REVIEW,
      reviewNodeRunId,
      sourceNodeId: WRITER,
      sourcePortName: 'out',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath,
      commentsJson: '[]',
      decision: 'pending' as const,
      itemIndex: index,
      itemPath: `docs/m${index}.md`,
      selection: 'unselected' as const,
      roundGeneration: 1,
      createdAt: 3_000 + index,
    }
  })
  await db.insert(docVersions).values(rows)
  return { taskId, reviewNodeRunId, versionIds: ids }
}

describeEachProvider('RFC-359 W7 —— 协作路由持久化（CollaborationRouteOperations）', (harness) => {
  // -------------------------------------------------------------------------
  // reviews
  // -------------------------------------------------------------------------

  test('reviews.list —— pending 只取每个 port 的最新未决版本，并带上节点标题/描述', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const rows = await operations(db).reviews.list({ status: 'pending' })
    const mine = rows.filter((row) => row.taskId === fixture.taskId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      nodeRunId: fixture.reviewNodeRunId,
      taskId: fixture.taskId,
      reviewNodeId: REVIEW,
      title: 'Design Review',
      description: 'the round humans judge',
      currentVersionIndex: 2,
      reviewIteration: 1,
      decision: 'pending',
      awaitingReview: true,
      isMultiDoc: false,
    })
  })

  test('reviews.list —— taskId 过滤与 all 状态返回历史轮', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const other = await seedSingleDocReview(db)
    const ops = operations(db)
    const scoped = await ops.reviews.list({ status: 'all', taskId: fixture.taskId })
    expect(scoped.map((row) => row.taskId)).toEqual([fixture.taskId])
    expect(scoped.every((row) => row.taskId !== other.taskId)).toBe(true)
    // 每个 (run, port) 只暴露最新版本，所以历史 'iterated' 版本不会因为状态过滤重新冒出来。
    const iterated = await ops.reviews.list({ status: 'iterated', taskId: fixture.taskId })
    expect(iterated).toEqual([])
  })

  test('reviews.countPending —— 只数 awaiting_review 的最新未决版本；终态任务不计入', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const ops = operations(db)
    expect(await ops.reviews.countPending(ACTOR)).toBe(1)
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, fixture.taskId))
    expect(await ops.reviews.countPending(ACTOR)).toBe(0)
  })

  test('reviews.detail —— 返回当前轮正文、摘要与版本清单', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const detail = await operations(db).reviews.detail({
      appHome: APP_HOME,
      nodeRunId: fixture.reviewNodeRunId,
    })
    expect(detail.summary).toMatchObject({
      nodeRunId: fixture.reviewNodeRunId,
      currentVersionIndex: 2,
      title: 'Design Review',
    })
    expect(detail.currentVersion.versionIndex).toBe(2)
    expect(detail.currentBody).toContain('Title two')
    expect(detail.comments).toEqual([])
    expect(detail.rerunnableOnReject).toEqual([])
    expect(detail.rerunnableOnIterate).toEqual([])
    expect(detail.documents).toBeUndefined()

    // 多文档轮：`documents` 是「多文档模式」的判别式（RFC-079），成员按 item_index 排。
    const multi = await seedMultiDocReview(db)
    const multiDetail = await operations(db).reviews.detail({
      appHome: APP_HOME,
      nodeRunId: multi.reviewNodeRunId,
    })
    expect(multiDetail.summary.isMultiDoc).toBe(true)
    expect(multiDetail.documents?.map((document) => document.itemIndex)).toEqual([0, 1])
    expect(multiDetail.documents?.map((document) => document.itemPath)).toEqual([
      'docs/m0.md',
      'docs/m1.md',
    ])
  })

  test('reviews.listVersions —— 按 versionIndex 降序', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const versions = await operations(db).reviews.listVersions(fixture.reviewNodeRunId)
    expect(versions.map((version) => version.versionIndex)).toEqual([2, 1])
    expect(versions.map((version) => version.id)).toEqual([
      fixture.versionIds[1]!,
      fixture.versionIds[0]!,
    ])
  })

  test('reviews.versionDetail —— 带正文与冻结评论；未知版本返回 null', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const ops = operations(db)
    const detail = await ops.reviews.versionDetail({
      appHome: APP_HOME,
      nodeRunId: fixture.reviewNodeRunId,
      versionId: fixture.versionIds[0]!,
    })
    expect(detail?.versionIndex).toBe(1)
    expect(detail?.body).toContain('Title one')
    expect(
      await ops.reviews.versionDetail({
        appHome: APP_HOME,
        nodeRunId: fixture.reviewNodeRunId,
        versionId: 'dv_missing',
      }),
    ).toBeNull()
  })

  test('reviews.listRounds —— 只对多文档轮成组；单文档轮返回空', async () => {
    const db = harness.db
    const single = await seedSingleDocReview(db)
    const ops = operations(db)
    expect(
      await ops.reviews.listRounds({ appHome: APP_HOME, nodeRunId: single.reviewNodeRunId }),
    ).toEqual([])

    const multi = await seedMultiDocReview(db)
    const rounds = await ops.reviews.listRounds({
      appHome: APP_HOME,
      nodeRunId: multi.reviewNodeRunId,
    })
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({
      roundKey: 'g1',
      reviewIteration: 0,
      roundGeneration: 1,
      decision: 'pending',
      isCurrent: true,
    })
    expect(rounds[0]?.members.map((member) => member.itemIndex)).toEqual([0, 1])
  })

  test('reviews.setSelection —— 多文档成员的选择落库并清除 stale 标记', async () => {
    const db = harness.db
    const fixture = await seedMultiDocReview(db)
    const result = await operations(db).reviews.setSelection({
      nodeRunId: fixture.reviewNodeRunId,
      docVersionId: fixture.versionIds[0]!,
      selection: 'accepted',
    })
    expect(result).toEqual({
      taskId: fixture.taskId,
      docVersionId: fixture.versionIds[0]!,
      selection: 'accepted',
    })
    const rows = await db
      .select({ id: docVersions.id, selection: docVersions.selection })
      .from(docVersions)
      .where(eq(docVersions.reviewNodeRunId, fixture.reviewNodeRunId))
    expect(Object.fromEntries(rows.map((row) => [row.id, row.selection]))).toEqual({
      [fixture.versionIds[0]!]: 'accepted',
      [fixture.versionIds[1]!]: 'unselected',
    })
  })

  test('reviews.setSelection —— 外层事务回滚必须带走它的写（重入语义）', async () => {
    const db = harness.db
    const fixture = await seedMultiDocReview(db)
    const ops = operations(db)
    await expect(
      databaseSessionFor(db).transaction(async () => {
        await ops.reviews.setSelection({
          nodeRunId: fixture.reviewNodeRunId,
          docVersionId: fixture.versionIds[0]!,
          selection: 'accepted',
        })
        throw new Error('rollback-probe')
      }),
    ).rejects.toThrow('rollback-probe')
    const rows = await db
      .select({ selection: docVersions.selection })
      .from(docVersions)
      .where(eq(docVersions.id, fixture.versionIds[0]!))
    expect(rows[0]?.selection).toBe('unselected')
  })

  test('reviews.addComment/updateComment/deleteComment —— 锚定、改写与删除的完整回路', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const ops = operations(db)
    const added = await ops.reviews.addComment({
      appHome: APP_HOME,
      nodeRunId: fixture.reviewNodeRunId,
      commentText: 'needs work',
      author: ACTOR.user.id,
      authorRole: 'owner',
      anchorRequest: { quote: 'alpha' },
    })
    expect(added.commentText).toBe('needs work')
    expect(added.anchor.selectedText).toBe('alpha')
    expect(added.warnings).toEqual([])
    expect(added.author).toBe(ACTOR.user.id)

    const updated = await ops.reviews.updateComment({
      nodeRunId: fixture.reviewNodeRunId,
      commentId: added.id,
      commentText: 'looks better',
      authority: { actorUserId: ACTOR.user.id, role: 'owner' },
    })
    expect(updated.commentText).toBe('looks better')

    await ops.reviews.deleteComment({
      nodeRunId: fixture.reviewNodeRunId,
      commentId: added.id,
      authority: { actorUserId: ACTOR.user.id, role: 'owner' },
    })
    const detail = await ops.reviews.detail({
      appHome: APP_HOME,
      nodeRunId: fixture.reviewNodeRunId,
    })
    expect(detail.comments).toEqual([])
  })

  test('reviews.updateComment —— 非作者且非管理身份改不动别人的评论', async () => {
    const db = harness.db
    const fixture = await seedSingleDocReview(db)
    const ops = operations(db)
    const added = await ops.reviews.addComment({
      appHome: APP_HOME,
      nodeRunId: fixture.reviewNodeRunId,
      commentText: 'mine',
      author: ACTOR.user.id,
      authorRole: 'owner',
      anchorRequest: { quote: 'beta' },
    })
    await expect(
      ops.reviews.updateComment({
        nodeRunId: fixture.reviewNodeRunId,
        commentId: added.id,
        commentText: 'hijack',
        authority: { actorUserId: 'u_other', role: 'user' },
      }),
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // questions
  // -------------------------------------------------------------------------

  test('questions.createManual/list/confirm/stage —— 手工问题的完整生命周期', async () => {
    const db = harness.db
    const taskId = await seedTask(db, { status: 'running' })
    const designerRun = await seedDoneRun(db, taskId, DESIGNER)
    await seedDoneRun(db, taskId, ASKER)
    const ops = operations(db)
    const created = await ops.questions.createManual({
      taskId,
      title: 'manual title',
      body: 'manual body',
      targetNodeId: DESIGNER,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    expect(created.id.length).toBeGreaterThan(0)

    const listed = await ops.questions.list({ taskId })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: created.id,
      taskId,
      sourceKind: 'manual',
      roleKind: 'designer',
      effectiveTargetNodeId: DESIGNER,
      overrideTargetNodeId: DESIGNER,
      defaultTargetNodeId: null,
      questionTitle: 'manual title',
      answerSummary: 'manual body',
      phase: 'staged',
      confirmation: 'open',
      confirmedBy: null,
      // 手工问题落库即 staged（作者已经写完，等的是确认与派发）。
      staged: true,
      sealed: true,
      reopenCount: 0,
    })

    // 未下发的条目可以在待下发与待指派之间来回切
    await ops.questions.stage({
      entryId: created.id,
      staged: false,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    expect((await ops.questions.list({ taskId }))[0]).toMatchObject({
      staged: false,
      phase: 'pending',
    })
    await ops.questions.stage({
      entryId: created.id,
      staged: true,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    expect((await ops.questions.list({ taskId }))[0]?.staged).toBe(true)

    // 只有 awaiting_confirm 的条目才可确认：把条目挂到一条已 done 的承接 run 上。
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now(), dispatchedBy: ACTOR.user.id, triggerRunId: designerRun })
      .where(eq(taskQuestions.id, created.id))
    expect((await ops.questions.list({ taskId }))[0]?.phase).toBe('awaiting_confirm')
    await ops.questions.confirm({
      entryId: created.id,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    expect((await ops.questions.list({ taskId }))[0]).toMatchObject({
      confirmation: 'confirmed',
      confirmedBy: ACTOR.user.id,
      phase: 'done',
      staged: true,
    })

    // 已下发的条目不可再 stage（RFC-134 D10 的单语句 CAS）
    await expect(
      ops.questions.stage({
        entryId: created.id,
        staged: true,
        actor: { userId: ACTOR.user.id, role: 'owner' },
      }),
    ).rejects.toThrow()
  })

  test('questions.createManual —— 目标节点必须在快照里', async () => {
    const db = harness.db
    const taskId = await seedTask(db, { status: 'running' })
    await seedDoneRun(db, taskId, DESIGNER)
    await expect(
      operations(db).questions.createManual({
        taskId,
        title: 'manual title',
        body: 'manual body',
        targetNodeId: 'nope',
        actor: { userId: ACTOR.user.id, role: 'owner' },
      }),
    ).rejects.toThrow()
  })

  test('questions.reassign —— 手工问题改目标节点是 moved-manual', async () => {
    const db = harness.db
    const taskId = await seedTask(db, { status: 'running' })
    await seedDoneRun(db, taskId, DESIGNER)
    await seedDoneRun(db, taskId, ASKER)
    const ops = operations(db)
    const created = await ops.questions.createManual({
      taskId,
      title: 'manual title',
      body: 'manual body',
      targetNodeId: DESIGNER,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    const action = await ops.questions.reassign({
      entryId: created.id,
      targetNodeId: ASKER,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    expect(action).toBe('moved-manual')
    const rows = await db
      .select({ override: taskQuestions.overrideTargetNodeId })
      .from(taskQuestions)
      .where(eq(taskQuestions.id, created.id))
    expect(rows[0]?.override).toBe(ASKER)
    expect((await ops.questions.list({ taskId }))[0]?.effectiveTargetNodeId).toBe(ASKER)
  })

  test('questions.confirm —— 已派发条目不可再确认', async () => {
    const db = harness.db
    const taskId = await seedTask(db, { status: 'running' })
    await seedDoneRun(db, taskId, DESIGNER)
    await seedDoneRun(db, taskId, ASKER)
    const ops = operations(db)
    const created = await ops.questions.createManual({
      taskId,
      title: 'manual title',
      body: 'manual body',
      targetNodeId: DESIGNER,
      actor: { userId: ACTOR.user.id, role: 'owner' },
    })
    await db
      .update(taskQuestions)
      .set({ dispatchedAt: Date.now(), dispatchedBy: ACTOR.user.id })
      .where(eq(taskQuestions.id, created.id))
    await expect(
      ops.questions.confirm({
        entryId: created.id,
        actor: { userId: ACTOR.user.id, role: 'owner' },
      }),
    ).rejects.toThrow()
  })

  // -------------------------------------------------------------------------
  // clarify
  // -------------------------------------------------------------------------

  test('clarify.list/countPending/detail —— 未答轮的列表、计数与详情', async () => {
    const db = harness.db
    const { taskId, roundId, originNodeRunId } = await seedClarifyRound(db)
    const ops = operations(db)
    const rows = await ops.clarify.list({ taskId })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      intermediaryNodeRunId: originNodeRunId,
      taskId,
      kind: 'self',
      status: 'awaiting_human',
      questionCount: 2,
    })
    expect(await ops.clarify.countPending(ACTOR)).toBe(1)
    const detail = await ops.clarify.detail(originNodeRunId)
    expect(detail.id).toBe(roundId)
    expect(detail.questions.map((question) => question.id)).toEqual(['q1', 'q2'])
    expect(detail.status).toBe('awaiting_human')
  })

  test('clarify.saveDraft —— 逐题草稿 + 归属落库，重复保存后写胜出', async () => {
    const db = harness.db
    const { taskId, roundId, originNodeRunId } = await seedClarifyRound(db)
    const ops = operations(db)
    const first = await ops.clarify.saveDraft({
      intermediaryNodeRunId: originNodeRunId,
      roundId,
      questionId: 'q1',
      value: { selectedOptionIndices: [0], customText: '' },
      editor: { userId: ACTOR.user.id, displayName: 'Actor', role: 'owner' },
    })
    expect(first).toMatchObject({ roundId, questionId: 'q1' })
    await ops.clarify.saveDraft({
      intermediaryNodeRunId: originNodeRunId,
      roundId,
      questionId: 'q1',
      value: { selectedOptionIndices: [1], customText: 'later' },
      editor: { userId: 'u_second', displayName: 'Second', role: 'user' },
    })
    const rows = await db
      .select({
        drafts: clarifyRounds.draftAnswersJson,
        attributions: clarifyRounds.answerAttributionsJson,
      })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, roundId))
    const drafts = JSON.parse(rows[0]?.drafts ?? '{}') as Record<string, { customText: string }>
    expect(drafts['q1']?.customText).toBe('later')
    const attributions = JSON.parse(rows[0]?.attributions ?? '{}') as Record<
      string,
      { userId: string }
    >
    expect(attributions['q1']?.userId).toBe('u_second')
    expect(taskId.length).toBeGreaterThan(0)
  })

  test('clarify.saveDraft —— 外层事务回滚必须带走它的写（重入语义）', async () => {
    const db = harness.db
    const { roundId, originNodeRunId } = await seedClarifyRound(db)
    const ops = operations(db)
    await expect(
      databaseSessionFor(db).transaction(async () => {
        await ops.clarify.saveDraft({
          intermediaryNodeRunId: originNodeRunId,
          roundId,
          questionId: 'q1',
          value: { selectedOptionIndices: [0], customText: 'draft' },
          editor: { userId: ACTOR.user.id, displayName: 'Actor', role: 'owner' },
        })
        throw new Error('rollback-probe')
      }),
    ).rejects.toThrow('rollback-probe')
    const rows = await db
      .select({ drafts: clarifyRounds.draftAnswersJson })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, roundId))
    expect(rows[0]?.drafts ?? null).toBeNull()
  })

  test('clarify.saveDraft —— 非 awaiting_human 的轮拒绝草稿', async () => {
    const db = harness.db
    const { roundId, originNodeRunId } = await seedClarifyRound(db)
    await db
      .update(clarifyRounds)
      .set({ status: 'answered', answeredAt: Date.now() })
      .where(eq(clarifyRounds.id, roundId))
    await expect(
      operations(db).clarify.saveDraft({
        intermediaryNodeRunId: originNodeRunId,
        roundId,
        questionId: 'q1',
        value: { selectedOptionIndices: [0], customText: '' },
        editor: { userId: ACTOR.user.id, displayName: 'Actor', role: 'owner' },
      }),
    ).rejects.toThrow()
  })

  test('clarify.seal —— 逐题封存并在全部答完时把轮标成 answered', async () => {
    const db = harness.db
    const { roundId, originNodeRunId } = await seedClarifyRound(db)
    const ops = operations(db)
    const partial = await ops.clarify.seal({
      originNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['A'],
          customText: '',
        },
      ],
      sealedBy: ACTOR.user.id,
      sealedByRole: 'owner',
    })
    expect(partial).toMatchObject({
      sealedQuestionIds: ['q1'],
      resealedQuestionIds: [],
      roundFullySealed: false,
    })
    const full = await ops.clarify.seal({
      originNodeRunId,
      answers: [
        {
          questionId: 'q2',
          selectedOptionIndices: [1],
          selectedOptionLabels: ['B'],
          customText: '',
        },
      ],
      sealedBy: ACTOR.user.id,
      sealedByRole: 'owner',
      directive: 'continue',
    })
    expect(full.roundFullySealed).toBe(true)
    const rows = await db
      .select({ status: clarifyRounds.status })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, roundId))
    expect(rows[0]?.status).toBe('answered')
    const entries = await db
      .select({ questionId: taskQuestions.questionId, sealedAt: taskQuestions.sealedAt })
      .from(taskQuestions)
      .where(and(eq(taskQuestions.originNodeRunId, originNodeRunId)))
    expect(entries.map((entry) => entry.questionId).sort()).toEqual(['q1', 'q2'])
    expect(entries.every((entry) => entry.sealedAt !== null)).toBe(true)
  })
})

interface ClarifyFixture {
  readonly taskId: string
  readonly roundId: string
  readonly originNodeRunId: string
}

async function seedClarifyRound(db: ProviderNeutralDatabase): Promise<ClarifyFixture> {
  const taskId = await seedTask(db, { status: 'awaiting_human' })
  const askingRunId = `nr_${ulid()}`
  const originNodeRunId = `nr_${ulid()}`
  await db.insert(nodeRuns).values([
    { id: askingRunId, taskId, nodeId: DESIGNER, status: 'done', retryIndex: 0, iteration: 0 },
    {
      id: originNodeRunId,
      taskId,
      nodeId: CLARIFY,
      status: 'awaiting_human',
      retryIndex: 0,
      iteration: 0,
    },
  ])
  const roundId = `cr_${ulid()}`
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: 'self',
    askingNodeId: DESIGNER,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CLARIFY,
    intermediaryNodeRunId: originNodeRunId,
    iteration: 0,
    questionsJson: JSON.stringify([question('q1'), question('q2')]),
    answersJson: '[]',
    directive: 'continue',
    status: 'awaiting_human',
    createdAt: Date.now(),
  })
  return { taskId, roundId, originNodeRunId }
}

function question(id: string) {
  return {
    id,
    title: `${id}-title`,
    kind: 'single' as const,
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}
