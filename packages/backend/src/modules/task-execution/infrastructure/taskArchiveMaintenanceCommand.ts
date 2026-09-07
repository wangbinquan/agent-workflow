// RFC-359 W8-A —— 终态任务树归档出库（RFC-311 T19）：**一份实现，两个 provider 共用**。
//
// 合一前是一对：SQLite 侧 `sqliteTaskArchiveMaintenanceCommand.ts`（66 行薄壳，逐方法转发给
// `services/taskArchive.ts` 的 1018 行 legacy 归档器）与 `postgresqlTaskArchiveMaintenanceCommand.ts`
// （747 行自带一份同样的导出 / 删库 / 恢复流程）。两侧共用同一个中立的终态维护认领 store
// （W7 已合的 `DrizzleTerminalMaintenancePersistence`），归档管线本身却是逐段同构的两份：
// 同一个 `ARCHIVE_SCHEMA_VERSION = 2`、同一份 manifest 形状、同一套 `.tmp-*` 崩溃恢复分支，
// 连导出表的**顺序**都逐个对齐（manifest 的 `rows` 键序进 digest，两侧因此本来就同摘要）。
//
// 对拍先行：`tests/rfc359-w8-task-archive-conformance.test.ts` 先在两个旧实现上各跑一遍，
// 11 组断言里只照出**一处**真差异（见下），其余（manifest / JSONL 行数 / runs·logs 挪移 /
// 审计行口径 / 两条崩溃分支 / `interrupted` 是终态 / maxTrees 上界）逐字一致。
//
// 合一按**强侧**抬齐的两处
// ------------------------
//  1. **恢复的归档根围栏（判据缺口 10，`rfc359-w5-dual-engine-predicate-gaps`）**。认领里冻结的
//     `cleanupPlanJson` 记着这次归档用的 archive / runs / logs 根。恢复被指到**另一个**根上时，
//     那条认领不归本次恢复管——它盘上的产物在旧根下，按新根判「盘上有没有」得到的结论必然是错的。
//     SQLite 侧读 plan 并按 archiveRoot 围栏跳过；PostgreSQL 侧从不读 `cleanupPlanJson`，于是把它
//     判成「盘上什么都没有」并把一条只差删库的 `io-complete` 认领**降级**回 `recovery-required`
//     （对拍实测：`io-complete` → `recovery-required`）。这里取 SQLite 的围栏，且重做导出时用
//     plan 里的 runs / logs 根，而不是本次调用传进来的。
//  2. **事务原语**。PG 侧原来是裸 `db.transaction` + `SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`
//     + 自己数重试次数；这里改成中立的 `databaseSessionFor(db).serializable`——它自带 40001 重放、
//     **可重入**（外层已开事务时复用同一句柄，不会再开一层从而让外层回滚带不走内层的写），
//     SQLite 上与 `BEGIN IMMEDIATE` 是同一条边界。认领行的事务内 CAS 直接复用中立参与者
//     `terminalMaintenanceClaim.ts`，同一张状态转移表只此一份。
//
// IN-list 分块用 `SQL_IN_CHUNK`（500）而不是 PG 侧原来的 2000：SQLite 有
// `SQLITE_MAX_VARIABLE_NUMBER` 上限且随构建而变（`util/sqlChunk.ts`），中立实现按最保守构建取值。
// JSONL 的写批次仍是 2000 行一段——那只关乎 `appendFileSync` 的粒度，与绑定参数无关。

import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  clarifyRounds,
  collaborationGateArtifacts,
  collaborationGateOperations,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  recoveryEvents,
  reviewComments,
  reviewNodeReviewers,
  taskArchiveAudit,
  taskCollaborators,
  taskExecutionEffectAttempts,
  taskExecutionEffectFences,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  taskExecutionMaintenanceClaims,
  taskExecutionMaintenanceMembers,
  taskExecutionOwners,
  taskFeedback,
  taskNodeClarifyDirectives,
  taskQuestions,
  taskRepos,
  taskSpaceNodes,
  tasks,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
  workgroupTaskState,
} from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import { chunkedAll, SQL_IN_CHUNK } from '@/util/sqlChunk'
import type {
  ArchivedTaskTreeReceipt,
  TaskArchiveConfig,
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
  TaskArchiveManualRequest,
  TaskArchivePreviewTree,
  TaskArchiveRecoveryReceipt,
  TaskArchiveSweepReceipt,
} from '../application/ports/taskArchiveMaintenanceCommand'
import type { TerminalMaintenanceStore } from '../application/ports/terminalMaintenanceStore'
import type { TerminalMaintenanceClaim } from '../domain/ownership'
import { sweepArchiveTempDirectories } from './archiveTempDirectorySweep'
import {
  assertTerminalMaintenanceClaimTx,
  transitionTerminalMaintenanceClaimTx,
} from './terminalMaintenanceClaim'
import { DrizzleTerminalMaintenancePersistence } from './terminalMaintenancePersistence'

