import { isTerminalTaskStatus, type TaskStatus } from '@agent-workflow/shared'

import { createLogger } from '@/util/log'
import type {
  WorkspaceMaintenanceFilesystem,
  WorkspaceMaintenanceStore,
  WorkspaceTaskRecord,
  WorkspaceTerminalMaintenance,
} from './ports/workspaceMaintenance'
import type {
  WorkspaceClaimFinalizationCommand,
  WorkspaceMaintenanceCommand,
} from '../public/commands'

type WorkspaceGcInput = Parameters<WorkspaceMaintenanceCommand['runGcPhase']>[0]
type WorkspaceGcReceipt = Awaited<ReturnType<WorkspaceMaintenanceCommand['runGcPhase']>>
type WorkspaceRecoveryInput = Parameters<WorkspaceMaintenanceCommand['recover']>[0]
type WorkspaceRecoveryReceipt = Awaited<ReturnType<WorkspaceMaintenanceCommand['recover']>>

const log = createLogger('workspace-maintenance')
const HOUR_MS = 60 * 60 * 1_000
export const WORKSPACE_PRUNING_LEASE_MS = 30 * 60 * 1_000
export const WORKSPACE_ORPHAN_MIN_AGE_MS = 24 * HOUR_MS

interface WorkspaceGcCleanupPlanV1 {
  readonly v: 1
  readonly kind: 'workspace-prune' | 'iso-container'
  readonly taskId: string
}

type RecoverableClaim = Awaited<ReturnType<WorkspaceTerminalMaintenance['listRecoverable']>>[number]

class WorkspaceMaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMaintenanceConflictError'
  }
}

function parseCleanupPlan(value: string): WorkspaceGcCleanupPlanV1 | null {
  try {
    const parsed = JSON.parse(value) as Partial<WorkspaceGcCleanupPlanV1>
    if (
      parsed.v !== 1 ||
      (parsed.kind !== 'workspace-prune' && parsed.kind !== 'iso-container') ||
      typeof parsed.taskId !== 'string'
    ) {
      return null
    }
    return parsed as WorkspaceGcCleanupPlanV1
  } catch {
    return null
  }
}

function isTerminal(task: WorkspaceTaskRecord): boolean {
  return isTerminalTaskStatus(task.status as TaskStatus)
}

function emptyReceipt(): WorkspaceGcReceipt {
  return { scanned: 0, removed: 0, skipped: 0 }
}

/**
 * Provider-neutral durable workspace cleanup. The application protocol owns
 * claim/recovery ordering; provider stores own SQL and the filesystem adapter
 * owns Git/worktree mechanics.
 */
