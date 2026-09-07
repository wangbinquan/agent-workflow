// RFC-359 W6-T25 收尾 —— 剩下的逐行 INSERT 热路径改按批，判据是**语句数**。
//
// 前一批（`rfc359-t25-batch-insert.test.ts`）钉住了设施本身（`insertInBatches` / `lastPerKey` /
// `batchInsertMax` 的边界与回滚）。本文件钉住**调用点**：六条仍在逐行写的热路径改批之后，
// 一次操作发出的 INSERT 语句数由**形状**唯一决定（`ceil(n / batchInsertMax(列数))`），
// 不再随 n 线性增长。
//
// 判据为什么是语句数而不是墙钟：RFC-244 的教训——墙钟测不出真回归（机器闲的时候逐行也快），
// 机器一忙又假红。语句数是形状的函数，两个引擎上都确定。
//
// 六条靶子与它们各自的「n 从哪来」：
//
//   A1 `humanGateOpenParticipant.ts` 的 doc_versions —— n = manifest.documents（agent 输出端口
//      经 splitListItems 切出来的文档数，review 路径**没有** wrapper-fanout 那道 256 闸），
//      而它跑在 `withTaskExecutionSerializable` 里：SQLite 上那是全库独占，N 次往返阻塞的是所有任务。
//   A2 `humanGateOperationJournal.ts` 的 collaboration_gate_artifacts —— 与 A1 **同一个 n**
//      （两者由同一份 documents 派生、长度相等），所以一次 review-open 此前要付 2n 条逐行 INSERT。
//   A3 `legacySqliteTaskQuestions.ts` 的 task_questions —— 唯一挂在 **GET** 上的写放大
//      （看板每次轮询都 lazy-reconcile 一遍）；cross 模式的问题数无界。
//   A4 `eventStore.ts` settleObserver 的 event_subscriptions —— 观测数 × 匹配订阅数，1 Hz。
//   A5 `eventStore.ts` recordObservation 的 event_subscriptions —— 每个入站 webhook 请求跑 2 次。
//      A4/A5 的循环体此前近乎逐字重复，本次收成同一个 helper（`materializeFilteredSubscriptions`）。
//   A6 `customEventSourceStore.ts` 的 event_type_catalog —— 冷路径，1–100 行。
//
// 三条**行为等价性**风险，逐条在这里留了用例：
//
//   R2 同批重复冲突键：`onConflictDoUpdate` 在 PostgreSQL 上不许一条语句改同一行两次，而逐行的
//      语义是「后写赢」⇒ A3 用 `lastPerKey` 压平。`onConflictDoNothing`（A4/A5）不受此限，
//      **首行赢 = 逐行同义**，这里两个引擎上各验一次而不是想当然。
//   R3 插入顺序被隐式依赖：`listTaskQuestions` 的读**没有 ORDER BY**，看板靠插入序显示成 envelope
//      顺序 ⇒ 批量写必须保持 `desired` 数组序。这里直接断言那条 INSERT 的**绑定值**按 envelope 序
//      排列（两个引擎上都确定，不依赖任何一侧的隐式行序）。
//   R5 「INSERT 前先 SELECT」的路径只能降到 n+1：A1 的探测在循环外，是唯一真正 2n→1 的靶子；
//      A4/A5 的回读改成一条 `inArray`，所以是 2n→2。用例按各自的真实条数断言。

import { expect, test } from 'bun:test'
import { asc, eq, getTableColumns } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  collaborationGateArtifacts,
  docVersions,
  eventDeliveries,
  eventSubscriptions,
  eventTypeCatalog,
  nodeRuns,
  taskQuestions,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { CanonicalHumanGateRequest } from '@/modules/collaboration/domain/canonicalGateRequest'
import {
  encodeReviewGateOpenManifest,
  reviewGateProjectionDigest,
  type ReviewGateDocumentProjection,
  type ReviewGateOpenManifest,
} from '@/modules/collaboration/domain/reviewGateOpen'
import { preparedHumanGateRef } from '@/modules/collaboration/domain/humanGateOperation'
import { DatabaseHumanGateOpenParticipantInTx } from '@/modules/collaboration/infrastructure/humanGateOpenParticipant'
import { DatabaseHumanGateOperationJournal } from '@/modules/collaboration/infrastructure/humanGateOperationJournal'
import { reconcileTaskQuestionsForRound } from '@/modules/collaboration/infrastructure/legacySqliteTaskQuestions'
import type { CustomEventSourceDraft } from '@/modules/event-center/domain/customEventSource'
import {
  eventContentDigest,
  eventTypeContentDigest,
  type EventObservation,
  type EventSourceDescriptor,
  type EventTypeDescriptor,
  type MatchedFilteredEventSubscription,
} from '@/modules/event-center/domain/model'
import { createCustomEventSourceStore } from '@/modules/event-center/infrastructure/customEventSourceStore'
import { createEventStore } from '@/modules/event-center/infrastructure/eventStore'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_788_970_000_000
const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

