// RFC-311 T19 — 终态任务树归档出库(用户拍板:归档到归档目录、从表里删除、
// 前台不可见)。
//
// 语义(proposal §5 C1 / design §7.1):
//   - **单位是整棵任务树**(root + 全部后代),不是单个任务:一棵树里只要有一个
//     任务非终态、或最近一次 finishedAt 还在保留期内,整棵树都不动;
//   - 归档目录 `~/.agent-workflow/archive/tasks/{rootTaskId}/`:manifest.json
//     (schema 版本 / 导出时间 / 任务 id 清单 / 各表行数 / 内容校验和)+
//     `db/{table}.jsonl` 逐表全量行 + `runs/`、`logs/` 目录整体挪入;
//   - **原子性**:先写 `.tmp-{id}/` → 全部落盘 → rename 成正式目录 → 才删库。
//     崩溃恢复(boot)扫 `.tmp-*`:库里行还在就重做,行已删就把它提升为正式目录。
//     任一步失败都不删库——宁可留下一份可丢弃的 tmp,也不能出现「库删了、盘上
//     没有」的窗口;
//   - 归档 == 删除:所有列表/详情/搜索 404 与不存在同形,不提供在线回看。
//
// 默认关闭:`taskArchive.enabled=false`。开启后 hourly sweeper 按 retentionDays
// 扫描;另有 admin 手动入口。删除复用 taskDelete 的语义(FK 级联 + 显式非 FK 表),
// 但 runs/logs 改为**挪移**而不是删除。

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import {
  clarifyRounds,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  recoveryEvents,
  reviewComments,
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
import { taskExecutionModule } from '@/modules/task-execution/composition'
import type { TerminalMaintenanceClaim } from '@/modules/task-execution/domain/ownership'
import {
  HOUR_MS,
  MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS,
  MAINTENANCE_PHASE,
} from '@/services/daemonCadence'
import { startMaintenanceTicker } from '@/services/maintenanceTicker'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { sha256Hex } from '@/util/hash'
import { chunkedAll } from '@/util/sqlChunk'

const log = createLogger('task-archive')

const ARCHIVE_SCHEMA_VERSION = 2
const EXPORT_BATCH = 2_000
const TERMINAL = ['done', 'failed', 'canceled'] as const

/** 审计行的触发面:hourly 归档器 vs 设置页/API 的手动批量入口。 */
export type ArchiveSource = 'sweep' | 'manual'

export interface TaskArchiveOptions {
  /** 归档根目录(测试注入);默认 Paths.taskArchiveDir。 */
  archiveDir?: string
  runsDir?: string
  logsDir?: string
  now?: number
  /** 审计行归因;默认 'sweep' + 无操作者。 */
  source?: ArchiveSource
  actorUserId?: string | null
}

export interface ArchivedTree {
  rootTaskId: string
  taskIds: string[]
  rows: Record<string, number>
  dir: string
}

export interface ArchiveSweepResult {
  archived: ArchivedTree[]
  skipped: number
}

/** 任务级子表(task_id 直接引用)。code/webhook/memory 三域的软链接行不进归档:
 *  它们的生命周期归各自的域治理,这里只带走「任务自己的」执行事实。
 *
 *  对账口径:凡 `references(() => tasks.id, onDelete: 'cascade')` 的表都会随删库
 *  消失,所以除下面一处例外,它们**必须**在这张清单(或 RUN_SCOPED)里各占一行,
 *  否则就是「没导出却被删掉」的静默丢失。唯一例外是 `runtime_session_leases`
 *  ——它是「哪个进程当前持有该原生会话」的活跃运行态租约,对一棵整树终态的任务
 *  没有任何事后价值,归档它等于归档一把过期的锁。 */
interface ExportSpec {
  name: string
  load: (db: DbClient, ids: readonly string[]) => Promise<unknown[]>
}

const TASK_SCOPED: readonly ExportSpec[] = [
  {
    name: 'task_repos',
    load: (db, ids) =>
      chunkedAll(ids, (c) => db.select().from(taskRepos).where(inArray(taskRepos.taskId, c))),
  },
  {
    name: 'task_space_nodes',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(taskSpaceNodes).where(inArray(taskSpaceNodes.taskId, c)),
      ),
  },
  {
    name: 'task_collaborators',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(taskCollaborators).where(inArray(taskCollaborators.taskId, c)),
      ),
  },
  {
    name: 'task_questions',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(taskQuestions).where(inArray(taskQuestions.taskId, c)),
      ),
  },
  {
    name: 'task_feedback',
    load: (db, ids) =>
      chunkedAll(ids, (c) => db.select().from(taskFeedback).where(inArray(taskFeedback.taskId, c))),
  },
  {
    name: 'task_node_clarify_directives',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db
          .select()
          .from(taskNodeClarifyDirectives)
          .where(inArray(taskNodeClarifyDirectives.taskId, c)),
      ),
  },
  {
    name: 'clarify_rounds',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(clarifyRounds).where(inArray(clarifyRounds.taskId, c)),
      ),
  },
  {
    name: 'doc_versions',
    load: (db, ids) =>
      chunkedAll(ids, (c) => db.select().from(docVersions).where(inArray(docVersions.taskId, c))),
  },
  {
    // RFC-317 CC-01 —— `review_comments` 是**两跳**级联后代
    // (`review_comments` → `doc_versions` → `tasks` / `node_runs`)。原先的对账
    // 守卫只走一跳，结构上看不见它，于是它随归档被**静默删除**且既不在导出清单
    // 也不在豁免清单——目录里没有、库里也没有、还不报错。
    //
    // 注意 `doc_versions.comments_json` 只冻结了**决定时刻**的评论；未决文档上的
    // 评论此前是真的丢了，所以这里必须逐行导出，不能拿那一列当替代品。
    //
    // 用子查询按 doc_version 归属回到 task 维度，不用 join——join 会让 JSONL 多
    // 出一层包裹，与其它表的行形状不一致。
    name: 'review_comments',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db
          .select()
          .from(reviewComments)
          .where(
            inArray(
              reviewComments.docVersionId,
              db
                .select({ id: docVersions.id })
                .from(docVersions)
                .where(inArray(docVersions.taskId, c)),
            ),
          ),
      ),
  },
  {
    name: 'lifecycle_alerts',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(lifecycleAlerts).where(inArray(lifecycleAlerts.taskId, c)),
      ),
  },
  {
    name: 'recovery_events',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(recoveryEvents).where(inArray(recoveryEvents.taskId, c)),
      ),
  },
  {
    name: 'workgroup_task_state',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(workgroupTaskState).where(inArray(workgroupTaskState.taskId, c)),
      ),
  },
  {
    name: 'workgroup_assignments',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(workgroupAssignments).where(inArray(workgroupAssignments.taskId, c)),
      ),
  },
  {
    name: 'workgroup_messages',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(workgroupMessages).where(inArray(workgroupMessages.taskId, c)),
      ),
  },
  {
    name: 'workgroup_member_cursors',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(workgroupMemberCursors).where(inArray(workgroupMemberCursors.taskId, c)),
      ),
  },
]