export function createWorkspaceMaintenanceCommand(input: {
  readonly store: WorkspaceMaintenanceStore
  readonly terminalMaintenance: WorkspaceTerminalMaintenance
  readonly filesystem: WorkspaceMaintenanceFilesystem
}): WorkspaceMaintenanceCommand & WorkspaceClaimFinalizationCommand {
  const { store, terminalMaintenance, filesystem } = input
  const inFlight = new Set<string>()

  async function ensureClaim(
    plan: WorkspaceGcCleanupPlanV1,
    now: number,
  ): Promise<RecoverableClaim> {
    const existing = await terminalMaintenance.listRecoverable({
      operation: 'workspace-gc',
      rootTaskId: plan.taskId,
    })
    if (existing.length > 1) {
      throw new WorkspaceMaintenanceConflictError(
        `task '${plan.taskId}' has multiple active workspace maintenance claims`,
      )
    }
    const current = existing[0]
    if (current !== undefined) {
      const persisted = parseCleanupPlan(current.cleanupPlanJson)
      if (persisted?.kind !== plan.kind || persisted.taskId !== plan.taskId) {
        throw new WorkspaceMaintenanceConflictError(
          `task '${plan.taskId}' is already claimed by another workspace cleanup`,
        )
      }
      return current
    }

    const members = await terminalMaintenance.snapshotMembers([plan.taskId])
    const cleanupPlanJson = JSON.stringify(plan)
    const claim = await terminalMaintenance.claim({
      rootTaskId: plan.taskId,
      operation: 'workspace-gc',
      members,
      cleanupPlanJson,
      now,
    })
    return {
      claim,
      rootTaskId: plan.taskId,
      state: 'claimed',
      cleanupPlanJson,
      members,
    }
  }

  async function resumeClaim(item: RecoverableClaim, now: number): Promise<{ removed: boolean }> {
    const plan = parseCleanupPlan(item.cleanupPlanJson)
    if (plan === null || plan.taskId !== item.rootTaskId) {
      throw new Error(`workspace maintenance claim '${item.claim.claimId}' has an invalid plan`)
    }
    let claim = item.claim
    let state = item.state
    let removed = false

    if (state === 'recovery-required') {
      claim = await terminalMaintenance.transition({ claim, to: 'claimed', now })
      state = 'claimed'
    }

    if (state === 'claimed') {
      const task = (await store.listTasks([plan.taskId]))[0] ?? null
      if (plan.kind === 'workspace-prune') {
        if (task === null) {
          throw new WorkspaceMaintenanceConflictError(
            `task '${plan.taskId}' disappeared during workspace cleanup`,
          )
        }
        if (task.workspacePruningAt === null || !isTerminal(task)) {
          throw new WorkspaceMaintenanceConflictError(
            `task '${plan.taskId}' no longer owns a workspace-prune tombstone`,
          )
        }
        const repositories = task.repoCount > 1 ? await store.listTaskRepositories(plan.taskId) : []
        removed = await filesystem.removeWorkspace(task, repositories)
      } else {
        removed = await filesystem.removeIsoContainer(task, plan.taskId)
      }
      claim = await terminalMaintenance.transition({ claim, to: 'io-complete', now })
      state = 'io-complete'
    }

    if (state === 'io-complete') {
      if (plan.kind === 'workspace-prune') {
        if (!(await store.finalizeWorkspace(plan.taskId, now))) {
          throw new WorkspaceMaintenanceConflictError(
            `task '${plan.taskId}' lost its workspace-prune tombstone`,
          )
        }
        claim = await terminalMaintenance.transition({ claim, to: 'db-finalized', now })
      } else {
        // Transition first. If the process stops before releasing the transient
        // stamp, recovery re-enters the db-finalized branch and releases it;
        // releasing first could let a revive race a not-yet-finalized claim.
        claim = await terminalMaintenance.transition({ claim, to: 'db-finalized', now })
        if (!(await store.releaseIsoClaim(plan.taskId))) {
          throw new WorkspaceMaintenanceConflictError(
            `task '${plan.taskId}' lost its iso workspace claim`,
          )
        }
      }
      state = 'db-finalized'
    }

    if (state === 'db-finalized' || state === 'cleanup-pending') {
      if (plan.kind === 'iso-container' && !(await store.releaseIsoClaim(plan.taskId))) {
        throw new WorkspaceMaintenanceConflictError(
          `task '${plan.taskId}' lost its iso workspace claim`,
        )
      }
      await terminalMaintenance.complete({ claim, now })
    }
    return { removed }
  }

  async function finishClaimedWorkspace(
    taskId: string,
    now: number,
  ): Promise<
    'removed' | 'finalized-missing' | 'already-pruned' | 'not-claimed' | 'busy' | 'failed'
  > {
    if (inFlight.has(taskId)) return 'busy'
    inFlight.add(taskId)
    try {
      const task = (await store.listTasks([taskId]))[0]
      if (task === undefined) return 'already-pruned'
      const existing = await terminalMaintenance.listRecoverable({
        operation: 'workspace-gc',
        rootTaskId: taskId,
      })
      if (task.workspacePrunedAt !== null && existing.length === 0) return 'already-pruned'
      if (
        task.workspacePrunedAt === null &&
        (task.workspacePruningAt === null || !isTerminal(task))
      ) {
        return 'not-claimed'
      }
      const item = await ensureClaim({ v: 1, kind: 'workspace-prune', taskId }, now)
      const result = await resumeClaim(item, now)
      return result.removed ? 'removed' : 'finalized-missing'
    } catch (error) {
      if (error instanceof WorkspaceMaintenanceConflictError) return 'busy'
      log.warn('workspace prune failed (durable claim kept for recovery)', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      })
      return 'failed'
    } finally {
      inFlight.delete(taskId)
    }
  }

  async function runWorktree(input: WorkspaceGcInput, now: number): Promise<WorkspaceGcReceipt> {
    if (!input.worktreeAutoGc.enabled) return emptyReceipt()
    const minAgeMs =
      typeof input.worktreeAutoGc.olderThanDays === 'number' &&
      input.worktreeAutoGc.olderThanDays > 0
        ? input.worktreeAutoGc.olderThanDays * 24 * HOUR_MS
        : 0
    const active = new Set(input.activeTaskIds)
    const candidates = await store.listGcCandidates()
    let removed = 0
    let skipped = 0

    for (const task of candidates) {
      if (active.has(task.id)) {
        skipped += 1
        continue
      }
      if (task.worktreePath === '' || !filesystem.exists(task.worktreePath)) {
        if (task.workspacePruningAt !== null) {
          await finishClaimedWorkspace(task.id, now)
        } else if (task.worktreePath !== '') {
          await store.healMissingWorkspace(task.id, now)
        }
        skipped += 1
        continue
      }
      const finishedAt = task.finishedAt ?? task.startedAt
      if (minAgeMs > 0 && now - finishedAt < minAgeMs) {
        skipped += 1
        continue
      }
      if (input.worktreeAutoGc.onlyMerged === true && task.spaceKind !== 'scratch') {
        if (task.repoCount > 1) {
          const repositories = await store.listTaskRepositories(task.id)
          let allMerged = repositories.length > 0
          for (const repository of repositories) {
            if (
              !(await filesystem.isMerged(
                repository.worktreePath,
                repository.baseBranch,
                repository.branch,
              ))
            ) {
              allMerged = false
              break
            }
          }
          if (!allMerged) {
            skipped += 1
            continue
          }
        } else if (!(await filesystem.isMerged(task.worktreePath, task.baseBranch, task.branch))) {
          skipped += 1
          continue
        }
      }
      if (!(await store.claimWorkspace(task.id, now))) {
        skipped += 1
        continue
      }
      const outcome = await finishClaimedWorkspace(task.id, now)
      if (outcome === 'removed' || outcome === 'finalized-missing') removed += 1
      else skipped += 1
    }
    return { scanned: candidates.length, removed, skipped }
  }

  async function runIso(input: WorkspaceGcInput, now: number): Promise<WorkspaceGcReceipt> {
    const taskIds = filesystem.listIsoTaskIds()
    if (taskIds.length === 0) return emptyReceipt()
    const active = new Set(input.activeTaskIds)
    const tasks = new Map((await store.listTasks(taskIds)).map((task) => [task.id, task]))
    let removed = 0
    let skipped = 0

    for (const taskId of taskIds) {
      if (active.has(taskId)) {
        skipped += 1
        continue
      }
      const task = tasks.get(taskId) ?? null
      if (task !== null && (!isTerminal(task) || task.status === 'interrupted')) {
        skipped += 1
        continue
      }
      if (task !== null && (await store.hasLiveOrRevivableChild(taskId))) {
        skipped += 1
        continue
      }
      if (task !== null && task.workspacePrunedAt === null) {
        const existing = await terminalMaintenance.listRecoverable({
          operation: 'workspace-gc',
          rootTaskId: taskId,
        })
        if (existing.length > 1) {
          skipped += 1
          continue
        }
        let item = existing[0]
        if (
          item !== undefined &&
          parseCleanupPlan(item.cleanupPlanJson)?.kind !== 'iso-container'
        ) {
          skipped += 1
          continue
        }
        if (item === undefined) {
          if (!(await store.claimIsoWorkspace(taskId, now))) {
            skipped += 1
            continue
          }
          try {
            item = await ensureClaim({ v: 1, kind: 'iso-container', taskId }, now)
          } catch (error) {
            await store.releaseIsoClaim(taskId, now)
            log.warn('iso worktree GC could not acquire terminal maintenance', {
              taskId,
              error: error instanceof Error ? error.message : String(error),
            })
            skipped += 1
            continue
          }
        }
        if (inFlight.has(taskId)) {
          skipped += 1
          continue
        }
        inFlight.add(taskId)
        try {
          const result = await resumeClaim(item, now)
          if (result.removed) removed += 1
          else skipped += 1
        } catch (error) {
          log.warn('iso worktree GC failed (durable claim kept for recovery)', {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          })
          skipped += 1
        } finally {
          inFlight.delete(taskId)
        }
        continue
      }
      try {
        if (await filesystem.removeIsoContainer(task, taskId)) removed += 1
        else skipped += 1
      } catch (error) {
        log.warn('iso worktree GC failed', {
          taskId,
          error: error instanceof Error ? error.message : String(error),
        })
        skipped += 1
      }
    }
    return { scanned: taskIds.length, removed, skipped }
  }

  async function runScratch(now: number): Promise<WorkspaceGcReceipt> {
    const directories = filesystem.listScratchDirectories()
    if (directories.length === 0) return emptyReceipt()
    const anchored = await store.anchoredTaskIds(directories.map(({ taskId }) => taskId))
    let removed = 0
    let skipped = 0
    for (const directory of directories) {
      if (anchored.has(directory.taskId) || filesystem.isMaterializingTask(directory.taskId)) {
        skipped += 1
        continue
      }
      try {
        if (await filesystem.removeAgedPath(directory.path, now, WORKSPACE_ORPHAN_MIN_AGE_MS)) {
          removed += 1
        } else {
          skipped += 1
        }
      } catch (error) {
        log.warn('scratch orphan reap failed', {
          dir: directory.path,
          error: error instanceof Error ? error.message : String(error),
        })
        skipped += 1
      }
    }
    return { scanned: directories.length, removed, skipped }
  }

  async function runOrphan(now: number): Promise<WorkspaceGcReceipt> {
    const leaves = filesystem.listWorktreeLeaves()
    if (leaves.length === 0) return emptyReceipt()
    const anchored = await store.anchoredTaskIds(leaves.map(({ taskId }) => taskId))
    let removed = 0
    let skipped = 0
    for (const leaf of leaves) {
      if (anchored.has(leaf.taskId) || filesystem.isMaterializingTask(leaf.taskId)) {
        skipped += 1
        continue
      }
      try {
        if (await filesystem.removeAgedPath(leaf.path, now, WORKSPACE_ORPHAN_MIN_AGE_MS)) {
          removed += 1
        } else {
          skipped += 1
        }
      } catch (error) {
        log.warn('worktree orphan reap failed', {
          dir: leaf.path,
          error: error instanceof Error ? error.message : String(error),
        })
        skipped += 1
      }
    }
    return { scanned: leaves.length, removed, skipped }
  }

  async function recover(recoveryInput: WorkspaceRecoveryInput): Promise<WorkspaceRecoveryReceipt> {
    const now = recoveryInput.now ?? Date.now()
    const active = new Set(recoveryInput.activeTaskIds)
    let completed = 0
    let failed = 0
    let skipped = 0
    const interrupted = await terminalMaintenance.listRecoverable({ operation: 'workspace-gc' })
    for (const item of interrupted) {
      if (inFlight.has(item.rootTaskId)) {
        skipped += 1
        continue
      }
      inFlight.add(item.rootTaskId)
      try {
        await resumeClaim(item, now)
        completed += 1
      } catch (error) {
        failed += 1
        log.warn('workspace maintenance recovery failed', {
          taskId: item.rootTaskId,
          claimId: item.claim.claimId,
          error: error instanceof Error ? error.message : String(error),
        })
      } finally {
        inFlight.delete(item.rootTaskId)
      }
    }

    const webhookClaims = await store.listStaleWebhookClaims(now - WORKSPACE_PRUNING_LEASE_MS)
    for (const row of webhookClaims) {
      if (active.has(row.id) || inFlight.has(row.id)) {
        skipped += 1
        continue
      }
      if (!(await store.reclaimWebhookWorkspace(row.id, row.workspacePruningAt, now))) {
        skipped += 1
        continue
      }
      const outcome = await finishClaimedWorkspace(row.id, now)
      if (outcome === 'removed' || outcome === 'finalized-missing') completed += 1
      else if (outcome === 'failed') failed += 1
      else skipped += 1
    }
    return { completed, failed, skipped }
  }

  return Object.freeze({
    async runGcPhase(gcInput: WorkspaceGcInput): Promise<WorkspaceGcReceipt> {
      const now = gcInput.now ?? Date.now()
      switch (gcInput.phase) {
        case 'worktree':
          return await runWorktree(gcInput, now)
        case 'iso':
          return await runIso(gcInput, now)
        case 'scratch':
          return await runScratch(now)
        case 'orphan':
          return await runOrphan(now)
        case 'partial': {
          const receipt = await filesystem.runPartialCloneGc(now, gcInput.gitCloneTimeoutMs)
          return {
            scanned: receipt.scanned,
            removed: receipt.removed,
            skipped: receipt.scanned - receipt.removed,
          }
        }
      }
    },
    recover,
    async finalizeClaimedWorkspace(taskId: string, at?: number): Promise<void> {
      const outcome = await finishClaimedWorkspace(taskId, at ?? Date.now())
      if (outcome === 'failed') {
        throw new Error(`workspace-prune-finalization-failed:${taskId}`)
      }
    },
  })
}
