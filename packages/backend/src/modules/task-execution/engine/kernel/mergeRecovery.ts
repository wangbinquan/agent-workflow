// RFC-413 — the pre-drive merge recovery (RFC-130 / 144 / 210 / 369 / 370), moved verbatim from
// composition/executionMergeRecovery.ts onto the isolation mechanics ports. The composition binds the ports over the
// frame's own execution state (the task's at task entry, a wrapper's when the wrapper drives its body).
import { taskCheckpointRefs } from '../../domain/taskCheckpoint'
import { discardNodeIso } from './isolationCleanup'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block (formerly five
// hand-copies in this file).
import { markMergeFailed, mergeBackAndSettle } from './merge'
import { describeEffectError } from '../../domain/effectErrorDescription'
import type { NodeExecutionSnapshot } from '../../application/ports/nodeExecutionPersistence'
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import { parseIsoSubmodules } from '../../domain/isoSubmodules'
import type { Logger } from '../../application/ports/executionKernel'
import type {
  IsolationMechanicsPorts,
  IsolationScope,
} from '../../application/ports/isolationMechanics'

async function replaySubmodulesMissing(
  scope: IsolationScope,
  repos: ReadonlyArray<{ worktreePath: string; mountPath: string }>,
  persisted: Record<string, { subBases: Record<string, string> }>,
): Promise<string | null> {
  for (const repo of repos) {
    if (!(await scope.submodulePresence(repo.worktreePath))) continue
    const entry = persisted[repo.mountPath]
    if (entry === undefined || Object.keys(entry.subBases).length === 0) {
      return repo.mountPath || 'repo'
    }
  }
  return null
}

/**
 * RFC-369 §4.3 —— 把某一 merge 状态下、已被同帧更新一代结构性取代的行收成 abandoned。
 * 收尾失败只记日志：重放本身已经按 `excludeSuperseded` 排除了它们，结果不依赖这一步。
 */
async function abandonSupersededRuns(
  ports: IsolationMechanicsPorts,
  mergeState: 'pending-merge' | 'conflict-human',
  log: Logger,
): Promise<void> {
  const all = await ports.persistence.nodeExecution.list({
    taskId: ports.taskId,
    mergeState,
  })
  if (all.length === 0) return
  const live = new Set(
    (
      await ports.persistence.nodeExecution.list({
        taskId: ports.taskId,
        mergeState,
        excludeSuperseded: true,
      })
    ).map((row) => row.id),
  )
  for (const row of all) {
    if (live.has(row.id)) continue
    const abandoned = await ports.persistence.mergeStates.tryTransition({
      nodeRunId: row.id,
      event: { kind: 'abandon', reason: 'superseded-by-newer-generation' },
      ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
    })
    log.info('superseded merge row retired on replay', {
      nodeRunId: row.id,
      mergeState,
      abandoned,
    })
  }
}

async function scopeBaseHeads(
  ports: IsolationMechanicsPorts,
  scope: IsolationScope,
): Promise<Record<string, string>> {
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of ports.repos) {
    const h = await scope.head(repo.worktreePath)
    taskBaseHeads[repo.mountPath] = h.stdout.trim()
  }
  return taskBaseHeads
}

/**
 * RFC-130 D15/T3c2: replay one 'pending-merge' row. A daemon crash between
 * agent-success (runner wrote status='done') and merge-back leaves a done row whose
 * delta never reached the canonical worktree — deriveFrontier gates it out of
 * `completed` (D15), so without replay the scope would stall.
 *
 * Replays from the PINNED node_tree (iso_node_tree column), so the iso worktree may
 * be gone and the agent is NEVER re-run. A conflict or missing node_tree throws →
 * the caller fails the task loudly (PR-B upgrades the conflict path to the merge agent).
 */