/** node_run 级子表(node_run_id 引用)。 */
const RUN_SCOPED: readonly ExportSpec[] = [
  {
    name: 'node_run_outputs',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(nodeRunOutputs).where(inArray(nodeRunOutputs.nodeRunId, c)),
      ),
  },
  {
    name: 'node_run_events',
    load: (db, ids) =>
      chunkedAll(ids, (c) =>
        db.select().from(nodeRunEvents).where(inArray(nodeRunEvents.nodeRunId, c)),
      ),
  },
]

interface ExecutionLedgerExport {
  readonly rows: Readonly<Record<string, readonly unknown[]>>
  readonly effectIds: readonly string[]
  readonly attemptIds: readonly string[]
}

/**
 * RFC-328 D12: an archive is self-contained for execution recovery/audit.  The
 * retained lineage table has soft references, so it must be selected by every
 * possible task/effect anchor instead of relying on FK traversal.
 */
async function loadExecutionLedgers(
  db: DbClient,
  taskIds: readonly string[],
): Promise<ExecutionLedgerExport> {
  const owners = await chunkedAll(taskIds, (chunk) =>
    db.select().from(taskExecutionOwners).where(inArray(taskExecutionOwners.taskId, chunk)),
  )
  const intents = await chunkedAll(taskIds, (chunk) =>
    db.select().from(taskExecutionIntents).where(inArray(taskExecutionIntents.taskId, chunk)),
  )
  const effects = await chunkedAll(taskIds, (chunk) =>
    db.select().from(taskExecutionEffects).where(inArray(taskExecutionEffects.taskId, chunk)),
  )
  const effectIds = effects.map((row) => row.id)
  const attempts = await chunkedAll(effectIds, (chunk) =>
    db
      .select()
      .from(taskExecutionEffectAttempts)
      .where(inArray(taskExecutionEffectAttempts.effectId, chunk)),
  )
  const attemptIds = attempts.map((row) => row.id)
  const fences = await chunkedAll(attemptIds, (chunk) =>
    db
      .select()
      .from(taskExecutionEffectFences)
      .where(inArray(taskExecutionEffectFences.effectAttemptId, chunk)),
  )

  const lineageById = new Map<string, typeof taskExecutionLineageOperationRecords.$inferSelect>()
  for (const row of await chunkedAll(taskIds, (chunk) =>
    db
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(
        or(
          inArray(taskExecutionLineageOperationRecords.rootAnchorTaskId, chunk),
          inArray(taskExecutionLineageOperationRecords.ancestorAnchorTaskId, chunk),
          inArray(taskExecutionLineageOperationRecords.currentAnchorTaskId, chunk),
          inArray(taskExecutionLineageOperationRecords.sourceTaskId, chunk),
        ),
      ),
  )) {
    lineageById.set(row.id, row)
  }
  for (const row of await chunkedAll(effectIds, (chunk) =>
    db
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(inArray(taskExecutionLineageOperationRecords.sourceEffectId, chunk)),
  )) {
    lineageById.set(row.id, row)
  }

  return {
    rows: {
      task_execution_owners: owners,
      task_execution_intents: intents,
      task_execution_effects: effects,
      task_execution_effect_attempts: attempts,
      task_execution_effect_fences: fences,
      task_execution_lineage_operation_records: [...lineageById.values()].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    },
    effectIds,
    attemptIds,
  }
}

