// RFC-211 — one-click cleanup of guided-onboarding sandbox artifacts.
//
// WHY THIS FILE EXISTS AT ALL
// ---------------------------
// The repo has no task-deletion capability, and `deleteWorkflow`'s
// `workflow-in-use` guard counts referencing tasks WITHOUT looking at status
// (services/workflow.ts countReferencingTasksInTx). So the moment a guide
// workflow is launched even once, it becomes permanently undeletable. "One
// click cleans up the example resources AND tasks" is therefore not a UI
// feature — it needs a real task-row delete, which is what deleteExampleTask
// below provides (scoped to `tasks.example = 1` only; this is NOT a general
// DELETE /api/tasks).
//
// ORDER IS LOAD-BEARING
// ---------------------
//   task → workgroup → workflow → agent → skill
// Anything else walks straight into a 409:
//   - workflow-in-use              (any task row, terminal included)
//   - agent-in-use                 (referenced by a workflow definition)
//   - agent-tasks-active           (a non-terminal task using the agent)
//   - skill-in-use                 (any agent listing the skill)
// workgroups have no reverse guard at all, so they can go first/anywhere.
//
// PARTIAL FAILURE IS NORMAL, NOT EXCEPTIONAL
// ------------------------------------------
// dbTxSync bodies must be synchronous, and this operation spans DB rows *and*
// the filesystem — one enclosing transaction is impossible by construction.
// The contract is per-item and retry-idempotent instead: every entry reports
// deleted/skipped/failed with the backend code, and pressing the button again
// simply re-runs against whatever is still flagged. A single stuck skill must
// never roll back nine successful deletes.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import {
  isTerminalTaskStatus,
  type ExampleCleanupItem,
  type ExampleCleanupResult,
  type ExampleInventory,
  type ExampleInventoryEntry,
  type TaskStatus,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  agents,
  nodeRuns,
  onboardingArtifacts,
  onboardingRuns,
  skills,
  taskRepos,
  tasks,
  workflows,
  workgroups,
} from '@/db/schema'
import { appHome } from '@/util/paths'
import { createLogger } from '@/util/log'
import { DomainError } from '@/util/errors'
import { killStaleRunProcessTree } from '@/util/process'
import { deleteSnapshotRefs, removeWorktree } from '@/util/git'
import { cancelTask, getTask } from '@/services/task'
import { claimWorkspacePrune } from '@/services/gc'
import { deleteAgent } from '@/services/agent'
import { deleteSkill, type SkillFsOptions } from '@/services/skill'
import { deleteWorkflow } from '@/services/workflow'
import { deleteWorkgroup } from '@/services/workgroups'

const log = createLogger('example-cleanup')

export interface ExampleCleanupDeps {
  skillFs: SkillFsOptions
}

/** How many times we re-read a task before giving up on driving it terminal. */
const CANCEL_SETTLE_ATTEMPTS = 8

/**
 * Collect every example resource in scope.
 *
 * Ownership is filtered in SQL ON PURPOSE. `isResourceOwner` returns true for
 * ANY admin (services/resourceAcl.ts), so leaning on `requireResourceOwner` to
 * scope "clean up my stuff" would silently turn an admin's personal cleanup
 * into an instance-wide purge that nukes everyone else's in-progress guide.
 * The ACL guard is the second net, never the only one.
 */
