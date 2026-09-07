// RFC-359 W7 —— RFC-057 R1 修复的协作侧事实面（文档判定 + 两个审批输出端口）：
// 一份实现，两个 provider 共用。合一前的 `sqliteReviewRepairParticipant.ts` /
// `postgresqlReviewRepairParticipant.ts` 除「同步管道 vs 异步管道」外**逐行相同**——同一组
// where 子句、同一段 `approval_meta` JSON、同一对 upsert target。
//
// # 事务包裹：读改写包，单语句 CAS 不包（合一前两侧各包了一半，且方向相反）
//
// 合一前 `unapprove` 在 SQLite 侧包了 `dbTxSync`、PG 侧是裸 UPDATE；隔壁
// `clarifyRepairParticipant` 的 `reopen` 恰好反过来（PG 包、SQLite 裸）。一个端口的两侧对同一
// 类语句给出相反的包裹选择，说明这些包裹都是随手加的、没有语义依据。这里按语义重新裁一次：
//
//   · `completeApproved` **包事务**：它是「读判定 + 写两个端口」的读改写序列，中途失败必须整笔
//     回滚，否则会留下只写了 `approved_doc`、没写 `approval_meta` 的半截状态。
//   · `unapprove` **不包**：它是单条带 `WHERE decision='approved'` 的 CAS UPDATE。单语句在两个
//     引擎上本来就是原子的——SQLite 的 autocommit 给每条语句自带一笔事务；PG 客户端的
//     `withWriteFence`（`platform/persistence/postgresqlDatabaseClient.ts:136-163`）把每一条
//     非事务写都放到独占连接上的 BEGIN / …UPDATE… / COMMIT 里。再显式包一层只多一次写者租约
//     和一对 BEGIN/COMMIT 往返，CAS 的判定结果一模一样。
//
// # 抽象层错位（本刀只记录，不动手）
//
// `ReviewRepairParticipant` 这个端口**只有 PG 在消费**（`task-execution/composition/providerRuntime.ts`
// 装配进 `postgresqlTaskRouteRepairOperations`）。SQLite 侧的 R1 修复能力根本不走这个端口，而在
// `platform/persistence/sqlite/taskLifecycleRepair/options-R1.ts`（经 `taskLifecycleRepair.ts` 注册），
// 且比 participant **更全**：多一层 preflight 复检、节点状态 CAS（`setNodeRunStatus` 走 allowTerminal）、
// 任务级评审互斥锁（`withTaskReviewMutationLock`）、以及 before/after 审计快照。
// 也就是说合一之前，「SQLite 的 R1 修复」有两份实现，其中一份（本文件的前身）生产零调用方。
// 合一只消掉了这份零调用方的重复，**没有**消掉错位本身：下一步应让 `options-R1.ts` 改为消费本端口，
// 否则 SQLite 侧会永远保留第二份实现。

import { and, eq } from 'drizzle-orm'

import { docVersions, nodeRunOutputs } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type {
  ReviewRepairInspection,
  ReviewRepairParticipant,
} from '../application/ports/reviewRepairParticipant'

type ReviewIdentity = Parameters<ReviewRepairParticipant['inspect']>[0]

async function loadInspection(
  db: ProviderNeutralDatabase,
  input: ReviewIdentity,
): Promise<ReviewRepairInspection | null> {
  const row = (
    await db
      .select({
        decision: docVersions.decision,
        versionIndex: docVersions.versionIndex,
        reviewIteration: docVersions.reviewIteration,
        sourceFilePath: docVersions.sourceFilePath,
      })
      .from(docVersions)
      .where(
        and(
          eq(docVersions.id, input.docVersionId),
          eq(docVersions.taskId, input.taskId),
          eq(docVersions.reviewNodeRunId, input.nodeRunId),
        ),
      )
      .limit(1)
  )[0]
  if (row === undefined) return null
  const outputs = await db
    .select({ portName: nodeRunOutputs.portName })
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, input.nodeRunId))
  return {
    ...row,
    hasApprovedDocOutput: outputs.some(({ portName }) => portName === 'approved_doc'),
    hasApprovalMetaOutput: outputs.some(({ portName }) => portName === 'approval_meta'),
  }
}

function approvedDocContent(input: ReviewIdentity, sourceFilePath: string | null): string {
  return sourceFilePath !== null && sourceFilePath.trim().length > 0
    ? sourceFilePath
    : `__rfc057_manual_repair__:doc_version=${input.docVersionId}`
}

export function createReviewRepairParticipant(
  db: ProviderNeutralDatabase,
): ReviewRepairParticipant {
  return Object.freeze({
    async inspect(input: Parameters<ReviewRepairParticipant['inspect']>[0]) {
      return await loadInspection(db, input)
    },
    async completeApproved(input: Parameters<ReviewRepairParticipant['completeApproved']>[0]) {
      return await databaseSessionFor(db).transaction(async (transaction) => {
        const state = await loadInspection(transaction, input)
        if (state === null || state.decision !== 'approved') return false
        const content = approvedDocContent(input, state.sourceFilePath)
        const metadata = JSON.stringify({
          decision: 'approved',
          decidedAt: input.occurredAt,
          decidedBy: 'rfc057-repair',
          reviewIteration: state.reviewIteration,
          versionIndex: state.versionIndex,
        })
        await transaction
          .insert(nodeRunOutputs)
          .values({ nodeRunId: input.nodeRunId, portName: 'approved_doc', content })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content },
          })
        await transaction
          .insert(nodeRunOutputs)
          .values({ nodeRunId: input.nodeRunId, portName: 'approval_meta', content: metadata })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content: metadata },
          })
        return true
      })
    },
    async unapprove(input: Parameters<ReviewRepairParticipant['unapprove']>[0]) {
      const changed = await db
        .update(docVersions)
        .set({ decision: 'pending', decidedAt: null, decidedBy: null })
        .where(
          and(
            eq(docVersions.id, input.docVersionId),
            eq(docVersions.taskId, input.taskId),
            eq(docVersions.reviewNodeRunId, input.nodeRunId),
            eq(docVersions.decision, 'approved'),
          ),
        )
        .returning({ id: docVersions.id })
      return changed.length === 1
    },
  })
}