/** 归档目录里会出现的全部表名(供对账守卫比对,见上面的口径说明)。 */
export const ARCHIVED_TABLES: readonly string[] = [
  'tasks',
  'node_runs',
  ...TASK_SCOPED.map((s) => s.name),
  ...RUN_SCOPED.map((s) => s.name),
  'task_execution_owners',
  'task_execution_intents',
  'task_execution_effects',
  'task_execution_effect_attempts',
  'task_execution_effect_fences',
  'task_execution_lineage_operation_records',
]

/** 会随删库级联消失、但**故意**不归档的表(理由见上)。加进来必须写清为什么。 */
export const ARCHIVE_EXEMPT_TABLES: readonly string[] = ['runtime_session_leases']

/** 一棵树的全部任务 id(root 优先,深度受 MAX_TREE_DEPTH 同款上限约束)。 */
export async function collectTree(db: DbClient, rootTaskId: string): Promise<string[]> {
  const out: string[] = [rootTaskId]
  let frontier = [rootTaskId]
  for (let depth = 0; frontier.length > 0 && depth < 64; depth += 1) {
    const children = await chunkedAll(frontier, (chunk) =>
      db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.parentTaskId, chunk)),
    )
    frontier = children.map((c) => c.id)
    out.push(...frontier)
  }
  return out
}

interface TreeCandidate {
  rootTaskId: string
  taskIds: string[]
  lastFinishedAt: number
}

/** 可归档的树:整树全终态,且 max(finishedAt) 早于 cutoff。 */
export async function findArchivableTrees(
  db: DbClient,
  cutoff: number,
  limit: number,
): Promise<TreeCandidate[]> {
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
    const rows = await chunkedAll(taskIds, (chunk) =>
      db
        .select({ id: tasks.id, status: tasks.status, finishedAt: tasks.finishedAt })
        .from(tasks)
        .where(inArray(tasks.id, chunk)),
    )
    // 整树判据:任一后代非终态 / 未完成 / 仍在保留期内 ⇒ 整树跳过。
    const allTerminal = rows.every(
      (r) => (TERMINAL as readonly string[]).includes(r.status) && r.finishedAt !== null,
    )
    if (!allTerminal) continue
    const lastFinishedAt = Math.max(...rows.map((r) => r.finishedAt ?? 0))
    if (lastFinishedAt > cutoff) continue
    out.push({ rootTaskId: root.id, taskIds, lastFinishedAt })
    if (out.length >= limit) break
  }
  return out
}