export async function collectExamples(
  db: DbClient,
  actor: Actor,
  scope: 'mine' | 'all',
): Promise<ExampleInventory> {
  const mine = scope === 'mine'
  const entries: ExampleInventoryEntry[] = []

  const taskRows = await db
    .select({ id: tasks.id, name: tasks.name, ownerUserId: tasks.ownerUserId })
    .from(tasks)
    .where(
      mine
        ? and(eq(tasks.example, true), eq(tasks.ownerUserId, actor.user.id))
        : eq(tasks.example, true),
    )
  for (const r of taskRows)
    entries.push({
      resourceType: 'task',
      resourceId: r.id,
      resourceName: r.name,
      ownerUserId: r.ownerUserId,
    })

  const wgRows = await db
    .select({ id: workgroups.id, name: workgroups.name, ownerUserId: workgroups.ownerUserId })
    .from(workgroups)
    .where(
      mine
        ? and(eq(workgroups.example, true), eq(workgroups.ownerUserId, actor.user.id))
        : eq(workgroups.example, true),
    )
  for (const r of wgRows)
    entries.push({
      resourceType: 'workgroup',
      resourceId: r.id,
      resourceName: r.name,
      ownerUserId: r.ownerUserId,
    })

  const wfRows = await db
    .select({ id: workflows.id, name: workflows.name, ownerUserId: workflows.ownerUserId })
    .from(workflows)
    .where(
      mine
        ? and(eq(workflows.example, true), eq(workflows.ownerUserId, actor.user.id))
        : eq(workflows.example, true),
    )
  for (const r of wfRows)
    entries.push({
      resourceType: 'workflow',
      resourceId: r.id,
      resourceName: r.name,
      ownerUserId: r.ownerUserId,
    })

  const agentRows = await db
    .select({ id: agents.id, name: agents.name, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(
      mine
        ? and(eq(agents.example, true), eq(agents.ownerUserId, actor.user.id))
        : eq(agents.example, true),
    )
  for (const r of agentRows)
    entries.push({
      resourceType: 'agent',
      resourceId: r.id,
      resourceName: r.name,
      ownerUserId: r.ownerUserId,
    })

  const skillRows = await db
    .select({ id: skills.id, name: skills.name, ownerUserId: skills.ownerUserId })
    .from(skills)
    .where(
      mine
        ? and(eq(skills.example, true), eq(skills.ownerUserId, actor.user.id))
        : eq(skills.example, true),
    )
  for (const r of skillRows)
    entries.push({
      resourceType: 'skill',
      resourceId: r.id,
      resourceName: r.name,
      ownerUserId: r.ownerUserId,
    })

  return { scope, entries }
}

/**
 * Drive a task to a terminal status so its workspace can be claimed.
 *
 * A single read-then-cancel is not enough: `cancelTask` polls for at most 5s
 * before falling back to a direct CAS, and a task flips between `running` and
 * `awaiting_*` while that happens — so we re-read in a bounded loop (the same
 * shape as cancelFusionEngineTask). And we must check terminality FIRST:
 * `interrupted` (what a daemon restart leaves behind) is terminal but is NOT in
 * CANCELABLE_TASK_STATUSES, so cancelling it would 409 and fail the batch.
 */
async function settleTerminal(db: DbClient, taskId: string): Promise<TaskStatus | null> {
  for (let i = 0; i < CANCEL_SETTLE_ATTEMPTS; i++) {
    const task = await getTask(db, taskId)
    if (task === null) return null
    if (isTerminalTaskStatus(task.status)) return task.status
    try {
      await cancelTask(db, taskId)
    } catch {
      // Raced into a status cancelTask refuses — re-read and decide again.
    }
  }
  const final = await getTask(db, taskId)
  return final === null ? null : final.status
}

/**
 * `canceled` does NOT mean the child process is gone: the runner's
 * SIGTERM→grace→SIGKILL escalation can end in `child-unkillable`, leaving a
 * detached process group alive. Deleting the workspace under a live writer is
 * the worst failure mode available here, so a kill we could not confirm is a
 * hard stop for that task, not a warning.
 */
async function ensureChildrenDead(db: DbClient, taskId: string): Promise<boolean> {
  const runs = await db
    .select({
      pid: nodeRuns.pid,
      startedAt: nodeRuns.startedAt,
      spawnBinaryPath: nodeRuns.spawnBinaryPath,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  for (const run of runs) {
    const outcome = await killStaleRunProcessTree(run)
    if (outcome === 'kill-failed') return false
  }
  return true
}

/**
 * Remove every on-disk artifact of a task.
 *
 * Only `scratch` has a GC safety net (runScratchOrphanGc, and only after 24h).
 * `runs/{id}` (which holds port artifacts and review document bodies),
 * `logs/{id}` and `structural-diffs/{id}` have NO sweeper at all — miss them
 * and they are permanent garbage that nothing can even locate afterwards,
 * because the doc_versions rows pointing at them are about to be cascaded away.
 *
 * Always async `rm`: `rmSync` on a large tree blocks Bun's single event loop
 * hard enough that timers stop firing and the daemon wedges (RFC-208).
 */
async function removeTaskArtifacts(
  db: DbClient,
  task: {
    id: string
    spaceKind: string
    worktreePath: string
    repoPath: string
    repoCount: number
  },
): Promise<void> {
  const home = appHome()
  const perTaskDirs = [
    join(home, 'scratch', task.id),
    join(home, 'runs', task.id),
    join(home, 'logs', task.id),
    join(home, 'structural-diffs', task.id),
    join(home, 'iso', task.id),
  ]

  if (task.spaceKind !== 'scratch' && task.worktreePath !== '') {
    // A guide task is always scratch; this branch only fires when a user took
    // an example resource and pointed it at a real repository.
    if (task.repoCount > 1) {
      const rows = await db.select().from(taskRepos).where(eq(taskRepos.taskId, task.id))
      for (const r of rows) {
        if (r.worktreePath !== '') {
          try {
            await removeWorktree({
              repoPath: r.repoPath,
              worktreePath: r.worktreePath,
              force: true,
            })
          } catch (err) {
            log.warn('example cleanup: worktree remove failed', {
              taskId: task.id,
              worktreePath: r.worktreePath,
              error: (err as Error).message,
            })
          }
        }
        await deleteSnapshotRefs(r.repoPath, task.id)
      }
    } else {
      try {
        await removeWorktree({
          repoPath: task.repoPath,
          worktreePath: task.worktreePath,
          force: true,
        })
      } catch (err) {
        log.warn('example cleanup: worktree remove failed', {
          taskId: task.id,
          worktreePath: task.worktreePath,
          error: (err as Error).message,
        })
      }
      await deleteSnapshotRefs(task.repoPath, task.id)
    }
    perTaskDirs.push(task.worktreePath)
  }

  for (const dir of perTaskDirs) {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Delete ONE example task: settle terminal → confirm children dead → claim the
 * workspace → remove artifacts → delete the row (13 child tables cascade).
 *
 * The claim matters: every revive path (resume / retry / lifecycle repair /
 * boot auto-resume) CAS-es on `workspace_pruning_at IS NULL AND
 * workspace_pruned_at IS NULL`. Deleting directories without taking it races
 * the hourly GC and the revivers, and loses as "task revived, scheduler spawns
 * in a cwd that no longer exists".
 *
 * Audit rows (recovery_events, lifecycle_repair_audit) and task_feedback have
 * no FK by design — they intentionally outlive the task and are left alone.
 */
export async function deleteExampleTask(db: DbClient, taskId: string): Promise<ExampleCleanupItem> {
  const row = await db
    .select({
      id: tasks.id,
      name: tasks.name,
      example: tasks.example,
      spaceKind: tasks.spaceKind,
      worktreePath: tasks.worktreePath,
      repoPath: tasks.repoPath,
      repoCount: tasks.repoCount,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()

  if (row === undefined) {
    return {
      resourceType: 'task',
      resourceId: taskId,
      resourceName: taskId,
      outcome: 'deleted',
      code: 'already-gone',
    }
  }
  const base = { resourceType: 'task' as const, resourceId: row.id, resourceName: row.name }

  // Defense in depth: this function must never be reachable for a real task.
  if (!row.example) {
    return { ...base, outcome: 'skipped', code: 'not-an-example-task' }
  }

  const status = await settleTerminal(db, taskId)
  if (status === null) return { ...base, outcome: 'deleted', code: 'already-gone' }
  if (!isTerminalTaskStatus(status)) {
    return {
      ...base,
      outcome: 'skipped',
      code: 'task-not-terminal',
      message: `task is still ${status}; try again once it settles`,
    }
  }

  if (!(await ensureChildrenDead(db, taskId))) {
    return {
      ...base,
      outcome: 'skipped',
      code: 'child-unkillable',
      message: 'a child process survived; refusing to delete its workspace',
    }
  }

  // A failed claim means the GC (or another cleanup) owns the delete right now.
  // Skipping is correct — the row stays, the next press picks it up.
  const alreadyPruned = await db
    .select({ prunedAt: tasks.workspacePrunedAt })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
  const claimedAt = Date.now()
  if (alreadyPruned?.prunedAt === null && !(await claimWorkspacePrune(db, taskId, claimedAt))) {
    return {
      ...base,
      outcome: 'skipped',
      code: 'workspace-claim-lost',
      message: 'the workspace is being pruned by the background collector',
    }
  }

  try {
    await removeTaskArtifacts(db, row)
  } catch (err) {
    // Release the prune claim we just took. Holding it would make the retry the
    // contract promises impossible: the next attempt would lose the claim to
    // OURSELVES for the whole 30-minute lease and report the task as "being
    // pruned by the background collector" — which nothing would ever finish.
    await db
      .update(tasks)
      .set({ workspacePruningAt: null })
      .where(and(eq(tasks.id, taskId), eq(tasks.workspacePruningAt, claimedAt)))
    return {
      ...base,
      outcome: 'failed',
      code: 'artifact-remove-failed',
      message: (err as Error).message,
    }
  }

  await db.delete(tasks).where(eq(tasks.id, taskId))
  return { ...base, outcome: 'deleted' }
}

/**
 * Drop bookkeeping rows for resources that no longer exist. Scoped to the
 * acting user's runs so one person's cleanup never edits another's ledger.
 */
async function purgeOrphanArtifacts(db: DbClient, actor: Actor): Promise<void> {
  const rows = await db
    .select({
      id: onboardingArtifacts.id,
      resourceType: onboardingArtifacts.resourceType,
      resourceId: onboardingArtifacts.resourceId,
    })
    .from(onboardingArtifacts)
    .innerJoin(onboardingRuns, eq(onboardingArtifacts.runId, onboardingRuns.id))
    .where(eq(onboardingRuns.userId, actor.user.id))
  for (const row of rows) {
    const table =
      row.resourceType === 'agent'
        ? agents
        : row.resourceType === 'skill'
          ? skills
          : row.resourceType === 'workflow'
            ? workflows
            : row.resourceType === 'workgroup'
              ? workgroups
              : tasks
    const live = await db
      .select({ id: table.id })
      .from(table)
      .where(eq(table.id, row.resourceId))
      .get()
    if (live === undefined) {
      await db.delete(onboardingArtifacts).where(eq(onboardingArtifacts.id, row.id))
    }
  }
}

function itemFromError(
  base: Pick<ExampleCleanupItem, 'resourceType' | 'resourceId' | 'resourceName'>,
  err: unknown,
): ExampleCleanupItem {
  if (err instanceof DomainError) {
    // 404 means somebody got there first — a second tab, or the user deleting
    // it by hand mid-sweep. Reporting that as a failure would show a scary
    // partial-cleanup warning for a resource that is, in fact, gone.
    if (err.status === 404) return { ...base, outcome: 'deleted', code: 'already-gone' }
    // 409s are legitimate outcomes, not bugs: somebody else's agent may list
    // this example skill, or a schedule may still reference the workflow.
    // Report them faithfully so the user can act, and never fail the batch.
    return {
      ...base,
      outcome: err.status === 409 ? 'skipped' : 'failed',
      code: err.code,
      message: err.message,
    }
  }
  return { ...base, outcome: 'failed', code: 'unexpected', message: (err as Error).message }
}

/**
 * Sweep every example artifact in scope. Never throws for a single bad item —
 * callers get the full per-item ledger.
 */
export async function cleanupExamples(
  db: DbClient,
  actor: Actor,
  scope: 'mine' | 'all',
  deps: ExampleCleanupDeps,
): Promise<ExampleCleanupResult> {
  const inventory = await collectExamples(db, actor, scope)
  const items: ExampleCleanupItem[] = []
  const byType = (t: ExampleInventoryEntry['resourceType']): ExampleInventoryEntry[] =>
    inventory.entries.filter((e) => e.resourceType === t)

  for (const entry of byType('task')) {
    items.push(await deleteExampleTask(db, entry.resourceId))
  }

  for (const entry of byType('workgroup')) {
    const base = {
      resourceType: 'workgroup' as const,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
    }
    try {
      // deleteWorkgroup takes a NAME and has no id fence, so re-read the live
      // name from the id we collected — a same-name rebuild between collect and
      // delete would otherwise take out the stand-in row.
      const live = await db
        .select({ name: workgroups.name })
        .from(workgroups)
        .where(eq(workgroups.id, entry.resourceId))
        .get()
      if (live === undefined) {
        items.push({ ...base, outcome: 'deleted', code: 'already-gone' })
        continue
      }
      await deleteWorkgroup(db, live.name, actor)
      items.push({ ...base, outcome: 'deleted' })
    } catch (err) {
      items.push(itemFromError(base, err))
    }
  }

  for (const entry of byType('workflow')) {
    const base = {
      resourceType: 'workflow' as const,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
    }
    try {
      // deleteWorkflow is OCC-guarded: it wants the CURRENT version plus a
      // freshly minted ULID mutation id. One reread-and-retry covers an
      // autosave landing between collect and delete.
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 2; attempt++) {
        const live = await db
          .select({ version: workflows.version })
          .from(workflows)
          .where(eq(workflows.id, entry.resourceId))
          .get()
        if (live === undefined) {
          lastErr = null
          break
        }
        try {
          await deleteWorkflow(
            db,
            entry.resourceId,
            { expectedVersion: live.version, clientMutationId: ulid() },
            { kind: 'actor', actor },
          )
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          if (!(err instanceof DomainError) || err.code !== 'workflow-version-conflict') break
        }
      }
      if (lastErr !== null) items.push(itemFromError(base, lastErr))
      else items.push({ ...base, outcome: 'deleted' })
    } catch (err) {
      items.push(itemFromError(base, err))
    }
  }

  for (const entry of byType('agent')) {
    const base = {
      resourceType: 'agent' as const,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
    }
    try {
      const live = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, entry.resourceId))
        .get()
      if (live === undefined) {
        items.push({ ...base, outcome: 'deleted', code: 'already-gone' })
        continue
      }
      await deleteAgent(db, live.name, actor)
      items.push({ ...base, outcome: 'deleted' })
    } catch (err) {
      items.push(itemFromError(base, err))
    }
  }

  for (const entry of byType('skill')) {
    const base = {
      resourceType: 'skill' as const,
      resourceId: entry.resourceId,
      resourceName: entry.resourceName,
    }
    try {
      const live = await db
        .select({ name: skills.name })
        .from(skills)
        .where(eq(skills.id, entry.resourceId))
        .get()
      if (live === undefined) {
        items.push({ ...base, outcome: 'deleted', code: 'already-gone' })
        continue
      }
      await deleteSkill(db, deps.skillFs, live.name, actor)
      items.push({ ...base, outcome: 'deleted' })
    } catch (err) {
      items.push(itemFromError(base, err))
    }
  }

  // Drop the bookkeeping rows for everything that actually went away, so the
  // two marker sources (artifacts table / per-row `example` column) converge
  // back to empty together.
  const deletedIds = items.filter((i) => i.outcome === 'deleted').map((i) => i.resourceId)
  if (deletedIds.length > 0) {
    await db.delete(onboardingArtifacts).where(inArray(onboardingArtifacts.resourceId, deletedIds))
  }
  // Also collect rows whose resource is already gone — the user deleted it
  // through the ordinary list page, which does not touch this table (there is
  // no FK, deliberately). They are invisible to `collectExamples` (it reads the
  // business tables), so nothing else would ever remove them.
  await purgeOrphanArtifacts(db, actor)

  return { complete: items.every((i) => i.outcome === 'deleted'), items }
}
