import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import { TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'

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
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'
import type {
  ArchivedTaskTreeReceipt,
  TaskArchiveConfig,
  TaskArchiveMaintenanceCommand,
  TaskArchiveMaintenanceOptions,
  TaskArchiveManualRequest,
  TaskArchivePreviewTree,
  TaskArchiveSweepReceipt,
} from '../application/ports/taskArchiveMaintenanceCommand'
import { PostgresqlTerminalMaintenancePersistence } from './postgresqlTerminalMaintenancePersistence'
import { createTerminalMaintenanceClaim, type TerminalMaintenanceClaim } from '../domain/ownership'
import { retryPostgresqlSerialization } from '@/db/postgresqlSerializationRetry'

const log = createLogger('task-archive-postgresql')
const ARCHIVE_SCHEMA_VERSION = 2
// RFC-350：与 shared 的 `TERMINAL_TASK_STATUSES` 对齐。此前这里是一份手抄的三元素
// 字面量，漏掉了 `interrupted`——而 orphan reaper 把 daemon 重启时在跑的任务翻成
// interrupted 时**是写了 finished_at 的**（modules/task-execution/composition/
// taskExecutionPersistence.ts）。漏掉的后果是：每次 daemon 重启残留的那批任务既
// 不能被取消（cancel 事件的 allowed-from 不含 interrupted），又永远等不到归档，
// 成为库里唯一一类永久居民。
const TERMINAL = TERMINAL_TASK_STATUSES
const BATCH_SIZE = 2_000

type PgTx = Parameters<Parameters<PostgresqlDatabaseClient['transaction']>[0]>[0]
type ArchiveOptions = TaskArchiveMaintenanceOptions & { readonly source?: 'sweep' | 'manual' }

async function inChunks<T>(
  values: readonly string[],
  load: (chunk: readonly string[]) => Promise<readonly T[]>,
): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
    rows.push(...(await load(values.slice(offset, offset + BATCH_SIZE))))
  }
  return rows
}