function writeJsonl(file: string, rows: readonly unknown[]): void {
  if (rows.length === 0) return
  let buf = ''
  for (const row of rows) buf += JSON.stringify(row) + '\n'
  appendFileSync(file, buf, 'utf-8')
}

async function exportTable(
  db: DbClient,
  dir: string,
  name: string,
  rows: readonly unknown[],
): Promise<number> {
  if (rows.length === 0) return 0
  const file = join(dir, `${name}.jsonl`)
  for (let i = 0; i < rows.length; i += EXPORT_BATCH) {
    writeJsonl(file, rows.slice(i, i + EXPORT_BATCH))
  }
  return rows.length
}

/**
 * Export and finalize an already-claimed tree.  Retrying the same durable
 * claim preserves any runs/logs directories that were moved before a crash;
 * only reproducible DB JSONL files are rebuilt.
 */
async function archiveClaimedTree(
  db: DbClient,
  rootTaskId: string,
  taskIds: readonly string[],
  initialClaim: TerminalMaintenanceClaim,
  opts: TaskArchiveOptions = {},
): Promise<ArchivedTree> {
  const archiveRoot = opts.archiveDir ?? Paths.taskArchiveDir
  const runsRoot = opts.runsDir ?? Paths.runsDir
  const logsRoot = opts.logsDir ?? Paths.logsDir
  const now = opts.now ?? Date.now()
  const tmpDir = join(archiveRoot, `.tmp-${rootTaskId}`)
  const finalDir = join(archiveRoot, rootTaskId)
  if (existsSync(finalDir)) {
    throw new Error(`archive destination already exists for task '${rootTaskId}'`)
  }
  if (existsSync(join(tmpDir, 'db'))) {
    rmSync(join(tmpDir, 'db'), { recursive: true, force: true })
  }
  if (existsSync(join(tmpDir, 'manifest.json'))) {
    rmSync(join(tmpDir, 'manifest.json'), { force: true })
  }
  mkdirSync(join(tmpDir, 'db'), { recursive: true })

  const rowCounts: Record<string, number> = {}

  const taskRows = await chunkedAll(taskIds, (chunk) =>
    db.select().from(tasks).where(inArray(tasks.id, chunk)),
  )
  rowCounts.tasks = await exportTable(db, join(tmpDir, 'db'), 'tasks', taskRows)

  for (const spec of TASK_SCOPED) {
    rowCounts[spec.name] = await exportTable(
      db,
      join(tmpDir, 'db'),
      spec.name,
      await spec.load(db, taskIds),
    )
  }

  const runRows = await chunkedAll(taskIds, (chunk) =>
    db.select().from(nodeRuns).where(inArray(nodeRuns.taskId, chunk)),
  )
  rowCounts.node_runs = await exportTable(db, join(tmpDir, 'db'), 'node_runs', runRows)
  const runIds = runRows.map((r) => r.id)
  for (const spec of RUN_SCOPED) {
    rowCounts[spec.name] = await exportTable(
      db,
      join(tmpDir, 'db'),
      spec.name,
      await spec.load(db, runIds),
    )
  }

  const executionLedgers = await loadExecutionLedgers(db, taskIds)
  for (const [name, rows] of Object.entries(executionLedgers.rows)) {
    rowCounts[name] = await exportTable(db, join(tmpDir, 'db'), name, rows)
  }

  // runs/ 与 logs/ 整体挪入(而不是复制+删除:大目录复制会把归档变成一次长 IO)。
  for (const [kind, root] of [
    ['runs', runsRoot],
    ['logs', logsRoot],
  ] as const) {
    const destRoot = join(tmpDir, kind)
    let moved = 0
    for (const id of taskIds) {
      const src = join(root, id)
      const dest = join(destRoot, id)
      if (existsSync(dest)) {
        moved += 1
        continue
      }
      if (!existsSync(src)) continue
      mkdirSync(destRoot, { recursive: true })
      renameSync(src, dest)
      moved += 1
    }
    rowCounts[`${kind}_dirs`] = moved
  }

  const claimRow = db
    .select()
    .from(taskExecutionMaintenanceClaims)
    .where(eq(taskExecutionMaintenanceClaims.id, initialClaim.claimId))
    .get()
  const claimMembers = db
    .select()
    .from(taskExecutionMaintenanceMembers)
    .where(eq(taskExecutionMaintenanceMembers.claimId, initialClaim.claimId))
    .orderBy(taskExecutionMaintenanceMembers.taskId)
    .all()
  if (claimRow === undefined) throw new Error(`archive claim '${initialClaim.claimId}' disappeared`)

  const manifest = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    rootTaskId,
    taskIds,
    exportedAt: new Date(now).toISOString(),
    rows: rowCounts,
    terminalMaintenance: {
      claim: claimRow,
      members: claimMembers,
    },
    // 校验和覆盖「导出了什么」这一事实本身,便于事后确认目录未被截断。
    digest: sha256Hex(
      JSON.stringify({
        rootTaskId,
        taskIds,
        rows: rowCounts,
        maintenanceClaimId: claimRow.id,
        memberSetDigest: claimRow.memberSetDigest,
      }),
    ),
  }
  writeFileSync(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')

  // 全部落盘成功后才 rename;rename 之后库里的行才允许删。
  renameSync(tmpDir, finalDir)

  let maintenanceClaim = taskExecutionModule.terminalMaintenance.transition({
    db,
    claim: initialClaim,
    to: 'io-complete',
    now,
  })
  maintenanceClaim = deleteTreeRows(db, rootTaskId, taskIds, maintenanceClaim, now)
  taskExecutionModule.terminalMaintenance.complete({ db, claim: maintenanceClaim, now })

  log.info('archived task tree', { rootTaskId, tasks: taskIds.length, dir: finalDir })
  return { rootTaskId, taskIds: [...taskIds], rows: rowCounts, dir: finalDir }
}

