// RFC-339 — task-execution-owned pre-drive merge recovery mechanics.

import type { MergeState } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
// RFC-253 — script node execution.
import { nodeRuns } from '@/db/schema'
// RFC-271 T6d — RuntimeRef 域的单一解析点（三处 agentId 裸读收口于此）。
// `getAgentById` 的 import 随之删除：scheduler 不再自己查 agent 行。
import { transitionMergeState } from '@/services/lifecycle'

import { forcedPortPathsForTask } from '@/services/portArtifacts'
import { type Logger } from '@/util/log'
// RFC-060 PR-E: splitDiff* imports removed — they were used only by the
// agent-multi fan-out path (now deleted). wrapper-fanout consumes a `list<T>`
// shardSource instead of slicing a string diff.
import {
  completeHumanResolvedConflict,
  // snapshotNodeIsoFinal / mergeBackNodeIso remain imported for the WRAPPER
  // merge path only (mergeBackWrapperIso — outside RFC-188's agent-site
  // scope). Wrapper CREATE shares createIsoUnderLock with every AGENT site so
  // sibling `git worktree add` mutations cannot race in the common repository.
  discardNodeIso,
  rebuildIsoHandle,
} from '@/services/nodeIsolation'
import { runGit } from '@/util/git'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block (formerly five
// hand-copies in this file).
import { mergeBackAndSettle } from '@/services/isolatedAgentRun'
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import {
  isoKeyOf,
  parseIsoJsonMap,
  parseIsoSubmodules,
  resolveMergeConflicts,
  type SchedulerState,
} from '@/modules/task-execution/composition/nodeMechanics'
import { existsSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import type { ExecutionMergeRecovery } from '../application/recovery/executionMergeRecovery'

function replaySubmodulesMissing(
  repos: ReadonlyArray<{ worktreePath: string; worktreeDirName: string }>,
  persisted: Record<string, { subBases: Record<string, string> }>,
): string | null {
  for (const repo of repos) {
    if (!existsSync(pathJoin(repo.worktreePath, '.gitmodules'))) continue
    const entry = persisted[repo.worktreeDirName]
    if (entry === undefined || Object.keys(entry.subBases).length === 0) {
      return repo.worktreeDirName || 'repo'
    }
  }
  return null
}

/**
 * RFC-130 D15/T3c2: on resume, replay merge-back for any 'pending-merge' row. A
 * daemon crash between agent-success (runner wrote status='done') and merge-back
 * leaves a done row whose delta never reached the canonical worktree — deriveFrontier
 * gates it out of `completed` (D15), so without replay the scope would stall.
 *
 * Replays from the PINNED node_tree (iso_node_tree column), so the iso worktree may
 * be gone and the agent is NEVER re-run. Runs BEFORE the scope so the frontier only
 * ever sees merged/failed rows. A conflict or missing node_tree throws → the caller
 * fails the task loudly (PR-B upgrades the conflict path to the merge agent).
 */
async function replayPendingMerges(state: SchedulerState, log: Logger): Promise<void> {
  const { db, taskId, task } = state
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.mergeState, 'pending-merge' satisfies MergeState),
      ),
    )
  if (rows.length === 0) return
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of state.repos) {
    const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
    taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots: Record<string, string> = {}
    const nodeTrees: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (r.isoBaseSnapshot !== null) baseSnapshots[''] = r.isoBaseSnapshot
      if (r.isoNodeTree !== null) nodeTrees[''] = r.isoNodeTree
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(r.isoBaseSnapshotReposJson))
      Object.assign(nodeTrees, parseIsoJsonMap(r.isoNodeTreeReposJson))
    }
    if (Object.keys(nodeTrees).length === 0) {
      throw new Error(`pending-merge replay: node_tree missing for run ${r.id}`)
    }
    const submodules = parseIsoSubmodules(r, task.repoCount)
    const missingSub = replaySubmodulesMissing(state.repos, submodules)
    if (missingSub !== null) {
      throw new Error(
        `pending-merge replay: submodule topology missing for repo '${missingSub}' of run ${r.id}`,
      )
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      // Round 6 P2: the PHYSICAL iso identity — a process-retry keeps the
      // worktree + ref namespace keyed by the ORIGINAL row id (D17) while
      // pending-merge lands on the retry row; rebuild from the persisted
      // path so discard/refs address what actually exists.
      nodeRunId: isoKeyOf(r.isoWorktreePath, r.id),
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
      submodules,
      // RFC-193 K1: the replay's merge-back re-snapshots canonical (ours) —
      // it must keep force-including the task's gitignored port files.
      forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
    })
    // RFC-188: the ONE merge-back assembly — replay passes the PERSISTED node
    // trees (the iso worktree may be gone; the agent is never re-run) so the
    // snapshot phase is skipped. RFC-130 §6.2: a crash-recovered pending-merge
    // that now conflicts goes through the SAME merge agent as a live dispatch;
    // unresolved → conflict-human (resume replay #2 completes the human fix).
    const merge = await mergeBackAndSettle({
      db,
      writeSem: state.writeSem,
      handle,
      nodeRunId: r.id,
      repoCount: task.repoCount,
      nodeTrees,
      via: 'replay',
      conflictResolver: (conflicts, containerPath) =>
        resolveMergeConflicts(state, {
          conflicts,
          containerPath,
          conflictNodeRunId: r.id,
          nodeId: r.nodeId,
          iteration: r.iteration,
        }),
      log,
    })
    if (merge.kind === 'merged') {
      log.info('pending-merge replay merged', { nodeRunId: r.id })
      // RFC-210 (review round 5, P2): a replayed merge never passes a live
      // site's discard — without this the node-scoped pool refs leak forever
      // and a NEW path's worktree anchor is never handed over. Best-effort:
      // the iso worktree is usually already gone (that is why we replayed).
      await discardNodeIso(handle, log, state.writeSem)
    } else {
      log.warn('pending-merge replay conflict → conflict-human (merge agent could not resolve)', {
        nodeRunId: r.id,
        detail: merge.detail,
      })
    }
  }
}