// ─────────────────────────────────────────────────────────────────────────────
// 公共判据：表宽 → 批上限；语句录制 → 某张表的 INSERT 条数
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 表宽必须走 **dialect 无关**的 `getTableColumns`（从 `drizzle-orm` 取，不是 `sqlite-core`）——
 * PostgreSQL 侧 `db/schema.ts` 的导出是投影出来的 PgTable，`sqlite-core` 的 `getTableConfig`
 * 会在它上面抛 TypeError（docs/dev-gotchas.md 有这条实撞记录）。
 */
function columnsOf(table: Parameters<typeof getTableColumns>[0]): number {
  return Object.keys(getTableColumns(table)).length
}

function batchesFor(h: ProviderHarness, table: Parameters<typeof getTableColumns>[0], n: number) {
  return Math.ceil(n / h.capabilities.batchInsertMax(columnsOf(table)))
}

/** 录到的、往某张表写的 INSERT 语句（两个引擎上表名可能带引号，所以不锚定引号）。 */
function insertsInto(
  statements: readonly { readonly sql: string; readonly values: readonly unknown[] }[],
  tableName: string,
) {
  const pattern = new RegExp(`^\\s*insert\\s+into\\s+[^(]*\\b${tableName}\\b`, 'i')
  return statements.filter((statement) => pattern.test(statement.sql))
}

// ─────────────────────────────────────────────────────────────────────────────
// 播种
// ─────────────────────────────────────────────────────────────────────────────

async function seedTask(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: taskId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `wf_${taskId}`,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/rfc359-t25',
    worktreePath: '/tmp/rfc359-t25',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: NOW,
    lifecycleEventRevision: 1,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// A1 / A2 —— review-open 的 doc_versions 与 collaboration_gate_artifacts
// ─────────────────────────────────────────────────────────────────────────────

const journal = new DatabaseHumanGateOperationJournal()

function reviewDocuments(
  taskId: string,
  reviewNodeRunId: string,
  n: number,
): ReviewGateDocumentProjection[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `dv_${reviewNodeRunId}_${i}`,
    taskId,
    reviewNodeId: 'reviewer',
    reviewNodeRunId,
    sourceNodeId: 'writer',
    sourcePortName: 'docs',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: `.agent-workflow/reviews/${taskId}/doc-${i}.md`,
    commentsJson: '[]' as const,
    decision: 'pending' as const,
    decisionReason: null,
    promptSnapshot: null,
    sourceFilePath: `docs/doc-${i}.md`,
    itemIndex: i,
    selection: null,
    itemPath: null,
    selectionStale: null,
    roundGeneration: null,
    createdAt: NOW,
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    artifactKey: `doc:${String(i).padStart(4, '0')}`,
    bodySha256: sha256Hex(`body-${i}`),
    byteSize: 10 + i,
  }))
}

function reviewManifest(taskId: string, n: number): ReviewGateOpenManifest {
  const reviewNodeRunId = `nr_review_${taskId}`
  const node = {
    mode: 'mint' as const,
    id: reviewNodeRunId,
    taskId,
    nodeId: 'reviewer',
    containerRunId: null,
    iteration: 0,
    reviewIteration: 0,
    previousConsumedUpstreamRunsJson: null,
    consumedUpstreamRunsJson: '{}',
    startedAt: NOW,
  }
  const documents = reviewDocuments(taskId, reviewNodeRunId, n)
  const sourceSnapshotDigest = 'a'.repeat(64)
  return {
    schemaVersion: 1,
    kind: 'review-open',
    gateRef: `review:reviewer:${taskId}`,
    sourceSnapshotDigest,
    nodeProjectionDigest: reviewGateProjectionDigest({
      sourceSnapshotDigest,
      node,
      supersedePendingDocumentIds: [],
      documents,
    }),
    committedEventRef: `evt_${taskId}`,
    node,
    supersedePendingDocumentIds: [],
    documents,
  }
}

function openRequest(taskId: string, manifest: ReviewGateOpenManifest): CanonicalHumanGateRequest {
  return {
    schemaVersion: 1,
    taskId,
    gateKind: 'review',
    operationKind: 'open',
    gateRef: manifest.gateRef,
    actorUserId: null,
    expectedTaskRevision: 1,
    expectedGateRevision: 0,
    payload: { kind: 'open', manifestDigest: manifest.nodeProjectionDigest },
  }
}