/**
 * 归档一棵树。maintenance claim 在任何 mkdir/rename 前提交；任一步失败都保留
 * exact claim 与 cleanup plan，boot/sweeper 可从同一 revision 继续。
 */
export async function archiveTaskTree(
  db: DbClient,
  rootTaskId: string,
  opts: TaskArchiveOptions = {},
): Promise<ArchivedTree> {
  const archiveRoot = opts.archiveDir ?? Paths.taskArchiveDir
  const runsRoot = opts.runsDir ?? Paths.runsDir
  const logsRoot = opts.logsDir ?? Paths.logsDir
  const members = taskExecutionModule.terminalMaintenance.snapshotTree(db, rootTaskId)
  const taskIds = members.map((member) => member.taskId)
  const claim = taskExecutionModule.terminalMaintenance.claim({
    db,
    rootTaskId,
    // A scheduled retention pass and an actor-requested archive share the
    // exact export implementation, but retain distinct durable authorities.
    // This makes recovery/audit state say why the tree left the live store.
    operation: opts.source === 'sweep' ? 'retention' : 'archive',
    members,
    cleanupPlanJson: JSON.stringify({
      v: 2,
      rootTaskId,
      archiveRoot,
      runsRoot,
      logsRoot,
    }),
    now: opts.now,
  })
  return archiveClaimedTree(db, rootTaskId, taskIds, claim, opts)
}