/**
 * RFC-130 §6.3 resume — on task resume, complete any conflict-human node whose
 * human has resolved its conflict in the preserved resolve-iso worktree(s). A repo
 * that now merges cleanly → materialized + the row flips to 'merged' (the frontier
 * releases its downstream); a repo still unresolved keeps the row at
 * 'conflict-human' → the frontier re-parks the task at awaiting_human. Runs at the
 * resume entry (before the scope loop), right after replayPendingMerges.
 */
async function replayConflictHumanResolutions(state: SchedulerState, log: Logger): Promise<void> {
  const { db, taskId, task } = state
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.mergeState, 'conflict-human' satisfies MergeState),
      ),
    )
  if (rows.length === 0) return
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of state.repos) {
    const h = await runGit(repo.worktreePath, ['rev-parse', 'HEAD'])
    taskBaseHeads[repo.worktreeDirName] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots: Record<string, string> = {}
    const nodeTrees: Record<string, string> = {}
    if (task.repoCount === 1) {
      if (r.isoBaseSnapshot !== null) baseSnapshots[''] = r.isoBaseSnapshot
      if (r.isoNodeTree !== null) nodeTrees[''] = r.isoNodeTree
    } else {
      Object.assign(baseSnapshots, parseIsoJsonMap(r.isoBaseSnapshotReposJson))
      Object.assign(nodeTrees, parseIsoJsonMap(r.isoNodeTreeReposJson))
    }
    const handle = rebuildIsoHandle({
      appHome: state.opts.appHome,
      taskId,
      // Round 6 P2 (same as replayPendingMerges): rebuild the PHYSICAL iso
      // identity from the persisted path — this is also what makes the
      // resolve-iso lookup inside completeHumanResolvedConflict hit the
      // container a process-retry actually used.
      nodeRunId: isoKeyOf(r.isoWorktreePath, r.id),
      canonRepos: state.repos,
      baseSnapshots,
      taskBaseHeads,
      forcedContainerPaths: await forcedPortPathsForTask(db, taskId),
      // RFC-210: the human-resolve completion re-merges, so it needs the same
      // per-submodule bases the original merge-back had.
      submodules: parseIsoSubmodules(r, task.repoCount),
    })
    const outcome = await state.writeSem.run(() =>
      completeHumanResolvedConflict(handle, nodeTrees, log),
    )
    if (outcome.allResolved) {
      await transitionMergeState({
        db,
        nodeRunId: r.id,
        event: { kind: 'complete-human-resolution' },
      })
      log.info('conflict-human resume: human resolution merged back', { nodeRunId: r.id })
      // RFC-210 (review round 5, P2): the park kept the iso for the human;
      // now that the resolution landed, close its lifecycle — anchor handoff
      // for NEW paths + node pool ref cleanup happen inside the discard.
      await discardNodeIso(handle, log, state.writeSem)
    } else {
      log.info('conflict-human resume: still unresolved — staying parked', {
        nodeRunId: r.id,
        repos: outcome.unresolvedRepos,
      })
    }
  }
}

export function composeExecutionMergeRecovery(
  state: SchedulerState,
  log: Logger,
): ExecutionMergeRecovery {
  return {
    async recoverBeforeScope() {
      await replayPendingMerges(state, log)
      await replayConflictHumanResolutions(state, log)
    },
  }
}