const log = createLogger('task-archive')

const ARCHIVE_SCHEMA_VERSION = 2
/** JSONL 落盘的写批次（行数），与 SQL 绑定参数无关。 */
const WRITE_BATCH = 2_000
/** 一棵树最多下潜多少层（同 MAX_TREE_DEPTH 口径）。 */
const MAX_TREE_DEPTH = 64
// RFC-350：与 shared 的 `TERMINAL_TASK_STATUSES` 对齐。此前两侧各抄了一份三元素字面量，
// 漏掉了 `interrupted`——而 orphan reaper 把 daemon 重启时在跑的任务翻成 interrupted 时
// **是写了 finished_at 的**。漏掉的后果是：每次 daemon 重启残留的那批任务既不能被取消
// （cancel 事件的 allowed-from 不含 interrupted），又永远等不到归档，成为库里唯一一类永久居民。
const TERMINAL = TERMINAL_TASK_STATUSES

type ArchiveReader = ProviderNeutralDatabase | DatabaseTransaction
type ArchiveOptions = TaskArchiveMaintenanceOptions & { readonly source?: 'sweep' | 'manual' }

/** 一棵树的全部任务 id（root 优先，去重，深度有界）。 */
async function collectTree(db: ArchiveReader, rootTaskId: string): Promise<string[]> {
  const out = [rootTaskId]
  const seen = new Set(out)
  let frontier = [rootTaskId]
  for (let depth = 0; frontier.length > 0 && depth < MAX_TREE_DEPTH; depth += 1) {
    const children = await chunkedAll(
      frontier,
      async (chunk) =>
        await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.parentTaskId, chunk)),
    )
    const next: string[] = []
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      next.push(child.id)
    }
    frontier = next
    out.push(...next)
  }
  return out
}

interface TreeCandidate {
  readonly rootTaskId: string
  readonly taskIds: readonly string[]
  readonly lastFinishedAt: number
}

/** 可归档的树：整树全终态，且 max(finishedAt) 早于 cutoff。 */
async function findArchivableTrees(
  db: ProviderNeutralDatabase,
  cutoff: number,
  limit: number,
): Promise<readonly TreeCandidate[]> {
  const roots = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        isNull(tasks.parentTaskId),
        inArray(tasks.status, [...TERMINAL]),
        lte(tasks.finishedAt, cutoff),
      ),
    )
    .orderBy(asc(tasks.finishedAt))
    .limit(limit * 4)
  const out: TreeCandidate[] = []
  for (const root of roots) {
    const taskIds = await collectTree(db, root.id)
    const rows = await chunkedAll(
      taskIds,
      async (chunk) =>
        await db
          .select({ status: tasks.status, finishedAt: tasks.finishedAt })
          .from(tasks)
          .where(inArray(tasks.id, chunk)),
    )
    // 整树判据：任一成员消失 / 非终态 / 未完成 / 仍在保留期内 ⇒ 整树跳过。
    if (
      rows.length !== taskIds.length ||
      rows.some(
        (row) =>
          !(TERMINAL as readonly string[]).includes(row.status) ||
          row.finishedAt === null ||
          row.finishedAt > cutoff,
      )
    ) {
      continue
    }
    out.push({
      rootTaskId: root.id,
      taskIds,
      lastFinishedAt: Math.max(...rows.map((row) => row.finishedAt ?? 0)),
    })
    if (out.length >= limit) break
  }
  return out
}

function writeJsonl(path: string, rows: readonly unknown[]): number {
  if (rows.length === 0) return 0
  for (let offset = 0; offset < rows.length; offset += WRITE_BATCH) {
    appendFileSync(
      path,
      rows
        .slice(offset, offset + WRITE_BATCH)
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
      'utf8',
    )
  }
  return rows.length
}