/** 删库:一个事务、子先父后(FK 级联仍然生效,这里显式删非 FK 的软链接行)。 */
function deleteTreeRows(
  db: DbClient,
  rootTaskId: string,
  taskIds: readonly string[],
  claim: TerminalMaintenanceClaim,
  now: number,
): TerminalMaintenanceClaim {
  return dbTxSync(db, (tx) => {
    taskExecutionModule.terminalMaintenance.assertClaimTx({
      tx,
      claim,
      expectedState: 'io-complete',
    })
    const currentIds = (
      tx.all(sql`
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM tasks WHERE id = ${rootTaskId}
          UNION
          SELECT child.id FROM tasks child JOIN tree parent ON child.parent_task_id = parent.id
        )
        SELECT id FROM tree ORDER BY id
      `) as Array<{ id: string }>
    ).map((row) => row.id)
    if (JSON.stringify(currentIds) !== JSON.stringify([...taskIds].sort())) {
      throw new Error(`archive task tree changed after claim '${claim.claimId}'`)
    }
    for (let i = 0; i < taskIds.length; i += 200) {
      const chunk = [...taskIds].slice(i, i + 200)
      tx.delete(taskFeedback).where(inArray(taskFeedback.taskId, chunk)).run()
      // 后代先删:同一棵树里子任务的 parent_task_id 指向父,反序删除避免
      // 触发外键顺序问题(SQLite 的 FK 在同一事务内延迟检查,但显式反序更稳)。
      tx.delete(tasks).where(inArray(tasks.id, chunk)).run()
    }
    return taskExecutionModule.terminalMaintenance.transitionTx({
      tx,
      claim,
      to: 'db-finalized',
      now,
    })
  })
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

function restoreLegacyMovedDirectories(
  tmpDir: string,
  kind: 'runs' | 'logs',
  root: string,
): boolean {
  const movedRoot = join(tmpDir, kind)
  if (!existsSync(movedRoot)) return true
  mkdirSync(root, { recursive: true })
  for (const entry of readdirSync(movedRoot)) {
    const from = join(movedRoot, entry)
    const to = join(root, entry)
    if (existsSync(to)) return false
    renameSync(from, to)
  }
  return true
}

/**
 * Boot recovery first resumes RFC-328 durable archive claims, then handles
 * pre-RFC-328 `.tmp-*` directories.  A partial move is never discarded until
 * its runs/logs directories have been restored.
 */
export async function recoverInterruptedArchives(
  db: DbClient,
  opts: TaskArchiveOptions = {},
): Promise<{ promoted: string[]; discarded: string[] }> {
  const archiveRoot = opts.archiveDir ?? Paths.taskArchiveDir
  const promoted: string[] = []
  const discarded: string[] = []
  const recoverable = [
    ...taskExecutionModule.terminalMaintenance.listRecoverable({ db, operation: 'archive' }),
    ...taskExecutionModule.terminalMaintenance.listRecoverable({ db, operation: 'retention' }),
  ]
  const claimedRoots = new Set<string>()
  for (const item of recoverable) {
    claimedRoots.add(item.rootTaskId)
    const plan = parseArchiveCleanupPlan(item.cleanupPlanJson)
    if (plan === null || plan.archiveRoot !== archiveRoot) continue
    const claimOpts: TaskArchiveOptions = {
      ...opts,
      archiveDir: plan.archiveRoot,
      runsDir: plan.runsRoot,
      logsDir: plan.logsRoot,
    }
    const tmpDir = join(plan.archiveRoot, `.tmp-${item.rootTaskId}`)
    const finalDir = join(plan.archiveRoot, item.rootTaskId)
    const root = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, item.rootTaskId))
      .get()
    let claim = item.claim
    let state = item.state

    if (state === 'recovery-required') {
      if (existsSync(finalDir)) {
        claim = taskExecutionModule.terminalMaintenance.transition({
          db,
          claim,
          to: root === undefined ? 'db-finalized' : 'io-complete',
        })
        state = root === undefined ? 'db-finalized' : 'io-complete'
      } else if (root !== undefined) {
        claim = taskExecutionModule.terminalMaintenance.transition({
          db,
          claim,
          to: 'claimed',
        })
        state = 'claimed'
      } else {
        continue
      }
    }

    if (state === 'claimed' && !existsSync(finalDir)) {
      if (root === undefined) continue
      const archived = await archiveClaimedTree(
        db,
        item.rootTaskId,
        item.members.map((member) => member.taskId),
        claim,
        claimOpts,
      )
      promoted.push(archived.rootTaskId)
      continue
    }

    if (state === 'claimed') {
      claim = taskExecutionModule.terminalMaintenance.transition({
        db,
        claim,
        to: 'io-complete',
      })
      state = 'io-complete'
    }
    if (state === 'io-complete') {
      if (!existsSync(finalDir) && existsSync(join(tmpDir, 'manifest.json'))) {
        renameSync(tmpDir, finalDir)
        promoted.push(item.rootTaskId)
      }
      if (!existsSync(finalDir)) {
        taskExecutionModule.terminalMaintenance.transition({
          db,
          claim,
          to: 'recovery-required',
        })
        continue
      }
      claim =
        root === undefined
          ? taskExecutionModule.terminalMaintenance.transition({
              db,
              claim,
              to: 'db-finalized',
            })
          : deleteTreeRows(
              db,
              item.rootTaskId,
              item.members.map((member) => member.taskId),
              claim,
              Date.now(),
            )
      state = 'db-finalized'
    }
    if (state === 'db-finalized' || state === 'cleanup-pending') {
      if (!existsSync(finalDir)) {
        taskExecutionModule.terminalMaintenance.transition({
          db,
          claim,
          to: 'recovery-required',
        })
        continue
      }
      taskExecutionModule.terminalMaintenance.complete({ db, claim })
    }
  }

  if (!existsSync(archiveRoot)) return { promoted, discarded }
  for (const entry of readdirSync(archiveRoot)) {
    if (!entry.startsWith('.tmp-')) continue
    const rootTaskId = entry.slice('.tmp-'.length)
    if (claimedRoots.has(rootTaskId)) continue
    const tmpDir = join(archiveRoot, entry)
    const stillInDb = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, rootTaskId))
      .get()
    if (stillInDb !== undefined) {
      const runsRestored = restoreLegacyMovedDirectories(
        tmpDir,
        'runs',
        opts.runsDir ?? Paths.runsDir,
      )
      const logsRestored = restoreLegacyMovedDirectories(
        tmpDir,
        'logs',
        opts.logsDir ?? Paths.logsDir,
      )
      if (runsRestored && logsRestored) {
        rmSync(tmpDir, { recursive: true, force: true })
        discarded.push(rootTaskId)
      }
      continue
    }
    const finalDir = join(archiveRoot, rootTaskId)
    if (existsSync(finalDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
      discarded.push(rootTaskId)
      continue
    }
    renameSync(tmpDir, finalDir)
    promoted.push(rootTaskId)
  }
  if (promoted.length > 0 || discarded.length > 0) {
    log.info('recovered interrupted archives', { promoted, discarded })
  }
  return { promoted, discarded }
}