async function collectTree(
  db: PostgresqlDatabaseClient | PgTx,
  rootTaskId: string,
): Promise<string[]> {
  const out = [rootTaskId]
  const seen = new Set(out)
  let frontier = [rootTaskId]
  for (let depth = 0; frontier.length > 0 && depth < 64; depth += 1) {
    const children = await inChunks(
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

async function findCandidates(
  db: PostgresqlDatabaseClient,
  cutoff: number,
  limit: number,
): Promise<
  readonly {
    readonly rootTaskId: string
    readonly taskIds: readonly string[]
    readonly lastFinishedAt: number
  }[]
> {
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
  const out: Array<{
    rootTaskId: string
    taskIds: readonly string[]
    lastFinishedAt: number
  }> = []
  for (const root of roots) {
    const taskIds = await collectTree(db, root.id)
    const rows = await inChunks(
      taskIds,
      async (chunk) =>
        await db
          .select({ status: tasks.status, finishedAt: tasks.finishedAt })
          .from(tasks)
          .where(inArray(tasks.id, chunk)),
    )
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
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    appendFileSync(
      path,
      rows
        .slice(offset, offset + BATCH_SIZE)
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
      'utf8',
    )
  }
  return rows.length
}

async function loadArchiveRows(
  db: PostgresqlDatabaseClient,
  taskIds: readonly string[],
): Promise<Readonly<Record<string, readonly unknown[]>>> {
  const byTask = <T>(load: (ids: readonly string[]) => Promise<readonly T[]>) =>
    inChunks(taskIds, load)
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
  const attemptRows = await inChunks(
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
  for (const row of await inChunks(
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
    collaboration_gate_artifacts: await inChunks(
      operationIds,
      async (ids) =>
        await db
          .select()
          .from(collaborationGateArtifacts)
          .where(inArray(collaborationGateArtifacts.operationId, ids)),
    ),
    doc_versions: documentRows,
    review_comments: await inChunks(
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
    node_run_outputs: await inChunks(
      runIds,
      async (ids) =>
        await db.select().from(nodeRunOutputs).where(inArray(nodeRunOutputs.nodeRunId, ids)),
    ),
    node_run_events: await inChunks(
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
    task_execution_effect_fences: await inChunks(
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

async function finalizeDatabase(
  db: PostgresqlDatabaseClient,
  rootTaskId: string,
  taskIds: readonly string[],
  claim: TerminalMaintenanceClaim,
  now: number,
): Promise<TerminalMaintenanceClaim> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await tx.run(sql.raw('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'))
        const claimRows = await tx
          .select()
          .from(taskExecutionMaintenanceClaims)
          .where(eq(taskExecutionMaintenanceClaims.id, claim.claimId))
          .limit(1)
        const row = claimRows[0]
        if (
          row === undefined ||
          row.state !== 'io-complete' ||
          row.operation !== claim.operation ||
          row.revision !== claim.revision ||
          row.memberSetDigest !== claim.memberSetDigest
        ) {
          throw new Error(`archive claim '${claim.claimId}' changed before database finalize`)
        }
        const currentIds = (await collectTree(tx, rootTaskId)).sort()
        const expectedIds = [...taskIds].sort()
        if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
          throw new Error(`archive task tree changed after claim '${claim.claimId}'`)
        }
        for (let offset = 0; offset < expectedIds.length; offset += BATCH_SIZE) {
          const chunk = expectedIds.slice(offset, offset + BATCH_SIZE)
          await tx.delete(taskFeedback).where(inArray(taskFeedback.taskId, chunk)).run()
          await tx.delete(tasks).where(inArray(tasks.id, chunk)).run()
        }
        const nextRevision = claim.revision + 1
        const changed = await tx
          .update(taskExecutionMaintenanceClaims)
          .set({ state: 'db-finalized', revision: nextRevision, updatedAt: now })
          .where(
            and(
              eq(taskExecutionMaintenanceClaims.id, claim.claimId),
              eq(taskExecutionMaintenanceClaims.state, 'io-complete'),
              eq(taskExecutionMaintenanceClaims.revision, claim.revision),
            ),
          )
          .returning({ id: taskExecutionMaintenanceClaims.id })
        if (changed[0] === undefined) {
          throw new Error(`archive claim '${claim.claimId}' database finalize lost`)
        }
        return createTerminalMaintenanceClaim({
          claimId: claim.claimId,
          operation: claim.operation,
          revision: nextRevision,
          memberSetDigest: claim.memberSetDigest,
        })
      })
    } catch (error) {
      if (await retryPostgresqlSerialization(attempt, error)) continue
      throw error
    }
  }
}

async function archiveClaimed(
  db: PostgresqlDatabaseClient,
  maintenance: PostgresqlTerminalMaintenancePersistence,
  rootTaskId: string,
  taskIds: readonly string[],
  initialClaim: TerminalMaintenanceClaim,
  options: ArchiveOptions,
): Promise<ArchivedTaskTreeReceipt> {
  const now = options.now ?? Date.now()
  const tmpDir = join(options.archiveDir, `.tmp-${rootTaskId}`)
  const finalDir = join(options.archiveDir, rootTaskId)
  if (existsSync(finalDir))
    throw new Error(`archive destination already exists for task '${rootTaskId}'`)
  rmSync(join(tmpDir, 'db'), { recursive: true, force: true })
  rmSync(join(tmpDir, 'manifest.json'), { force: true })
  mkdirSync(join(tmpDir, 'db'), { recursive: true })

  const rows = await loadArchiveRows(db, taskIds)
  const counts: Record<string, number> = {}
  for (const [name, tableRows] of Object.entries(rows)) {
    counts[name] = writeJsonl(join(tmpDir, 'db', `${name}.jsonl`), tableRows)
  }
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
  const manifestBase = {
    rootTaskId,
    taskIds: [...taskIds],
    rows: counts,
    maintenanceClaimId: claimRow.id,
    memberSetDigest: claimRow.memberSetDigest,
  }
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
        digest: sha256Hex(JSON.stringify(manifestBase)),
      },
      null,
      2,
    ),
    'utf8',
  )
  renameSync(tmpDir, finalDir)
  const ioClaim = await maintenance.transition({ claim: initialClaim, to: 'io-complete', now })
  const finalized = await finalizeDatabase(db, rootTaskId, taskIds, ioClaim, now)
  await maintenance.complete({ claim: finalized, now })
  return { rootTaskId, taskIds: [...taskIds], rows: counts, dir: finalDir }
}

async function archiveTree(
  db: PostgresqlDatabaseClient,
  maintenance: PostgresqlTerminalMaintenancePersistence,
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

async function recoverCompletedIo(
  db: PostgresqlDatabaseClient,
  maintenance: PostgresqlTerminalMaintenancePersistence,
  options: ArchiveOptions,
): Promise<void> {
  const recoverable = [
    ...(await maintenance.listRecoverable({ operation: 'archive' })),
    ...(await maintenance.listRecoverable({ operation: 'retention' })),
  ]
  for (const item of recoverable) {
    let claim = item.claim
    let state = item.state
    const finalDir = join(options.archiveDir, item.rootTaskId)
    const rootRows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.id, item.rootTaskId))
      .limit(1)
    const rootExists = rootRows[0] !== undefined
    const members = item.members.map((member) => member.taskId)
    if (state === 'recovery-required' && existsSync(finalDir)) {
      claim = await maintenance.transition({
        claim,
        to: rootExists ? 'io-complete' : 'db-finalized',
      })
      state = rootExists ? 'io-complete' : 'db-finalized'
    }
    if (state === 'recovery-required' && !existsSync(finalDir) && rootExists) {
      claim = await maintenance.transition({ claim, to: 'claimed' })
      state = 'claimed'
    }
    if (state === 'claimed' && !existsSync(finalDir)) {
      if (!rootExists) continue
      await archiveClaimed(db, maintenance, item.rootTaskId, members, claim, options)
      continue
    }
    if (state === 'claimed' && existsSync(finalDir)) {
      claim = await maintenance.transition({ claim, to: 'io-complete' })
      state = 'io-complete'
    }
    if (state === 'io-complete' && !existsSync(finalDir)) {
      await maintenance.transition({ claim, to: 'recovery-required' })
      continue
    }
    if (state === 'io-complete' && rootExists) {
      claim = await finalizeDatabase(db, item.rootTaskId, members, claim, Date.now())
      state = 'db-finalized'
    } else if (state === 'io-complete' && !rootExists) {
      claim = await maintenance.transition({ claim, to: 'db-finalized' })
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
}

export function createPostgresqlTaskArchiveMaintenanceCommand(
  db: PostgresqlDatabaseClient,
): TaskArchiveMaintenanceCommand {
  const maintenance = new PostgresqlTerminalMaintenancePersistence(db)
  return Object.freeze({
    async runSweep(
      config: TaskArchiveConfig,
      options: TaskArchiveMaintenanceOptions,
    ): Promise<TaskArchiveSweepReceipt> {
      if (!config.enabled || config.retentionDays <= 0) return { archived: [], skipped: 0 }
      await recoverCompletedIo(db, maintenance, options)
      const now = options.now ?? Date.now()
      const candidates = await findCandidates(
        db,
        now - config.retentionDays * 86_400_000,
        config.maxTreesPerSweep ?? 50,
      )
      const archived: ArchivedTaskTreeReceipt[] = []
      let skipped = 0
      for (const candidate of candidates) {
        try {
          archived.push(
            await archiveTree(db, maintenance, candidate.rootTaskId, {
              ...options,
              source: 'sweep',
            }),
          )
        } catch (error) {
          skipped += 1
          log.warn('archive failed; PostgreSQL rows left intact', {
            rootTaskId: candidate.rootTaskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      if (archived.length > 0 || skipped > 0) {
        await db
          .insert(taskArchiveAudit)
          .values({
            id: ulid(),
            source: 'sweep',
            actorUserId: null,
            retentionDays: config.retentionDays,
            treeCount: archived.length,
            taskCount: archived.reduce((sum, tree) => sum + tree.taskIds.length, 0),
            skippedCount: skipped,
            rootTaskIdsJson: JSON.stringify(archived.map((tree) => tree.rootTaskId)),
            createdAt: now,
          })
          .run()
      }
      return { archived, skipped }
    },
    async preview(
      input: Parameters<TaskArchiveMaintenanceCommand['preview']>[0],
    ): Promise<readonly TaskArchivePreviewTree[]> {
      if (input.retentionDays <= 0) return []
      const now = input.now ?? Date.now()
      const candidates = await findCandidates(
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
    async runManual(
      input: TaskArchiveManualRequest,
      options: TaskArchiveMaintenanceOptions,
    ): Promise<TaskArchiveSweepReceipt> {
      const now = input.now ?? options.now ?? Date.now()
      const effectiveOptions = { ...options, now }
      await recoverCompletedIo(db, maintenance, effectiveOptions)
      const candidates = await findCandidates(
        db,
        now - input.retentionDays * 86_400_000,
        input.maxTrees,
      )
      const archived: ArchivedTaskTreeReceipt[] = []
      let skipped = 0
      for (const candidate of candidates) {
        try {
          archived.push(
            await archiveTree(db, maintenance, candidate.rootTaskId, {
              ...effectiveOptions,
              source: 'manual',
            }),
          )
        } catch (error) {
          skipped += 1
          log.warn('manual archive failed; PostgreSQL rows left intact', {
            rootTaskId: candidate.rootTaskId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      await db
        .insert(taskArchiveAudit)
        .values({
          id: ulid(),
          source: 'manual',
          actorUserId: input.actorUserId,
          retentionDays: input.retentionDays,
          treeCount: archived.length,
          taskCount: archived.reduce((sum, tree) => sum + tree.taskIds.length, 0),
          skippedCount: skipped,
          rootTaskIdsJson: JSON.stringify(archived.map((tree) => tree.rootTaskId)),
          createdAt: now,
        })
        .run()
      return { archived, skipped }
    },
  })
}