async function replayPendingMerge(
  ports: IsolationMechanicsPorts,
  scope: IsolationScope,
  taskBaseHeads: Record<string, string>,
  r: NodeExecutionSnapshot,
  log: Logger,
): Promise<void> {
  const { taskId } = ports
  const baseSnapshots = taskCheckpointRefs(r.checkpoints, 'isolationBase')
  const nodeTrees = taskCheckpointRefs(r.checkpoints, 'nodeTree')
  if (Object.keys(nodeTrees).length === 0) {
    throw new Error(`pending-merge replay: node_tree missing for run ${r.id}`)
  }
  const submodules = parseIsoSubmodules(r.checkpoints)
  const missingSub = await replaySubmodulesMissing(scope, ports.repos, submodules)
  if (missingSub !== null) {
    throw new Error(
      `pending-merge replay: submodule topology missing for repo '${missingSub}' of run ${r.id}`,
    )
  }
  const handle = await ports.workspace.restore({
    // Round 6 P2: the PHYSICAL iso identity — a process-retry keeps the
    // worktree + ref namespace keyed by the ORIGINAL row id (D17) while
    // pending-merge lands on the retry row; rebuild from the persisted
    // path so discard/refs address what actually exists.
    key: await scope.recoverKey(r.isoWorktreePath, r.id),
    dbNodeRunId: r.id,
    workspaceRef: r.isoWorktreePath,
    baseSnapshots,
    taskBaseHeads,
    submodules,
    // RFC-193 K1: the replay's merge-back re-snapshots canonical (ours) —
    // it must keep force-including the task's gitignored port files.
    forcedContainerPaths: [...(await ports.persistence.artifactPaths.forcedPaths(taskId))],
  })
  // RFC-188: the ONE merge-back assembly — replay passes the PERSISTED node
  // trees (the iso worktree may be gone; the agent is never re-run) so the
  // snapshot phase is skipped. RFC-130 §6.2: a crash-recovered pending-merge
  // that now conflicts goes through the SAME merge agent as a live dispatch;
  // unresolved → conflict-human (resume replay #2 completes the human fix).
  const merge = await mergeBackAndSettle({
    binding: ports.binding,
    writeSem: ports.writeSem,
    handle,
    nodeRunId: r.id,
    nodeTrees,
    via: 'replay',
    conflictResolver: (conflicts, containerPath) =>
      ports.conflicts.resolveMergeConflicts({
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
    await discardNodeIso(ports.cleanup, handle, log, ports.writeSem)
  } else {
    log.warn('pending-merge replay conflict → conflict-human (merge agent could not resolve)', {
      nodeRunId: r.id,
      detail: merge.detail,
    })
  }
}

/**
 * RFC-370 — finish one done run whose merge-back stopped before its node tree
 * was pinned ('isolating'): the daemon stopped, or a hosted instance lost its
 * execution lease, while the final snapshot was being taken. The run itself
 * finished and its outputs are recorded, and every merge-back throw keeps the
 * iso (RFC-210 A1), so the iso still holds the run's final state: snapshot it
 * now and merge, exactly as the live dispatch would have. Without this the done
 * row wedged its scope forever ("scheduler stalled"). A missing iso or a failed
 * snapshot fails the node like a live merge-back throw.
 */
async function completeInterruptedRun(
  ports: IsolationMechanicsPorts,
  scope: IsolationScope,
  taskBaseHeads: Record<string, string>,
  r: NodeExecutionSnapshot,
  log: Logger,
): Promise<void> {
  const { taskId } = ports
  const baseSnapshots = taskCheckpointRefs(r.checkpoints, 'isolationBase')
  try {
    if (Object.keys(baseSnapshots).length === 0) {
      throw new Error(`interrupted merge-back: iso base snapshot missing for run ${r.id}`)
    }
    const handle = await ports.workspace.restore({
      key: await scope.recoverKey(r.isoWorktreePath, r.id),
      dbNodeRunId: r.id,
      workspaceRef: r.isoWorktreePath,
      baseSnapshots,
      taskBaseHeads,
      submodules: parseIsoSubmodules(r.checkpoints),
      forcedContainerPaths: [...(await ports.persistence.artifactPaths.forcedPaths(taskId))],
    })
    // No node trees supplied: the assembly snapshots the kept iso, pins the
    // trees (isolating → pending-merge) and merges under the write lock.
    const merge = await mergeBackAndSettle({
      binding: ports.binding,
      writeSem: ports.writeSem,
      handle,
      nodeRunId: r.id,
      via: 'replay',
      conflictResolver: (conflicts, containerPath) =>
        ports.conflicts.resolveMergeConflicts({
          conflicts,
          containerPath,
          conflictNodeRunId: r.id,
          nodeId: r.nodeId,
          iteration: r.iteration,
        }),
      log,
    })
    if (merge.kind === 'merged') {
      log.info('interrupted merge-back completed', { nodeRunId: r.id })
      await discardNodeIso(ports.cleanup, handle, log, ports.writeSem)
    } else {
      log.warn('interrupted merge-back conflict → conflict-human (merge agent could not resolve)', {
        nodeRunId: r.id,
        detail: merge.detail,
      })
    }
  } catch (error) {
    const message = describeEffectError(error)
    log.warn('interrupted merge-back could not be completed; the node fails', {
      nodeRunId: r.id,
      error: message,
    })
    await markMergeFailed(ports.binding, r.id, message, log)
  }
}

/**
 * RFC-370 — complete the merge-backs a crash or a lost execution lease
 * interrupted in ONE frame, before that frame's frontier is derived, so the
 * frontier only ever sees settled rows. The frame's own scheduler state is the
 * merge target: the top frame (`containerRunId: null`, every round) merges into
 * the task worktrees at task entry, a wrapper body (its generation row plus
 * round) into the wrapper's isolated worktree when the wrapper drives it. Every
 * frame used to be replayed at task entry into the task worktrees, which merged
 * a wrapper body's run past its wrapper — the wrapper's `git_diff` then missed
 * it. Fan-out children complete through {@link completeInterruptedMerge} when
 * their dispatch weighs reusing them.
 */
export async function completeFrameMerges(
  ports: IsolationMechanicsPorts,
  frame: { readonly containerRunId: string | null; readonly iteration: number },
  log: Logger,
): Promise<void> {
  const inFrame = {
    taskId: ports.taskId,
    containerRunId: frame.containerRunId,
    ...(frame.containerRunId === null ? {} : { iteration: frame.iteration }),
    // RFC-369 —— 被同帧更新一代取代的旧代不重放（它过期的 delta 不得进 canonical，RFC-144）。
    excludeSuperseded: true,
  } as const
  const pinned = await ports.persistence.nodeExecution.list({
    ...inFrame,
    mergeState: 'pending-merge',
  })
  const interrupted = await ports.persistence.nodeExecution.list({
    ...inFrame,
    mergeState: 'isolating',
    status: 'done',
  })
  if (pinned.length === 0 && interrupted.length === 0) return
  const scope = await ports.workspace.scope()
  const taskBaseHeads = await scopeBaseHeads(ports, scope)
  for (const r of pinned) await replayPendingMerge(ports, scope, taskBaseHeads, r, log)
  for (const r of interrupted) await completeInterruptedRun(ports, scope, taskBaseHeads, r, log)
}

/** RFC-370 — complete one done fan-out child's interrupted merge-back in the
 * dispatching scope (its merge target) before its reuse is decided. */
export async function completeInterruptedMerge(
  ports: IsolationMechanicsPorts,
  r: NodeExecutionSnapshot,
  log: Logger,
): Promise<void> {
  const scope = await ports.workspace.scope()
  const taskBaseHeads = await scopeBaseHeads(ports, scope)
  if (r.mergeState === 'pending-merge') {
    await replayPendingMerge(ports, scope, taskBaseHeads, r, log)
  } else {
    await completeInterruptedRun(ports, scope, taskBaseHeads, r, log)
  }
}

/**
 * RFC-130 §6.3 resume — on task resume, complete any conflict-human node whose
 * human has resolved its conflict in the preserved resolve-iso worktree(s). A repo
 * that now merges cleanly → materialized + the row flips to 'merged' (the frontier
 * releases its downstream); a repo still unresolved keeps the row at
 * 'conflict-human' → the frontier re-parks the task at awaiting_human. Runs at the
 * resume entry (before the scope loop), right after the top frame's merges complete.
 */
async function replayConflictHumanResolutions(
  ports: IsolationMechanicsPorts,
  log: Logger,
): Promise<void> {
  const { taskId } = ports
  await abandonSupersededRuns(ports, 'conflict-human', log)
  const rows = await ports.persistence.nodeExecution.list({
    taskId,
    mergeState: 'conflict-human',
    excludeSuperseded: true,
  })
  if (rows.length === 0) return
  const scope = await ports.workspace.scope()
  const taskBaseHeads: Record<string, string> = {}
  for (const repo of ports.repos) {
    const h = await scope.head(repo.worktreePath)
    taskBaseHeads[repo.mountPath] = h.stdout.trim()
  }
  for (const r of rows) {
    const baseSnapshots = taskCheckpointRefs(r.checkpoints, 'isolationBase')
    const nodeTrees = taskCheckpointRefs(r.checkpoints, 'nodeTree')
    const handle = await ports.workspace.restore({
      // Round 6 P2 (same as replayPendingMerge): rebuild the PHYSICAL iso
      // identity from the persisted path — this is also what makes the
      // resolve-iso lookup inside completeHumanResolvedConflict hit the
      // container a process-retry actually used.
      key: await scope.recoverKey(r.isoWorktreePath, r.id),
      dbNodeRunId: r.id,
      workspaceRef: r.isoWorktreePath,
      baseSnapshots,
      taskBaseHeads,
      forcedContainerPaths: [...(await ports.persistence.artifactPaths.forcedPaths(taskId))],
      // RFC-210: the human-resolve completion re-merges, so it needs the same
      // per-submodule bases the original merge-back had.
      submodules: parseIsoSubmodules(r.checkpoints),
    })
    const outcome = await ports.writeSem.run(() =>
      ports.completeHumanConflict(handle, nodeTrees, log),
    )
    if (outcome.allResolved) {
      await ports.persistence.mergeStates.transition({
        nodeRunId: r.id,
        event: { kind: 'complete-human-resolution' },
        ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
      })
      log.info('conflict-human resume: human resolution merged back', { nodeRunId: r.id })
      // RFC-210 (review round 5, P2): the park kept the iso for the human;
      // now that the resolution landed, close its lifecycle — anchor handoff
      // for NEW paths + node pool ref cleanup happen inside the discard.
      await discardNodeIso(ports.cleanup, handle, log, ports.writeSem)
    } else {
      log.info('conflict-human resume: still unresolved — staying parked', {
        nodeRunId: r.id,
        repos: outcome.unresolvedRepos,
      })
    }
  }
}

/** The task-entry recovery: every frame's superseded generations, the top frame's merges, then human conflicts. */
export async function recoverMergesBeforeScope(
  ports: IsolationMechanicsPorts,
  log: Logger,
): Promise<void> {
  // RFC-369 —— 被同帧更新一代取代的旧代（任一帧）先收成 abandoned；旧代作废原先在铸造事务里同事务
  // 落库，现在由读侧推导。
  await abandonSupersededRuns(ports, 'pending-merge', log)
  await completeFrameMerges(ports, { containerRunId: null, iteration: 0 }, log)
  await replayConflictHumanResolutions(ports, log)
}