export interface TaskArchiveConfig {
  enabled: boolean
  retentionDays: number
  /** 单轮最多归档多少棵树(有界工作量,同归档器的 tick 预算)。 */
  maxTreesPerSweep?: number
}

/**
 * 写一行归档审计。**不进任务级联族**(见 schema 注释):被记录的任务行马上就要被
 * 删掉,审计必须活得比它们久,否则「谁归档了多少」随归档一起消失。
 */
async function writeArchiveAudit(
  db: DbClient,
  row: {
    source: ArchiveSource
    actorUserId: string | null
    retentionDays: number
    result: ArchiveSweepResult
    now: number
  },
): Promise<void> {
  await db.insert(taskArchiveAudit).values({
    id: ulid(),
    source: row.source,
    actorUserId: row.actorUserId,
    retentionDays: row.retentionDays,
    treeCount: row.result.archived.length,
    taskCount: row.result.archived.reduce((sum, tree) => sum + tree.taskIds.length, 0),
    skippedCount: row.result.skipped,
    rootTaskIdsJson: JSON.stringify(row.result.archived.map((tree) => tree.rootTaskId)),
    createdAt: row.now,
  })
}

/** 一轮归档扫描。默认关闭;`enabled=false` 或 `retentionDays<=0` 直接返回。 */
export async function runTaskArchiveSweep(
  db: DbClient,
  config: TaskArchiveConfig,
  opts: TaskArchiveOptions = {},
): Promise<ArchiveSweepResult> {
  if (!config.enabled || config.retentionDays <= 0) return { archived: [], skipped: 0 }
  const now = opts.now ?? Date.now()
  const cutoff = now - config.retentionDays * 86_400_000
  const limit = config.maxTreesPerSweep ?? 50
  const candidates = await findArchivableTrees(db, cutoff, limit)
  const archived: ArchivedTree[] = []
  let skipped = 0
  for (const candidate of candidates) {
    try {
      archived.push(
        await archiveTaskTree(db, candidate.rootTaskId, {
          ...opts,
          source: opts.source ?? 'sweep',
        }),
      )
    } catch (err) {
      // 落盘失败(磁盘满/权限)⇒ 库内不删,留待下一轮;不阻塞其它树。
      skipped += 1
      log.warn('archive failed; database left intact', {
        rootTaskId: candidate.rootTaskId,
        error: (err as Error).message,
      })
    }
  }
  const result = { archived, skipped }
  const source = opts.source ?? 'sweep'
  // 手动执行**每次都留痕**(哪怕这次一棵树都没归档——「某人在某时对全库执行了一次
  // 归档」本身就是要留的事实;dry-run 预览不走这里,自然也不写);hourly sweeper 反过来
  // 只在真动了数据时写,否则默认开启后每小时一行空审计会把这张表撑成噪音。
  if (source === 'manual' || archived.length > 0 || skipped > 0) {
    await writeArchiveAudit(db, {
      source,
      actorUserId: opts.actorUserId ?? null,
      retentionDays: config.retentionDays,
      result,
      now,
    })
  }
  return result
}