/**
 * 归档目录里逐表导出的全部行。
 *
 * 对账口径：凡 `references(() => tasks.id, onDelete: 'cascade')` 的表都会随删库消失，所以除
 * `ARCHIVE_EXEMPT_TABLES` 一处例外，它们**必须**在这里各占一行，否则就是「没导出却被删掉」的
 * 静默丢失。`review_comments` 是**两跳**级联后代（`review_comments` → `doc_versions` → `tasks`），
 * 按 doc_version id 归属回到 task 维度；`collaboration_gate_artifacts` 同理按 operation id。
 * lineage 表是软引用，必须按每一种可能的 task / effect 锚各查一遍（RFC-328 D12）。
 *
 * 键序进 manifest 的 `rows`，`rows` 又进 digest —— **不要重排**。
 */
async function loadArchiveRows(
  db: ProviderNeutralDatabase,
  taskIds: readonly string[],
): Promise<Readonly<Record<string, readonly unknown[]>>> {
  const byTask = <T>(load: (ids: string[]) => Promise<T[]>) => chunkedAll(taskIds, load)
  const operationRows = await byTask(
    async (ids) =>
      await db
        .select()
        .from(collaborationGateOperations)
        .where(inArray(collaborationGateOperations.taskId, ids)),
  )
  const operationIds = operationRows.map((row) => row.id)
  const documentRows = await byTask(
    async (ids) => await db.select().from(docVersions).where(inArray(docVersions.taskId, ids)),
  )
  const documentIds = documentRows.map((row) => row.id)
  const runRows = await byTask(
    async (ids) => await db.select().from(nodeRuns).where(inArray(nodeRuns.taskId, ids)),
  )
  const runIds = runRows.map((row) => row.id)
  const effectRows = await byTask(
    async (ids) =>
      await db.select().from(taskExecutionEffects).where(inArray(taskExecutionEffects.taskId, ids)),
  )
  const effectIds = effectRows.map((row) => row.id)
  const attemptRows = await chunkedAll(
    effectIds,
    async (ids) =>
      await db
        .select()
        .from(taskExecutionEffectAttempts)
        .where(inArray(taskExecutionEffectAttempts.effectId, ids)),
  )
  const attemptIds = attemptRows.map((row) => row.id)
  const lineage = new Map<string, typeof taskExecutionLineageOperationRecords.$inferSelect>()
  for (const row of await byTask(
    async (ids) =>
      await db
        .select()
        .from(taskExecutionLineageOperationRecords)
        .where(
          or(
            inArray(taskExecutionLineageOperationRecords.rootAnchorTaskId, ids),
            inArray(taskExecutionLineageOperationRecords.ancestorAnchorTaskId, ids),
            inArray(taskExecutionLineageOperationRecords.currentAnchorTaskId, ids),
            inArray(taskExecutionLineageOperationRecords.sourceTaskId, ids),
          ),
        ),
  )) {
    lineage.set(row.id, row)
  }
  for (const row of await chunkedAll(
    effectIds,
    async (ids) =>
      await db
        .select()
        .from(taskExecutionLineageOperationRecords)
        .where(inArray(taskExecutionLineageOperationRecords.sourceEffectId, ids)),
  )) {
    lineage.set(row.id, row)
  }

  return {
    tasks: await byTask(async (ids) => await db.select().from(tasks).where(inArray(tasks.id, ids))),
    task_repos: await byTask(
      async (ids) => await db.select().from(taskRepos).where(inArray(taskRepos.taskId, ids)),
    ),
    task_space_nodes: await byTask(
      async (ids) =>
        await db.select().from(taskSpaceNodes).where(inArray(taskSpaceNodes.taskId, ids)),
    ),
    task_collaborators: await byTask(
      async (ids) =>
        await db.select().from(taskCollaborators).where(inArray(taskCollaborators.taskId, ids)),
    ),
    review_node_reviewers: await byTask(
      async (ids) =>
        await db.select().from(reviewNodeReviewers).where(inArray(reviewNodeReviewers.taskId, ids)),
    ),
    task_questions: await byTask(
      async (ids) =>
        await db.select().from(taskQuestions).where(inArray(taskQuestions.taskId, ids)),
    ),
    task_feedback: await byTask(
      async (ids) => await db.select().from(taskFeedback).where(inArray(taskFeedback.taskId, ids)),
    ),
    task_node_clarify_directives: await byTask(
      async (ids) =>
        await db
          .select()
          .from(taskNodeClarifyDirectives)
          .where(inArray(taskNodeClarifyDirectives.taskId, ids)),
    ),
    clarify_rounds: await byTask(
      async (ids) =>
        await db.select().from(clarifyRounds).where(inArray(clarifyRounds.taskId, ids)),
    ),
    collaboration_gate_operations: operationRows,
    collaboration_gate_artifacts: await chunkedAll(
      operationIds,
      async (ids) =>
        await db
          .select()
          .from(collaborationGateArtifacts)
          .where(inArray(collaborationGateArtifacts.operationId, ids)),
    ),
    doc_versions: documentRows,
    review_comments: await chunkedAll(
      documentIds,
      async (ids) =>
        await db.select().from(reviewComments).where(inArray(reviewComments.docVersionId, ids)),
    ),
    lifecycle_alerts: await byTask(
      async (ids) =>
        await db.select().from(lifecycleAlerts).where(inArray(lifecycleAlerts.taskId, ids)),
    ),
    recovery_events: await byTask(
      async (ids) =>
        await db.select().from(recoveryEvents).where(inArray(recoveryEvents.taskId, ids)),
    ),
    workgroup_task_state: await byTask(
      async (ids) =>
        await db.select().from(workgroupTaskState).where(inArray(workgroupTaskState.taskId, ids)),
    ),
    workgroup_assignments: await byTask(
      async (ids) =>
        await db
          .select()
          .from(workgroupAssignments)
          .where(inArray(workgroupAssignments.taskId, ids)),
    ),
    workgroup_messages: await byTask(
      async (ids) =>
        await db.select().from(workgroupMessages).where(inArray(workgroupMessages.taskId, ids)),
    ),
    workgroup_member_cursors: await byTask(
      async (ids) =>
        await db
          .select()
          .from(workgroupMemberCursors)
          .where(inArray(workgroupMemberCursors.taskId, ids)),
    ),
    node_runs: runRows,
    node_run_outputs: await chunkedAll(
      runIds,
      async (ids) =>
        await db.select().from(nodeRunOutputs).where(inArray(nodeRunOutputs.nodeRunId, ids)),
    ),
    node_run_events: await chunkedAll(
      runIds,
      async (ids) =>
        await db.select().from(nodeRunEvents).where(inArray(nodeRunEvents.nodeRunId, ids)),
    ),
    task_execution_owners: await byTask(
      async (ids) =>
        await db.select().from(taskExecutionOwners).where(inArray(taskExecutionOwners.taskId, ids)),
    ),
    task_execution_intents: await byTask(
      async (ids) =>
        await db
          .select()
          .from(taskExecutionIntents)
          .where(inArray(taskExecutionIntents.taskId, ids)),
    ),
    task_execution_effects: effectRows,
    task_execution_effect_attempts: attemptRows,
    task_execution_effect_fences: await chunkedAll(
      attemptIds,
      async (ids) =>
        await db
          .select()
          .from(taskExecutionEffectFences)
          .where(inArray(taskExecutionEffectFences.effectAttemptId, ids)),
    ),
    task_execution_lineage_operation_records: [...lineage.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  }
}

/** 归档目录里会出现的全部表名（供 `rfc311-task-archive` 的级联对账守卫比对）。 */
export const ARCHIVED_TABLES: readonly string[] = [
  'tasks',
  'task_repos',
  'task_space_nodes',
  'task_collaborators',
  'review_node_reviewers',
  'task_questions',
  'task_feedback',
  'task_node_clarify_directives',
  'clarify_rounds',
  'collaboration_gate_operations',
  'collaboration_gate_artifacts',
  'doc_versions',
  'review_comments',
  'lifecycle_alerts',
  'recovery_events',
  'workgroup_task_state',
  'workgroup_assignments',
  'workgroup_messages',
  'workgroup_member_cursors',
  'node_runs',
  'node_run_outputs',
  'node_run_events',
  'task_execution_owners',
  'task_execution_intents',
  'task_execution_effects',
  'task_execution_effect_attempts',
  'task_execution_effect_fences',
  'task_execution_lineage_operation_records',
]

/** 会随删库级联消失、但**故意**不归档的表。
 *  `runtime_session_leases` 是「哪个进程当前持有该原生会话」的活跃运行态租约，对一棵整树终态的
 *  任务没有任何事后价值，归档它等于归档一把过期的锁。加进来必须写清为什么。 */
export const ARCHIVE_EXEMPT_TABLES: readonly string[] = ['runtime_session_leases']

/**
 * 删库：一笔事务、认领的事务内 CAS 与删除同生共死。
 *
 * `claim` 是入参、返回新 revision，因此整笔重放（PG 的 40001 序列化失败重放 / SQLite 的写者争用
 * 重试）每次都从同一个 revision 起算。
 */
async function finalizeDatabase(
  db: ProviderNeutralDatabase,
  rootTaskId: string,
  taskIds: readonly string[],
  claim: TerminalMaintenanceClaim,
  now: number,
): Promise<TerminalMaintenanceClaim> {
  return await databaseSessionFor(db).serializable(async (tx) => {
    await assertTerminalMaintenanceClaimTx(tx, { claim, expectedState: 'io-complete' })
    const currentIds = (await collectTree(tx, rootTaskId)).sort()
    const expectedIds = [...taskIds].sort()
    if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
      throw new Error(`archive task tree changed after claim '${claim.claimId}'`)
    }
    for (let offset = 0; offset < expectedIds.length; offset += SQL_IN_CHUNK) {
      const chunk = expectedIds.slice(offset, offset + SQL_IN_CHUNK)
      // `task_feedback` 不是 FK 级联后代，显式先删；`tasks` 的删除带走其余级联族。
      await tx.delete(taskFeedback).where(inArray(taskFeedback.taskId, chunk))
      await tx.delete(tasks).where(inArray(tasks.id, chunk))
    }
    return await transitionTerminalMaintenanceClaimTx(tx, { claim, to: 'db-finalized', now })
  })
}

