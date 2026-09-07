// RFC-359 W7 —— `ReviewRepairParticipant`（RFC-057 R1 修复的协作侧事实面）双引擎对拍。
//
// 这条测试存在的理由：合一前 `sqliteReviewRepairParticipant.ts` /
// `postgresqlReviewRepairParticipant.ts` 是两份逐行相同的实现，而**只有 PG 那份有生产调用方**
// （`task-execution/composition/providerRuntime.ts`）——SQLite 那份的行为从来没有被任何生产路径
// 验证过，两侧漂移了也不会有人发现。合一成一份中立实现之后，用同一段断言在两个引擎上各跑一遍，
// 把「同一份实现在两个引擎上行为相同」变成可防守的量。
//
// 覆盖：inspect（命中 / 不存在 / 三元组任一不匹配 / 输出端口存在性）、
// completeApproved（非 approved 拒绝、幂等 upsert、sourceFilePath 缺失时的兜底内容、事务原子性）、
// unapprove（CAS 只吃 approved、二次调用为 false、跨任务 / 跨 run 不越界）。

import { expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { docVersions, nodeRunOutputs, nodeRuns, tasks, workflows } from '@/db/schema'
import { createReviewRepairParticipant } from '@/modules/collaboration/infrastructure/reviewRepairParticipant'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const id = `t_w7r_${ulid()}`
  const workflowId = `wf_w7r_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: 1,
  })
  return id
}

async function seedReviewRun(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const id = `nr_w7r_${ulid()}`
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'review', status: 'awaiting_review' })
  return id
}

interface DocSeed {
  readonly decision?: 'pending' | 'approved' | 'rejected' | 'iterated' | 'superseded'
  readonly sourceFilePath?: string | null
  readonly versionIndex?: number
  readonly reviewIteration?: number
}

async function seedDocVersion(
  db: ProviderNeutralDatabase,
  taskId: string,
  reviewNodeRunId: string,
  seed: DocSeed = {},
): Promise<string> {
  const id = `dv_w7r_${ulid()}`
  await db.insert(docVersions).values({
    id,
    taskId,
    reviewNodeId: 'review',
    reviewNodeRunId,
    sourceNodeId: 'writer',
    sourcePortName: 'document',
    versionIndex: seed.versionIndex ?? 3,
    reviewIteration: seed.reviewIteration ?? 2,
    bodyPath: `runs/${taskId}/review/review/document/v3.md`,
    sourceFilePath: seed.sourceFilePath === undefined ? 'docs/result.md' : seed.sourceFilePath,
    decision: seed.decision ?? 'approved',
  })
  return id
}

async function outputsOf(
  db: ProviderNeutralDatabase,
  nodeRunId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ portName: nodeRunOutputs.portName, content: nodeRunOutputs.content })
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
  return Object.fromEntries(rows.map(({ portName, content }) => [portName, content]))
}

describeEachProvider('RFC-359 W7 —— 评审修复参与者：inspect', (harness) => {
  test('三元组命中才返回；输出端口的存在性随写入翻转', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const nodeRunId = await seedReviewRun(db, taskId)
    const docVersionId = await seedDocVersion(db, taskId, nodeRunId)
    const repair = createReviewRepairParticipant(db)
    const identity = { taskId, docVersionId, nodeRunId }

    expect(await repair.inspect(identity)).toEqual({
      decision: 'approved',
      versionIndex: 3,
      reviewIteration: 2,
      sourceFilePath: 'docs/result.md',
      hasApprovedDocOutput: false,
      hasApprovalMetaOutput: false,
    })

    // 三元组的每一元单独不匹配都必须回 null——修复入口拿的是用户给的 alert detail。
    expect(await repair.inspect({ ...identity, docVersionId: 'dv_missing' })).toBeNull()
    expect(await repair.inspect({ ...identity, taskId: 'task_other' })).toBeNull()
    expect(await repair.inspect({ ...identity, nodeRunId: 'nr_other' })).toBeNull()

    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId, portName: 'approved_doc', content: 'docs/result.md' })
    expect(await repair.inspect(identity)).toMatchObject({
      hasApprovedDocOutput: true,
      hasApprovalMetaOutput: false,
    })
  })
})

describeEachProvider('RFC-359 W7 —— 评审修复参与者：completeApproved', (harness) => {
  test('只补 approved 的账；两个端口一起 upsert，重跑覆盖同一行', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const nodeRunId = await seedReviewRun(db, taskId)
    const docVersionId = await seedDocVersion(db, taskId, nodeRunId)
    const repair = createReviewRepairParticipant(db)
    const identity = { taskId, docVersionId, nodeRunId }

    expect(await repair.completeApproved({ ...identity, occurredAt: 9 })).toBe(true)
    expect(await outputsOf(db, nodeRunId)).toEqual({
      approved_doc: 'docs/result.md',
      approval_meta: JSON.stringify({
        decision: 'approved',
        decidedAt: 9,
        decidedBy: 'rfc057-repair',
        reviewIteration: 2,
        versionIndex: 3,
      }),
    })
    expect(await repair.inspect(identity)).toMatchObject({
      hasApprovedDocOutput: true,
      hasApprovalMetaOutput: true,
    })

    // 幂等：同一对 (node_run, port) 走 onConflictDoUpdate，重跑只覆盖内容、不再插一行。
    expect(await repair.completeApproved({ ...identity, occurredAt: 11 })).toBe(true)
    const after = await outputsOf(db, nodeRunId)
    expect(Object.keys(after).sort()).toEqual(['approval_meta', 'approved_doc'])
    expect(JSON.parse(after['approval_meta'] ?? '{}')).toMatchObject({ decidedAt: 11 })
  })

  test('文档不是 approved 时拒绝，且一个字节都不写', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const nodeRunId = await seedReviewRun(db, taskId)
    const repair = createReviewRepairParticipant(db)

    const pending = await seedDocVersion(db, taskId, nodeRunId, { decision: 'pending' })
    expect(
      await repair.completeApproved({ taskId, docVersionId: pending, nodeRunId, occurredAt: 9 }),
    ).toBe(false)
    expect(await outputsOf(db, nodeRunId)).toEqual({})

    // 行根本不存在时同样是 false（loadInspection 返回 null）。
    expect(
      await repair.completeApproved({
        taskId,
        docVersionId: 'dv_missing',
        nodeRunId,
        occurredAt: 9,
      }),
    ).toBe(false)
    expect(await outputsOf(db, nodeRunId)).toEqual({})
  })

  test('sourceFilePath 缺失 / 空白时落兜底内容，不写空串', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const repair = createReviewRepairParticipant(db)

    const nullRun = await seedReviewRun(db, taskId)
    const nullDoc = await seedDocVersion(db, taskId, nullRun, { sourceFilePath: null })
    expect(
      await repair.completeApproved({
        taskId,
        docVersionId: nullDoc,
        nodeRunId: nullRun,
        occurredAt: 5,
      }),
    ).toBe(true)
    expect((await outputsOf(db, nullRun))['approved_doc']).toBe(
      `__rfc057_manual_repair__:doc_version=${nullDoc}`,
    )

    const blankRun = await seedReviewRun(db, taskId)
    const blankDoc = await seedDocVersion(db, taskId, blankRun, { sourceFilePath: '   ' })
    expect(
      await repair.completeApproved({
        taskId,
        docVersionId: blankDoc,
        nodeRunId: blankRun,
        occurredAt: 5,
      }),
    ).toBe(true)
    expect((await outputsOf(db, blankRun))['approved_doc']).toBe(
      `__rfc057_manual_repair__:doc_version=${blankDoc}`,
    )
  })
})

describeEachProvider('RFC-359 W7 —— 评审修复参与者：unapprove', (harness) => {
  test('只吃 approved 的 CAS：首次 true、二次 false，判定写回 pending', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const nodeRunId = await seedReviewRun(db, taskId)
    const docVersionId = await seedDocVersion(db, taskId, nodeRunId)
    const repair = createReviewRepairParticipant(db)
    const identity = { taskId, docVersionId, nodeRunId }

    expect(await repair.unapprove(identity)).toBe(true)
    expect(
      (
        await db
          .select({
            decision: docVersions.decision,
            decidedAt: docVersions.decidedAt,
            decidedBy: docVersions.decidedBy,
          })
          .from(docVersions)
          .where(eq(docVersions.id, docVersionId))
      )[0],
    ).toEqual({ decision: 'pending', decidedAt: null, decidedBy: null })

    // 已经是 pending 了，CAS 落空。
    expect(await repair.unapprove(identity)).toBe(false)
    expect(await repair.inspect(identity)).toMatchObject({ decision: 'pending' })
  })

  test('三元组不匹配时不越界改别的行', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const otherTaskId = await seedTask(db)
    const nodeRunId = await seedReviewRun(db, taskId)
    const otherRunId = await seedReviewRun(db, taskId)
    const docVersionId = await seedDocVersion(db, taskId, nodeRunId)
    const repair = createReviewRepairParticipant(db)

    expect(await repair.unapprove({ taskId: otherTaskId, docVersionId, nodeRunId })).toBe(false)
    expect(await repair.unapprove({ taskId, docVersionId, nodeRunId: otherRunId })).toBe(false)
    expect(await repair.unapprove({ taskId, docVersionId: 'dv_missing', nodeRunId })).toBe(false)
    expect(
      (
        await db
          .select({ decision: docVersions.decision })
          .from(docVersions)
          .where(and(eq(docVersions.id, docVersionId), eq(docVersions.taskId, taskId)))
      )[0],
    ).toEqual({ decision: 'approved' })
  })
})