/** 把一个 review-open 门开到 `prepared`：begin → declareArtifacts → 全部 staged → markPrepared。 */
async function prepareReviewOperation(
  tx: DatabaseTransaction,
  operationId: string,
  taskId: string,
  manifest: ReviewGateOpenManifest,
) {
  await journal.beginTx({
    tx,
    operationId,
    request: openRequest(taskId, manifest),
    idempotencyKey: `open:${operationId}`,
    now: NOW,
  })
  await journal.declareArtifactsTx({
    tx,
    operationId,
    artifacts: manifest.documents.map((document) => ({
      artifactKey: document.artifactKey,
      stagedPath: `.agent-workflow/staging/${operationId}/${document.artifactKey}.md`,
      finalPath: document.bodyPath,
      sha256: document.bodySha256,
      byteSize: document.byteSize,
    })),
    now: NOW + 1,
  })
  for (const document of manifest.documents) {
    await journal.transitionArtifactTx({
      tx,
      operationId,
      artifactKey: document.artifactKey,
      from: 'declared',
      to: 'staged',
      receiptJson: '{"written":true}',
      now: NOW + 2,
    })
  }
  return await journal.markPreparedTx({
    tx,
    operationId,
    expectedClaimEpoch: 1,
    manifestJson: encodeReviewGateOpenManifest(manifest),
    now: NOW + 3,
  })
}

/** 生产的 mint 参与者由 task-execution 供给；这里只需要它真的把 node_run 行落下去。 */
function mintParticipant(tx: DatabaseTransaction) {
  return {
    async mint(input: {
      readonly id: string
      readonly taskId: string
      readonly nodeId: string
      readonly status: 'awaiting_review' | 'awaiting_human'
      readonly iteration: number
      readonly overrides?: Readonly<{ reviewIteration?: number; startedAt?: number | null }>
    }): Promise<string> {
      await tx
        .insert(nodeRuns)
        .values({
          id: input.id,
          taskId: input.taskId,
          nodeId: input.nodeId,
          status: input.status,
          iteration: input.iteration,
          reviewIteration: input.overrides?.reviewIteration ?? 0,
          startedAt: input.overrides?.startedAt ?? NOW,
        })
        .run()
      return input.id
    },
  }
}