/**
 * 导出并收尾一棵**已认领**的树。重放同一条耐久认领时，崩溃前已经挪走的 runs / logs 目录原样
 * 保留，只重建可复现的 DB JSONL。
 */
async function archiveClaimed(
  db: ProviderNeutralDatabase,
  maintenance: TerminalMaintenanceStore,
  rootTaskId: string,
  taskIds: readonly string[],
  initialClaim: TerminalMaintenanceClaim,
  options: ArchiveOptions,
): Promise<ArchivedTaskTreeReceipt> {
  const now = options.now ?? Date.now()
  const tmpDir = join(options.archiveDir, `.tmp-${rootTaskId}`)
  const finalDir = join(options.archiveDir, rootTaskId)
  if (existsSync(finalDir)) {
    throw new Error(`archive destination already exists for task '${rootTaskId}'`)
  }
  rmSync(join(tmpDir, 'db'), { recursive: true, force: true })
  rmSync(join(tmpDir, 'manifest.json'), { force: true })
  mkdirSync(join(tmpDir, 'db'), { recursive: true })

  const rows = await loadArchiveRows(db, taskIds)
  const counts: Record<string, number> = {}
  for (const [name, tableRows] of Object.entries(rows)) {
    counts[name] = writeJsonl(join(tmpDir, 'db', `${name}.jsonl`), tableRows)
  }
  // runs / logs 整体**挪入**（而不是复制+删除：大目录复制会把归档变成一次长 IO）。
  for (const [kind, root] of [
    ['runs', options.runsDir],
    ['logs', options.logsDir],
  ] as const) {
    let moved = 0
    for (const taskId of taskIds) {
      const source = join(root, taskId)
      const destination = join(tmpDir, kind, taskId)
      if (existsSync(destination)) {
        moved += 1
        continue
      }
      if (!existsSync(source)) continue
      mkdirSync(join(tmpDir, kind), { recursive: true })
      renameSync(source, destination)
      moved += 1
    }
    counts[`${kind}_dirs`] = moved
  }

  // 这两条读必须 `await`：少写 await 在 bun:sqlite 上照样拿得到行，在 PostgreSQL 上会把两个
  // **Promise** 写进 manifest（claimRow 恒真、于是连「认领消失了」这条判据都失效），而 tsc 不报错。
  const claimRows = await db
    .select()
    .from(taskExecutionMaintenanceClaims)
    .where(eq(taskExecutionMaintenanceClaims.id, initialClaim.claimId))
    .limit(1)
  const memberRows = await db
    .select()
    .from(taskExecutionMaintenanceMembers)
    .where(eq(taskExecutionMaintenanceMembers.claimId, initialClaim.claimId))
    .orderBy(asc(taskExecutionMaintenanceMembers.taskId))
  const claimRow = claimRows[0]
  if (claimRow === undefined) throw new Error(`archive claim '${initialClaim.claimId}' disappeared`)

  writeFileSync(
    join(tmpDir, 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        rootTaskId,
        taskIds,
        exportedAt: new Date(now).toISOString(),
        rows: counts,
        terminalMaintenance: { claim: claimRow, members: memberRows },
        // 校验和覆盖「导出了什么」这一事实本身，便于事后确认目录未被截断。
        digest: sha256Hex(
          JSON.stringify({
            rootTaskId,
            taskIds: [...taskIds],
            rows: counts,
            maintenanceClaimId: claimRow.id,
            memberSetDigest: claimRow.memberSetDigest,
          }),
        ),
      },
      null,
      2,
    ),
    'utf8',
  )
  // 全部落盘成功后才 rename；rename 之后库里的行才允许删。
  renameSync(tmpDir, finalDir)

  const ioClaim = await maintenance.transition({ claim: initialClaim, to: 'io-complete', now })
  const finalized = await finalizeDatabase(db, rootTaskId, taskIds, ioClaim, now)
  await maintenance.complete({ claim: finalized, now })

  log.info('archived task tree', { rootTaskId, tasks: taskIds.length, dir: finalDir })
  return { rootTaskId, taskIds: [...taskIds], rows: counts, dir: finalDir }
}

