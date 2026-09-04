// RFC-359 —— 评审决定场景的双引擎夹具（移植自 review-decision-full-asserts.test.ts 的种子）。
// 只用 provider-中立的 drizzle 写入，SQLite 与 PostgreSQL 共用；正文文件落在临时 appHome 下。

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monotonicFactory } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, docVersions, nodeRunOutputs, nodeRuns, tasks, users, workflows } from '@/db/schema'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()

export const DOC = 'doc'
export const REVIEW = 'rev_1'
export const REVIEW_OWNER = 'u1'

export function reviewDefinition(agentName: string): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: DOC, kind: 'agent-single', agentName, promptTemplate: '' } as WorkflowNode,
      { id: REVIEW, kind: 'review' } as unknown as WorkflowNode,
    ],
    edges: [
      {
        id: 'e_review',
        source: { nodeId: DOC, portName: 'docpath' },
        target: { nodeId: REVIEW, portName: '__review_input__' },
      },
    ],
  } as unknown as WorkflowDefinition
}

export interface ReviewRound {
  readonly taskId: string
  readonly agentRunId: string
  readonly reviewRunId: string
  /** 单文档轮：唯一 pending doc_version；多文档轮：按 itemIndex 排序的成员。 */
  readonly docVersionIds: readonly string[]
  readonly appHome: string
  readonly bodies: readonly string[]
  cleanup(): void
}

/** 一个 awaiting_review 的评审轮：上游 agent run done（含输出），评审 run awaiting_review，pending doc_version。 */
export async function seedReviewRound(
  db: ProviderNeutralDatabase,
  opts: { readonly bodies?: readonly string[] } = {},
): Promise<ReviewRound> {
  const bodies = opts.bodies ?? ['# body inline']
  const multi = bodies.length > 1
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc359-review-'))
  const appHome = join(tmp, 'appHome')
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  const taskId = `t_${ulid()}`
  const agentName = `doc-${taskId}`
  // tasks.owner_user_id 在 SQLite 迁移里带 FK → users（schema.ts 无 references，PG 投影没有这条
  // FK——RFC-359 W3-T16b 的又一条实证）；两引擎都插一行决定者，行为才是同一个起点。
  await db
    .insert(users)
    .values({
      id: REVIEW_OWNER,
      username: REVIEW_OWNER,
      displayName: REVIEW_OWNER,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .onConflictDoNothing()
  const definition = reviewDefinition(agentName)
  await db.insert(agents).values({
    id: ulid(),
    name: agentName,
    description: '',
    outputs: JSON.stringify(['docpath']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc359-review',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc359-review',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: tmp,
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
    // 决定者是任务 owner：membership 判定走 tasks.owner_user_id（无需 users 行）。
    ownerUserId: REVIEW_OWNER,
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })
  const agentRunId = ulid()
  await db.insert(nodeRuns).values({
    id: agentRunId,
    taskId,
    nodeId: DOC,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 900,
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: agentRunId,
    portName: 'docpath',
    content: bodies[0]!,
  })
  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: REVIEW,
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: Date.now() - 50,
  })
  const docVersionIds: string[] = []
  for (let index = 0; index < bodies.length; index++) {
    const id = ulid()
    const bodyPath = `doc_versions/${id}.md`
    writeFileSync(join(appHome, bodyPath), bodies[index]!)
    await db.insert(docVersions).values({
      id,
      taskId,
      reviewNodeId: REVIEW,
      reviewNodeRunId: reviewRunId,
      sourceNodeId: DOC,
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath,
      commentsJson: '[]',
      decision: 'pending',
      ...(multi
        ? { itemIndex: index, itemPath: null, selection: 'unselected', selectionStale: false }
        : {}),
      createdAt: Date.now(),
    })
    docVersionIds.push(id)
  }
  return {
    taskId,
    agentRunId,
    reviewRunId,
    docVersionIds,
    appHome,
    bodies,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}