const lifecycleParticipant = {
  async set() {
    throw new Error('mint 模式不应该走到停靠 CAS')
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// A4 / A5 —— event-center 的路由订阅物化
// ─────────────────────────────────────────────────────────────────────────────

function eventFixtures(tag: string) {
  const source: EventSourceDescriptor = {
    schemaVersion: 1,
    sourceRef: { id: `t25.source-${tag}`, revision: 1 },
    ownerTypeId: 't25.owner',
    displayName: { 'zh-CN': '批量写测试源', 'en-US': 'T25 source' },
    description: { 'zh-CN': '批量写测试', 'en-US': 'T25' },
    observationMode: 'active',
    observerProgramRef: null,
    pollIntervalMs: 1_000,
    batchSize: 10,
  }
  const eventType: EventTypeDescriptor = {
    schemaVersion: 1,
    eventTypeRef: { id: `t25.event-${tag}.changed`, revision: 1 },
    sourceRef: source.sourceRef,
    ownerTypeId: 't25.owner',
    subjectTypeId: 't25.subject',
    payloadSchemaId: 't25.payload',
    displayName: { 'zh-CN': '发生变更', 'en-US': 'Changed' },
    description: { 'zh-CN': '批量写测试', 'en-US': 'T25' },
    deliveryClass: 't25.delivery',
    triggerParameters: null,
  }
  const observation: EventObservation = {
    sourceRef: source.sourceRef,
    eventTypeRef: eventType.eventTypeRef,
    subject: { typeId: 't25.subject', subjectRef: `subject-${tag}` },
    occurredAt: 100,
    dedupeKey: `dedupe-${tag}`,
    summary: 't25 changed',
    payloadArtifactRef: null,
    routingFacts: null,
    triggerParameters: null,
  }
  return { source, eventType, observation }
}

function routingMatches(
  tag: string,
  source: EventSourceDescriptor,
  eventType: EventTypeDescriptor,
  n: number,
  /** 让同一批里出现重复 `materializedSubscriptionId`（R2 的 DO NOTHING 分支）。 */
  duplicateIds = false,
): MatchedFilteredEventSubscription[] {
  return Array.from({ length: n }, (_, i) => ({
    definition: {
      id: `rule_${tag}_${i}`,
      definitionRevision: `rev-${i}`,
      sourceRef: source.sourceRef,
      eventTypeRefs: [eventType.eventTypeRef],
      subjectTypeId: 't25.subject',
      subscriber: { kind: 'automation' as const, subscriberRef: `automation-${tag}-${i}` },
      displayName: { 'zh-CN': `规则 ${i}`, 'en-US': `rule ${i}` },
      selector: { kind: 'all', config: true },
      state: 'active' as const,
      createdAt: 1,
      updatedAt: 2,
    },
    eventTypeRef: eventType.eventTypeRef,
    materializedSubscriptionId: duplicateIds
      ? `msub_${tag}_${Math.floor(i / 2)}`
      : `msub_${tag}_${i}`,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// 用例
// ─────────────────────────────────────────────────────────────────────────────

describeEachProvider('RFC-359 W6-T25 收尾 —— 逐行 INSERT 热路径的语句数', (h) => {
  test('A2 —— review-open 的产物声明：n 条产物 ⇒ ceil(n/max) 条 INSERT，落库逐字段不变', async () => {
    const taskId = `t_t25_a2_${ulid()}`
    await seedTask(h.db, taskId)
    const manifest = reviewManifest(taskId, 9)
    const operationId = `op_${taskId}`

    const rec = h.recordStatements()
    await h.session.transaction(async (tx) => {
      await journal.beginTx({
        tx,
        operationId,
        request: openRequest(taskId, manifest),
        idempotencyKey: `open:${operationId}`,
        now: NOW,
      })
      await journal.declareArtifactsTx({
        tx,
        operationId,
        artifacts: manifest.documents.map((document) => ({
          artifactKey: document.artifactKey,
          stagedPath: `.agent-workflow/staging/${operationId}/${document.artifactKey}.md`,
          finalPath: document.bodyPath,
          sha256: document.bodySha256,
          byteSize: document.byteSize,
        })),
        now: NOW + 1,
      })
    })
    const inserts = insertsInto(rec.statements, 'collaboration_gate_artifacts')
    rec.stop()
    expect(inserts.length).toBe(batchesFor(h, collaborationGateArtifacts, 9))

    const stored = await h.db
      .select({
        artifactKey: collaborationGateArtifacts.artifactKey,
        artifactKind: collaborationGateArtifacts.artifactKind,
        finalPath: collaborationGateArtifacts.finalPath,
        sha256: collaborationGateArtifacts.sha256,
        byteSize: collaborationGateArtifacts.byteSize,
        state: collaborationGateArtifacts.state,
        receiptJson: collaborationGateArtifacts.receiptJson,
        updatedAt: collaborationGateArtifacts.updatedAt,
      })
      .from(collaborationGateArtifacts)
      .where(eq(collaborationGateArtifacts.operationId, operationId))
      .orderBy(asc(collaborationGateArtifacts.artifactKey))
    expect(stored.map((row) => ({ ...row }))).toEqual(
      manifest.documents.map((document) => ({
        artifactKey: document.artifactKey,
        artifactKind: 'review-doc',
        finalPath: document.bodyPath,
        sha256: document.bodySha256,
        byteSize: document.byteSize,
        state: 'declared',
        receiptJson: null,
        updatedAt: NOW + 1,
      })),
    )
  }, 120_000)

  test('A2 —— 同一批里重复 artifactKey 仍然大声拒绝（去重不许把校验吃掉）', async () => {
    const taskId = `t_t25_a2dup_${ulid()}`
    await seedTask(h.db, taskId)
    const manifest = reviewManifest(taskId, 2)
    const operationId = `op_${taskId}`
    await expect(
      h.session.transaction(async (tx) => {
        await journal.beginTx({
          tx,
          operationId,
          request: openRequest(taskId, manifest),
          idempotencyKey: `open:${operationId}`,
          now: NOW,
        })
        await journal.declareArtifactsTx({
          tx,
          operationId,
          artifacts: [0, 0].map((index) => ({
            artifactKey: manifest.documents[index]!.artifactKey,
            stagedPath: `.agent-workflow/staging/${operationId}/dup.md`,
            finalPath: `${manifest.documents[index]!.bodyPath}.${String(Math.random())}`,
            sha256: manifest.documents[index]!.bodySha256,
            byteSize: 1,
          })),
          now: NOW + 1,
        })
      }),
    ).rejects.toThrow('artifact declaration is invalid')
    expect(
      await h.db
        .select({ artifactKey: collaborationGateArtifacts.artifactKey })
        .from(collaborationGateArtifacts)
        .where(eq(collaborationGateArtifacts.operationId, operationId)),
    ).toEqual([])
  }, 120_000)

  test('A1 —— review-open 的文档投影：n 篇文档 ⇒ 1 条 INSERT（探测在循环外，唯一真正 2n→1 的靶子）', async () => {
    const taskId = `t_t25_a1_${ulid()}`
    await seedTask(h.db, taskId)
    const n = 11
    const manifest = reviewManifest(taskId, n)
    const operationId = `op_${taskId}`
    const prepared = await h.session.transaction((tx) =>
      prepareReviewOperation(tx, operationId, taskId, manifest),
    )

    const rec = h.recordStatements()
    await h.session.transaction(async (tx) => {
      await new DatabaseHumanGateOpenParticipantInTx(
        tx,
        journal,
        mintParticipant(tx),
        lifecycleParticipant,
      ).consumePreparedGateTx({
        prepared: preparedHumanGateRef(prepared),
        taskRevision: 1,
        now: NOW + 10,
      })
    })
    const inserts = insertsInto(rec.statements, 'doc_versions')
    rec.stop()
    expect(inserts.length, `${n} 篇文档应当一条 INSERT 落定`).toBe(batchesFor(h, docVersions, n))

    const stored = await h.db
      .select({
        id: docVersions.id,
        sourceFilePath: docVersions.sourceFilePath,
        itemIndex: docVersions.itemIndex,
        bodyPath: docVersions.bodyPath,
        decision: docVersions.decision,
        createdAt: docVersions.createdAt,
      })
      .from(docVersions)
      .where(eq(docVersions.taskId, taskId))
      .orderBy(asc(docVersions.itemIndex))
    expect(stored.map((row) => ({ ...row }))).toEqual(
      manifest.documents.map((document) => ({
        id: document.id,
        sourceFilePath: document.sourceFilePath,
        itemIndex: document.itemIndex,
        bodyPath: document.bodyPath,
        decision: 'pending',
        createdAt: document.createdAt,
      })),
    )
  }, 180_000)

  test('A3 —— 反问条目 reconcile：一轮 n 条问题 ⇒ ceil(n/max) 条 INSERT，且**保持 envelope 顺序**', async () => {
    const taskId = `t_t25_a3_${ulid()}`
    await seedTask(h.db, taskId)
    const askingRunId = `nr_ask_${taskId}`
    const intermediaryRunId = `nr_mid_${taskId}`
    for (const id of [askingRunId, intermediaryRunId]) {
      await h.db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: id === askingRunId ? 'writer' : 'clarify',
        status: 'running',
      })
    }
    const n = 12
    const questions = Array.from({ length: n }, (_, i) => ({
      id: `q-${String(i).padStart(3, '0')}`,
      title: `question ${i}`,
    }))
    const roundId = `cr_${taskId}`
    await h.db.insert(clarifyRounds).values({
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: 'writer',
      askingNodeRunId: askingRunId,
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: intermediaryRunId,
      iteration: 0,
      loopIter: 0,
      questionsJson: JSON.stringify(questions),
      status: 'awaiting_human',
      createdAt: NOW,
    })
    const round = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).limit(1)
    )[0]!

    const rec = h.recordStatements()
    await reconcileTaskQuestionsForRound(h.db, round)
    const inserts = insertsInto(rec.statements, 'task_questions')
    rec.stop()
    expect(inserts.length).toBe(batchesFor(h, taskQuestions, n))

    // R3：看板的读没有 ORDER BY，靠插入序显示成 envelope 顺序 ⇒ 那条 INSERT 的绑定值
    // 必须按 envelope 序排列。这条判据两个引擎上都确定，不依赖任何一侧的隐式行序。
    const bound = inserts.flatMap((statement) => statement.values)
    const titlePositions = questions.map((question) => bound.indexOf(question.title))
    expect(titlePositions.some((position) => position < 0)).toBe(false)
    expect(titlePositions).toEqual([...titlePositions].sort((a, b) => a - b))

    const stored = await h.db
      .select({ questionId: taskQuestions.questionId, questionTitle: taskQuestions.questionTitle })
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, taskId))
      .orderBy(asc(taskQuestions.questionId))
    expect(stored.map((row) => row.questionId)).toEqual(questions.map((question) => question.id))
    expect(stored.map((row) => row.questionTitle)).toEqual(
      questions.map((question) => question.title),
    )
  }, 180_000)

  test('A3 —— 幂等重跑（全部走 upsert 分支）仍是 ceil(n/max) 条，且只刷新图派生快照', async () => {
    const taskId = `t_t25_a3b_${ulid()}`
    await seedTask(h.db, taskId)
    const askingRunId = `nr_ask_${taskId}`
    const intermediaryRunId = `nr_mid_${taskId}`
    for (const id of [askingRunId, intermediaryRunId]) {
      await h.db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: id === askingRunId ? 'writer' : 'clarify',
        status: 'running',
      })
    }
    const n = 6
    const roundId = `cr_${taskId}`
    const questions = Array.from({ length: n }, (_, i) => ({ id: `q-${i}`, title: `first ${i}` }))
    await h.db.insert(clarifyRounds).values({
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: 'writer',
      askingNodeRunId: askingRunId,
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: intermediaryRunId,
      iteration: 0,
      loopIter: 0,
      questionsJson: JSON.stringify(questions),
      status: 'awaiting_human',
      createdAt: NOW,
    })
    const first = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).limit(1)
    )[0]!
    await reconcileTaskQuestionsForRound(h.db, first)
    const ids = new Map(
      (
        await h.db
          .select({ id: taskQuestions.id, questionId: taskQuestions.questionId })
          .from(taskQuestions)
          .where(eq(taskQuestions.taskId, taskId))
      ).map((row) => [row.questionId, row.id]),
    )

    // 标题改了（agent 重发同一批问题、文案微调）⇒ 第二次 reconcile 全部走冲突分支。
    await h.db
      .update(clarifyRounds)
      .set({
        questionsJson: JSON.stringify(
          questions.map((question) => ({ ...question, title: `second ${question.id}` })),
        ),
      })
      .where(eq(clarifyRounds.id, roundId))
    const second = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).limit(1)
    )[0]!

    const rec = h.recordStatements()
    await reconcileTaskQuestionsForRound(h.db, second)
    const inserts = insertsInto(rec.statements, 'task_questions')
    rec.stop()
    expect(inserts.length).toBe(batchesFor(h, taskQuestions, n))

    const stored = await h.db
      .select({
        id: taskQuestions.id,
        questionId: taskQuestions.questionId,
        questionTitle: taskQuestions.questionTitle,
      })
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, taskId))
      .orderBy(asc(taskQuestions.questionId))
    expect(stored.length).toBe(n)
    // 每一行更新成**自己那行**的新标题（`excluded.*`，不是批里第一行的字面量），行身份不变。
    for (const row of stored) {
      expect(row.questionTitle).toBe(`second ${row.questionId}`)
      expect(row.id).toBe(ids.get(row.questionId) ?? '<missing>')
    }
  }, 180_000)

  test('A3 —— R2 同批重复冲突键：按「后写覆盖先写」压平，PostgreSQL 上不许抛', async () => {
    const taskId = `t_t25_a3dup_${ulid()}`
    await seedTask(h.db, taskId)
    const askingRunId = `nr_ask_${taskId}`
    const intermediaryRunId = `nr_mid_${taskId}`
    for (const id of [askingRunId, intermediaryRunId]) {
      await h.db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: id === askingRunId ? 'writer' : 'clarify',
        status: 'running',
      })
    }
    const roundId = `cr_${taskId}`
    await h.db.insert(clarifyRounds).values({
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: 'writer',
      askingNodeRunId: askingRunId,
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: intermediaryRunId,
      iteration: 0,
      loopIter: 0,
      // agent 输出里同一个问题 id 出现两次：逐行写时后写覆盖先写。
      questionsJson: JSON.stringify([
        { id: 'q-a', title: 'first a' },
        { id: 'q-b', title: 'only b' },
        { id: 'q-a', title: 'second a' },
      ]),
      status: 'awaiting_human',
      createdAt: NOW,
    })
    const round = (
      await h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).limit(1)
    )[0]!
    await reconcileTaskQuestionsForRound(h.db, round)

    const stored = await h.db
      .select({ questionId: taskQuestions.questionId, questionTitle: taskQuestions.questionTitle })
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, taskId))
      .orderBy(asc(taskQuestions.questionId))
    expect(stored.map((row) => ({ ...row }))).toEqual([
      { questionId: 'q-a', questionTitle: 'second a' },
      { questionId: 'q-b', questionTitle: 'only b' },
    ])
  }, 180_000)

  test('A5 —— recordObservation 物化路由订阅：n 条匹配 ⇒ 1 条 INSERT + 1 条回读（2n→2）', async () => {
    const tag = ulid().toLowerCase()
    const store = createEventStore(h.db)
    const { source, eventType, observation } = eventFixtures(tag)
    await store.registerSource(source, eventContentDigest(source), 1)
    await store.registerEventType(eventType, eventTypeContentDigest(eventType), 1)
    const n = 7
    const matches = routingMatches(tag, source, eventType, n)

    const rec = h.recordStatements()
    const receipt = await store.recordObservation({
      eventId: `event_${tag}`,
      observation,
      eventType,
      observedAt: 100,
      nextId: (() => {
        let seq = 0
        return () => `delivery_${tag}_${(seq += 1)}`
      })(),
      routingSubscriptions: matches,
      triggerContext: null,
    })
    const inserts = insertsInto(rec.statements, 'event_subscriptions')
    const reads = rec.statements.filter((statement) =>
      /^\s*select\b[\s\S]*\bfrom\b[^(]*\bevent_subscriptions\b/i.test(statement.sql),
    )
    rec.stop()
    expect(inserts.length).toBe(batchesFor(h, eventSubscriptions, n))
    // 精确订阅一条 + 物化订阅回读一条；逐行时是 1 + n。
    expect(reads.length).toBe(2)
    expect(receipt.deliveryCount).toBe(n)
    expect(receipt.deliveryIds).toEqual(
      Array.from({ length: n }, (_, i) => `delivery_${tag}_${i + 1}`),
    )

    const stored = await h.db
      .select({ id: eventSubscriptions.id, originRef: eventSubscriptions.originRef })
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.mode, 'filtered'))
      .orderBy(asc(eventSubscriptions.id))
    expect(stored.map((row) => row.id)).toEqual(
      matches.map((match) => match.materializedSubscriptionId),
    )
    // 每行拿的是**自己那条**规则的身份（不是批里第一条的字面量）。
    expect(stored.map((row) => row.originRef)).toEqual(matches.map((match) => match.definition.id))
    // 物化订阅的**回填顺序**是落库结果的一部分：投递 id 按订阅顺序逐个铸造，所以
    // delivery_N ↔ 第 N 条匹配。回读改成一条 `inArray` 之后，行序由引擎决定，
    // 必须按 match 顺序重排——这条断言就是那次重排的预言。
    expect(
      (
        await h.db
          .select({ id: eventDeliveries.id, subscriptionId: eventDeliveries.subscriptionId })
          .from(eventDeliveries)
          .where(eq(eventDeliveries.eventId, `event_${tag}`))
          .orderBy(asc(eventDeliveries.id))
      )
        .filter((row) => row.subscriptionId.startsWith('msub_'))
        .map((row) => ({ ...row })),
    ).toEqual(
      matches.map((match, i) => ({
        id: `delivery_${tag}_${i + 1}`,
        subscriptionId: match.materializedSubscriptionId,
      })),
    )
  }, 180_000)

  // R2 的另一半，**实测更正**：`onConflictDoNothing` 的批量写本身在两个引擎上都不抛（首行赢＝逐行
  // 同义，PG 的「同一行不能改两次」只管 DO UPDATE）。但同批重复的 materializedSubscriptionId 在
  // **改批之前就已经**是一条死路：物化订阅是**按 match 逐条回填**的（重复 id ⇒ 同一条订阅行进两次），
  // 于是投递扇出撞上 `event_deliveries_event_subscription_unique`。这条用例把「改批没有改变这个
  // 收场」钉住——把重复压平（比如给回填加一次 dedupe）会让它由抛变成静默少派一条投递。
  test('A5 —— R2 的另一半：DO NOTHING 的批量写不抛；同批重复 id 仍在投递扇出上撞唯一键（与逐行同）', async () => {
    const tag = ulid().toLowerCase()
    const store = createEventStore(h.db)
    const { source, eventType, observation } = eventFixtures(tag)
    await store.registerSource(source, eventContentDigest(source), 1)
    await store.registerEventType(eventType, eventTypeContentDigest(eventType), 1)
    const matches = routingMatches(tag, source, eventType, 4, true)

    const rec = h.recordStatements()
    const failure = await store
      .recordObservation({
        eventId: `event_${tag}`,
        observation,
        eventType,
        observedAt: 100,
        nextId: (() => {
          let seq = 0
          return () => `delivery_${tag}_${(seq += 1)}`
        })(),
        routingSubscriptions: matches,
        triggerContext: null,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    const inserts = insertsInto(rec.statements, 'event_subscriptions')
    rec.stop()

    expect(failure, '重复 id 的投递扇出应当撞唯一键（改批之前就是这个收场）').toBeDefined()
    expect(h.capabilities.classifyError(failure)).toBe('unique-violation')
    expect(h.capabilities.uniqueViolationTarget(failure) ?? '').toMatch(/event_deliveries/)
    // 关键：抛点在**投递**上，不在订阅的批量 upsert 上——那一条语句发出去了、也没报冲突。
    expect(inserts.length).toBe(batchesFor(h, eventSubscriptions, 4))
    // 整笔回滚：一条订阅行都不该留下。
    expect(
      await h.db
        .select({ id: eventSubscriptions.id })
        .from(eventSubscriptions)
        .where(eq(eventSubscriptions.mode, 'filtered')),
    ).toEqual([])
  }, 180_000)

  test('A4 —— settleObserver 物化路由订阅：n 条匹配 ⇒ 1 条 INSERT', async () => {
    const tag = ulid().toLowerCase()
    const store = createEventStore(h.db)
    const { source, eventType, observation } = eventFixtures(tag)
    await store.registerSource(source, eventContentDigest(source), 1)
    await store.registerEventType(eventType, eventTypeContentDigest(eventType), 1)
    await store.subscribe({
      id: `sub_${tag}`,
      eventType,
      source,
      subject: observation.subject,
      subscriber: { kind: 'automation', subscriberRef: `automation-${tag}` },
      identityKey: `identity-${tag}`,
      replayLatest: false,
      now: 2,
    })
    const run = await store.claimDueObserver({
      now: 10,
      leaseOwner: 'observer-1',
      leaseMs: 10_000,
      runId: `run_${tag}`,
    })
    if (run === null) throw new Error('expected a due observer run')
    const n = 5
    const matches = routingMatches(tag, source, eventType, n)

    const rec = h.recordStatements()
    const outcome = await store.settleObserver({
      run,
      now: 12,
      cursorJson: '{"page":2}',
      observations: [
        {
          eventId: `event_${tag}`,
          observation,
          eventType,
          routingSubscriptions: matches,
          triggerContext: null,
        },
      ],
      nextId: (() => {
        let seq = 0
        return () => `delivery_${tag}_${(seq += 1)}`
      })(),
      errorCode: null,
      errorDetail: null,
    })
    const inserts = insertsInto(rec.statements, 'event_subscriptions')
    rec.stop()
    expect(outcome).toBe('completed')
    expect(inserts.length).toBe(batchesFor(h, eventSubscriptions, n))
    const stored = await h.db
      .select({ id: eventSubscriptions.id, originRef: eventSubscriptions.originRef })
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.mode, 'filtered'))
      .orderBy(asc(eventSubscriptions.id))
    expect(stored.map((row) => row.id)).toEqual(
      matches.map((match) => match.materializedSubscriptionId),
    )
    expect(stored.map((row) => row.originRef)).toEqual(matches.map((match) => match.definition.id))
    // 精确订阅先派（拿 delivery_1），物化订阅按**匹配顺序**依次拿 delivery_2…delivery_{n+1}。
    expect(
      (
        await h.db
          .select({ id: eventDeliveries.id, subscriptionId: eventDeliveries.subscriptionId })
          .from(eventDeliveries)
          .where(eq(eventDeliveries.eventId, `event_${tag}`))
          .orderBy(asc(eventDeliveries.id))
      ).map((row) => ({ ...row })),
    ).toEqual([
      { id: `delivery_${tag}_1`, subscriptionId: `sub_${tag}` },
      ...matches.map((match, i) => ({
        id: `delivery_${tag}_${i + 2}`,
        subscriptionId: match.materializedSubscriptionId,
      })),
    ])
    // 该订阅者自己那条精确订阅仍只有一条待投递。
    expect(
      (
        await store.listPendingDeliveries(
          { kind: 'automation', subscriberRef: `automation-${tag}` },
          10,
        )
      ).length,
    ).toBe(1)
  }, 180_000)

  test('A6 —— 自定义事件源发布：n 个事件类型 ⇒ ceil(n/max) 条 INSERT', async () => {
    const ownerId = `u_t25_${ulid()}`
    await h.db.insert(users).values({
      id: ownerId,
      username: ownerId,
      displayName: ownerId,
      role: 'user',
      passwordHash: null,
      createdAt: NOW,
      updatedAt: NOW,
    })
    const sources = createCustomEventSourceStore(h.db)
    const id = `src_${ulid().toLowerCase()}`
    const n = 9
    const draft: CustomEventSourceDraft = {
      schemaVersion: 1,
      displayName: { 'zh-CN': '自建源', 'en-US': 'Custom' },
      description: { 'zh-CN': '批量写测试', 'en-US': 'T25' },
      pollIntervalMs: 60_000,
      batchSize: 10,
      ingestionMode: 'occurrence',
      program: { language: 'bash', source: 'echo hi', timeoutMs: 5_000 },
      eventTypes: Array.from({ length: n }, (_, i) => ({
        eventKey: `ping${i}`,
        subjectTypeId: 'repo',
        payloadSchemaId: 'ping.v1',
        displayName: { 'zh-CN': `ping ${i}`, 'en-US': `ping ${i}` },
        description: { 'zh-CN': 'ping 事件', 'en-US': 'ping event' },
        deliveryClass: 'ordinary',
        triggerParameters: null,
      })),
      fixture: { subjects: [], cursorJson: null },
    }
    await sources.create({ id, draft, ownerUserId: ownerId, now: 1 })

    const source = {
      schemaVersion: 1,
      sourceRef: { id, revision: 1 },
      ownerTypeId: 'custom',
      displayName: draft.displayName,
      description: draft.description,
      observationMode: 'active',
      observerProgramRef: null,
    } as unknown as EventSourceDescriptor
    const eventTypes = Array.from(
      { length: n },
      (_, i) =>
        ({
          eventTypeRef: { id: `${id}.ping${i}`, revision: 1 },
          sourceRef: { id, revision: 1 },
        }) as unknown as EventTypeDescriptor,
    )

    const rec = h.recordStatements()
    await sources.publish({
      id,
      revision: 1,
      draft,
      digest: 'd1',
      validationReceipt: {
        schemaVersion: 1,
        draftDigest: 'd1',
        validatedAt: 3,
        observationCount: 1,
        stdoutDigest: 's1',
      },
      source,
      eventTypes,
      actorUserId: ownerId,
      now: 4,
    })
    const inserts = insertsInto(rec.statements, 'event_type_catalog')
    rec.stop()
    expect(inserts.length).toBe(batchesFor(h, eventTypeCatalog, n))
    const stored = await h.db
      .select({ eventTypeId: eventTypeCatalog.eventTypeId })
      .from(eventTypeCatalog)
      .where(eq(eventTypeCatalog.sourceId, id))
      .orderBy(asc(eventTypeCatalog.eventTypeId))
    expect(stored.map((row) => row.eventTypeId)).toEqual(
      [...eventTypes].map((type) => type.eventTypeRef.id).sort(),
    )
  }, 180_000)
})