/**
 * 归档一棵树。maintenance claim 在任何 mkdir / rename 之前提交；任一步失败都保留 exact claim 与
 * cleanup plan，boot / sweeper 可从同一 revision 继续。
 *
 * 定时保留扫描与操作者手动归档共用同一份导出实现，但各留一个耐久的权威：恢复 / 审计据此说清
 * 这棵树因为什么离开了在线库。
 */
async function archiveTree(
  db: ProviderNeutralDatabase,
  maintenance: TerminalMaintenanceStore,
  rootTaskId: string,
  options: ArchiveOptions,
): Promise<ArchivedTaskTreeReceipt> {
  const members = await maintenance.snapshotTree(rootTaskId)
  const taskIds = members.map((member) => member.taskId)
  const claim = await maintenance.claim({
    rootTaskId,
    operation: options.source === 'manual' ? 'archive' : 'retention',
    members,
    cleanupPlanJson: JSON.stringify({
      v: 2,
      rootTaskId,
      archiveRoot: options.archiveDir,
      runsRoot: options.runsDir,
      logsRoot: options.logsDir,
    }),
    now: options.now,
  })
  return await archiveClaimed(db, maintenance, rootTaskId, taskIds, claim, options)
}

interface ArchiveCleanupPlanV2 {
  readonly v: 2
  readonly rootTaskId: string
  readonly archiveRoot: string
  readonly runsRoot: string
  readonly logsRoot: string
}