export interface ManualArchiveRequest {
  /** 保留期(天);省略则用配置里的 taskArchive.retentionDays。 */
  retentionDays: number
  /** 本次最多归档多少棵树。 */
  maxTrees: number
  /** 操作者(审计行记录);系统调用传 null。 */
  actorUserId: string | null
}

/**
 * 手动批量归档(admin API / 设置页维护区)。与 sweeper 走同一条管线,区别只有两点:
 * **忽略 `enabled` 开关**(手动入口的意义就是开关关着也能清一次)、审计行 source='manual'
 * 且带操作者。
 */
export async function runManualTaskArchive(
  db: DbClient,
  req: ManualArchiveRequest,
  opts: TaskArchiveOptions = {},
): Promise<ArchiveSweepResult> {
  return runTaskArchiveSweep(
    db,
    {
      enabled: true,
      retentionDays: req.retentionDays,
      maxTreesPerSweep: req.maxTrees,
    },
    { ...opts, source: 'manual', actorUserId: req.actorUserId },
  )
}

/**
 * hourly ticker(config 每拍热读,与归档器/保留 sweeper 同款约定)。
 *
 * RFC-311 余项（2026-08-21）：与事件归档器同一个洞——只有 `setInterval(1h)` 的
 * 循环，在平均重启间隔短于一个周期的部署上一次都不会执行，于是"终态任务超期出库"
 * 这条体积封顶的执行者形同虚设。首拍延迟见
 * `MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS`。
 */
export function startTaskArchiveSweeper(
  db: DbClient,
  loadConfig: () => TaskArchiveConfig,
  intervalMs: number = HOUR_MS,
  bootDelayMs: number = MAINTENANCE_BOOT_FIRST_PASS_DELAY_MS,
  // RFC-322：与 boot 首拍正交的相位偏移，见 MAINTENANCE_PHASE。
  phaseOffsetMs: number = MAINTENANCE_PHASE.taskArchive,
): { stop: () => void } {
  return startMaintenanceTicker({
    job: 'taskArchive',
    intervalMs,
    phaseOffsetMs,
    bootDelayMs,
    onTick: () =>
      runTaskArchiveSweep(db, loadConfig()).catch((err) =>
        log.warn('archive sweep threw', { error: (err as Error).message }),
      ),
  })
}

/** 供 CLI / admin API 使用:按条件预览可归档的树,不动任何数据。 */
export async function previewArchivableTrees(
  db: DbClient,
  retentionDays: number,
  limit: number = 50,
  now: number = Date.now(),
): Promise<Array<{ rootTaskId: string; taskCount: number; lastFinishedAt: number }>> {
  if (retentionDays <= 0) return []
  const cutoff = now - retentionDays * 86_400_000
  const trees = await findArchivableTrees(db, cutoff, limit)
  return trees.map((t) => ({
    rootTaskId: t.rootTaskId,
    taskCount: t.taskIds.length,
    lastFinishedAt: t.lastFinishedAt,
  }))
}

// 未使用但保留的导入位:sql / eq 供后续 manifest 校验扩展。
void sql