function parseArchiveCleanupPlan(value: string): ArchiveCleanupPlanV2 | null {
  try {
    const parsed = JSON.parse(value) as Partial<ArchiveCleanupPlanV2>
    return parsed.v === 2 &&
      typeof parsed.rootTaskId === 'string' &&
      typeof parsed.archiveRoot === 'string' &&
      typeof parsed.runsRoot === 'string' &&
      typeof parsed.logsRoot === 'string'
      ? (parsed as ArchiveCleanupPlanV2)
      : null
  } catch {
    return null
  }
}

/**
 * 续做崩溃留下的 RFC-328 耐久归档认领。**认领里冻结的 cleanupPlan 是归档根的唯一权威**：
 * plan 读不出来、或它记的 archiveRoot 与本次恢复的根不同，这条认领就不归本次恢复管——直接跳过，
 * 不改它的状态（判据缺口 10 的强侧行为）。
 */
async function recoverClaimedArchives(
  db: ProviderNeutralDatabase,
  maintenance: TerminalMaintenanceStore,
  options: TaskArchiveMaintenanceOptions,
): Promise<{ readonly promoted: readonly string[]; readonly claimedRoots: ReadonlySet<string> }> {
  const promoted: string[] = []
  const claimedRoots = new Set<string>()
  const recoverable = [
    ...(await maintenance.listRecoverable({ operation: 'archive' })),
    ...(await maintenance.listRecoverable({ operation: 'retention' })),
  ]
  for (const item of recoverable) {
    claimedRoots.add(item.rootTaskId)
    const plan = parseArchiveCleanupPlan(item.cleanupPlanJson)
    if (plan === null || plan.archiveRoot !== options.archiveDir) continue
    const claimOptions: TaskArchiveMaintenanceOptions = {
      ...options,
      archiveDir: plan.archiveRoot,
      runsDir: plan.runsRoot,
      logsDir: plan.logsRoot,
    }
    let claim = item.claim
    let state = item.state
    const tmpDir = join(plan.archiveRoot, `.tmp-${item.rootTaskId}`)
    const finalDir = join(plan.archiveRoot, item.rootTaskId)
    const rootRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, item.rootTaskId))
      .limit(1)
    const rootExists = rootRows[0] !== undefined
    const members = item.members.map((member) => member.taskId)

    if (state === 'recovery-required') {
      if (existsSync(finalDir)) {
        claim = await maintenance.transition({
          claim,
          to: rootExists ? 'io-complete' : 'db-finalized',
        })
        state = rootExists ? 'io-complete' : 'db-finalized'
      } else if (rootExists) {
        claim = await maintenance.transition({ claim, to: 'claimed' })
        state = 'claimed'
      } else {
        continue
      }
    }
    if (state === 'claimed' && !existsSync(finalDir)) {
      if (!rootExists) continue
      await archiveClaimed(db, maintenance, item.rootTaskId, members, claim, claimOptions)
      promoted.push(item.rootTaskId)
      continue
    }
    if (state === 'claimed') {
      claim = await maintenance.transition({ claim, to: 'io-complete' })
      state = 'io-complete'
    }
    if (state === 'io-complete') {
      // 崩在 rename 与删库之间时 tmp 里已有完整 manifest，提升为正式目录。
      if (!existsSync(finalDir) && existsSync(join(tmpDir, 'manifest.json'))) {
        renameSync(tmpDir, finalDir)
        promoted.push(item.rootTaskId)
      }
      if (!existsSync(finalDir)) {
        await maintenance.transition({ claim, to: 'recovery-required' })
        continue
      }
      claim = rootExists
        ? await finalizeDatabase(db, item.rootTaskId, members, claim, Date.now())
        : await maintenance.transition({ claim, to: 'db-finalized' })
      state = 'db-finalized'
    }
    if (state === 'db-finalized' || state === 'cleanup-pending') {
      if (!existsSync(finalDir)) {
        await maintenance.transition({ claim, to: 'recovery-required' })
        continue
      }
      await maintenance.complete({ claim })
    }
  }
  return { promoted, claimedRoots }
}

/**
 * 写一行归档审计。**不进任务级联族**（见 schema 注释）：被记录的任务行马上就要被删掉，审计必须
 * 活得比它们久，否则「谁归档了多少」随归档一起消失。
 */
async function writeArchiveAudit(
  db: ProviderNeutralDatabase,
  row: {
    readonly source: 'sweep' | 'manual'
    readonly actorUserId: string | null
    readonly retentionDays: number
    readonly archived: readonly ArchivedTaskTreeReceipt[]
    readonly skipped: number
    readonly now: number
  },
): Promise<void> {
  await db.insert(taskArchiveAudit).values({
    id: ulid(),
    source: row.source,
    actorUserId: row.actorUserId,
    retentionDays: row.retentionDays,
    treeCount: row.archived.length,
    taskCount: row.archived.reduce((sum, tree) => sum + tree.taskIds.length, 0),
    skippedCount: row.skipped,
    rootTaskIdsJson: JSON.stringify(row.archived.map((tree) => tree.rootTaskId)),
    createdAt: row.now,
  })
}

async function archiveCandidates(
  db: ProviderNeutralDatabase,
  maintenance: TerminalMaintenanceStore,
  candidates: readonly TreeCandidate[],
  options: ArchiveOptions,
): Promise<{ readonly archived: ArchivedTaskTreeReceipt[]; readonly skipped: number }> {
  const archived: ArchivedTaskTreeReceipt[] = []
  let skipped = 0
  for (const candidate of candidates) {
    try {
      archived.push(await archiveTree(db, maintenance, candidate.rootTaskId, options))
    } catch (error) {
      // 落盘失败（磁盘满 / 权限）⇒ 库内不删，留待下一轮；不阻塞其它树。
      skipped += 1
      log.warn('archive failed; database left intact', {
        rootTaskId: candidate.rootTaskId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { archived, skipped }
}

/** 终态任务树归档出库：一份实现，SQLite / PostgreSQL 共用。 */
export function createDrizzleTaskArchiveMaintenanceCommand(
  db: ProviderNeutralDatabase,
): TaskArchiveMaintenanceCommand {
  const maintenance: TerminalMaintenanceStore = new DrizzleTerminalMaintenancePersistence(db)
  return Object.freeze({
    /** 一轮归档扫描。默认关闭；`enabled=false` 或 `retentionDays<=0` 直接返回。 */
    async runSweep(
      config: TaskArchiveConfig,
      options: TaskArchiveMaintenanceOptions,
    ): Promise<TaskArchiveSweepReceipt> {
      if (!config.enabled || config.retentionDays <= 0) return { archived: [], skipped: 0 }
      const now = options.now ?? Date.now()
      const effective = { ...options, now, source: 'sweep' as const }
      await recoverClaimedArchives(db, maintenance, effective)
      const candidates = await findArchivableTrees(
        db,
        now - config.retentionDays * 86_400_000,
        config.maxTreesPerSweep ?? 50,
      )
      const { archived, skipped } = await archiveCandidates(db, maintenance, candidates, effective)
      // hourly sweeper 只在真动了数据时写审计，否则默认开启后每小时一行空审计会把这张表撑成噪音。
      if (archived.length > 0 || skipped > 0) {
        await writeArchiveAudit(db, {
          source: 'sweep',
          actorUserId: null,
          retentionDays: config.retentionDays,
          archived,
          skipped,
          now,
        })
      }
      return { archived, skipped }
    },
    /** 供 CLI / admin API 使用：按条件预览可归档的树，不动任何数据。 */
    async preview(
      input: Parameters<TaskArchiveMaintenanceCommand['preview']>[0],
    ): Promise<readonly TaskArchivePreviewTree[]> {
      if (input.retentionDays <= 0) return []
      const now = input.now ?? Date.now()
      const candidates = await findArchivableTrees(
        db,
        now - input.retentionDays * 86_400_000,
        input.maxTrees,
      )
      return candidates.map((candidate) => ({
        rootTaskId: candidate.rootTaskId,
        taskCount: candidate.taskIds.length,
        lastFinishedAt: candidate.lastFinishedAt,
      }))
    },
    /**
     * 手动批量归档（admin API / 设置页维护区）。与 sweeper 走同一条管线，区别只有两点：
     * **忽略 `enabled` 开关**（手动入口的意义就是开关关着也能清一次）、审计行 source='manual'
     * 且带操作者——而且**每次都留痕**（哪怕一棵树都没归档：「某人在某时对全库执行了一次归档」
     * 本身就是要留的事实；dry-run 预览不走这里，自然也不写）。
     */
    async runManual(
      input: TaskArchiveManualRequest,
      options: TaskArchiveMaintenanceOptions,
    ): Promise<TaskArchiveSweepReceipt> {
      const now = input.now ?? options.now ?? Date.now()
      const effective = { ...options, now, source: 'manual' as const }
      await recoverClaimedArchives(db, maintenance, effective)
      const candidates = await findArchivableTrees(
        db,
        now - input.retentionDays * 86_400_000,
        input.maxTrees,
      )
      const { archived, skipped } = await archiveCandidates(db, maintenance, candidates, effective)
      await writeArchiveAudit(db, {
        source: 'manual',
        actorUserId: input.actorUserId,
        retentionDays: input.retentionDays,
        archived,
        skipped,
        now,
      })
      return { archived, skipped }
    },
    /** boot 时续做崩溃留下的 archive / retention 认领，再按同一份规则收尾 `.tmp-*` 残留。 */
    async recover(options: TaskArchiveMaintenanceOptions): Promise<TaskArchiveRecoveryReceipt> {
      const claims = await recoverClaimedArchives(db, maintenance, options)
      const swept = await sweepArchiveTempDirectories({
        archiveRoot: options.archiveDir,
        runsDir: options.runsDir,
        logsDir: options.logsDir,
        claimedRoots: claims.claimedRoots,
        taskExists: async (taskId) =>
          (
            await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
          )[0] !== undefined,
      })
      const promoted = [...claims.promoted, ...swept.promoted]
      const discarded = [...swept.discarded]
      if (promoted.length > 0 || discarded.length > 0) {
        log.info('recovered interrupted archives', { promoted, discarded })
      }
      return { promoted, discarded }
    },
  })
}
