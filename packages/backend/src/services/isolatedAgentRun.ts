// RFC-188 — the ONE assembly for the shared mechanics of "an isolated agent
// run". Extracted from FIVE hand-copied sites in scheduler.ts (runOneNode
// §段③ / dispatchFanoutShard / dispatchFanoutAggregator / buildWorkgroupHooks.
// runHostNode / replayPendingMerges — the workgroup copy's own header used to
// admit "copied from the fanout-shard dispatch path"), where every merge/
// abandon/lock-window evolution had to be mirrored by hand and RFC-184/186/187
// each shipped a bug born from exactly that drift.
//
// Deliberately NOT owned here (design.md §T1 修订):
//   - node_run minting / retry loops / prompt & runNode argument assembly /
//     clarify session creation — per-site semantics;
//   - the iso KEEP-vs-DISCARD finally discipline and semaphore sets — they
//     genuinely differ per site (mainline keepIso on park; shard discards
//     always; shard holds global+subprocess);
//   - the merge-throw disposition: mainline/shard/aggregator stamp
//     `mark-merge-failed` in their catch, the workgroup hook deliberately
//     leaves 'pending-merge' for entry replay — mergeBackAndSettle therefore
//     throws RAW and each site keeps its own catch (markMergeFailed helper).
//
// Import discipline: this module must NEVER import scheduler.ts (module-cycle
// ban — binary-build incident). The conflict resolver (which mints child runs
// and calls runNode directly) is injected by the scheduler as a callback.

import type { DbClient } from '@/db/client'
import { transitionMergeState, tryTransitionMergeState } from '@/services/lifecycle'
import {
  createNodeIso,
  mergeBackNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
  type IsoHandle,
  type MergeBackConflict,
} from '@/services/nodeIsolation'
import type { Logger } from '@/util/log'

/** The slice of the per-task write lock the primitives need (taskWriteLocks'
 *  TaskWriteSem shape — structural so tests can pass a plain stub). */
export interface WriteSemLike {
  run<T>(fn: () => Promise<T>): Promise<T>
}

/**
 * RFC-130 §段①: branch the isolated worktree under a brief writeSem window.
 * The ONE lock-window shape all five sites (incl. the mainline fresh-session
 * retry re-branch) must share — holding writeSem across the snapshot keeps a
 * sibling merge-back from advancing canonical mid-snapshot.
 */
export async function createIsoUnderLock(args: {
  writeSem: WriteSemLike
  appHome: string
  taskId: string
  /** Iso path/ref key — the mainline passes its ORIGINAL row id across the
   *  whole retry loop (D17); other sites pass the run's own id. */
  isoKeyRunId: string
  canonRepos: CanonRepo[]
  log?: Logger
}): Promise<IsoHandle> {
  return args.writeSem.run(() =>
    createNodeIso({
      appHome: args.appHome,
      taskId: args.taskId,
      nodeRunId: args.isoKeyRunId,
      canonRepos: args.canonRepos,
      ...(args.log !== undefined ? { log: args.log } : {}),
    }),
  )
}

/**
 * RFC-130: persist the iso base columns after createNodeIso (single vs multi-repo,
 * design.md §3.2). merge_state='isolating' marks the row as an isolated run whose
 * agent has not yet finished — deriveFrontier treats it as not-yet-complete.
 * RFC-144: the write goes through the merge_state CAS (NULL → isolating); the
 * iso base columns ride along atomically as transition extras.
 */
export async function persistIsoBase(
  db: DbClient,
  nodeRunId: string,
  repoCount: number,
  handle: IsoHandle,
): Promise<void> {
  if (handle.passthrough) return // in-place run — leave iso columns NULL (golden-lock)
  if (repoCount === 1) {
    await transitionMergeState({
      db,
      nodeRunId,
      event: { kind: 'begin-isolation' },
      extra: {
        isoWorktreePath: handle.containerPath,
        isoBaseSnapshot: handle.repos[0]?.baseSnapshot ?? null,
        isoBaseSnapshotReposJson: null,
      },
    })
    return
  }
  const map: Record<string, string> = {}
  for (const r of handle.repos) map[r.worktreeDirName] = r.baseSnapshot
  await transitionMergeState({
    db,
    nodeRunId,
    event: { kind: 'begin-isolation' },
    extra: {
      isoWorktreePath: handle.containerPath,
      isoBaseSnapshot: null,
      isoBaseSnapshotReposJson: JSON.stringify(map),
    },
  })
}

/** RFC-130: persist the iso node_tree columns + merge_state on agent success (D15).
 *  RFC-144: isolating → pending-merge via the merge_state CAS; the former
 *  `mergeState: string` parameter was a dead knob (all 4 callers passed the
 *  literal 'pending-merge') — the event now fixes the target. */
export async function persistIsoNodeTree(
  db: DbClient,
  nodeRunId: string,
  repoCount: number,
  nodeTrees: Record<string, string>,
): Promise<void> {
  await transitionMergeState({
    db,
    nodeRunId,
    event: { kind: 'mark-pending-merge' },
    extra:
      repoCount === 1
        ? { isoNodeTree: nodeTrees[''] ?? null, isoNodeTreeReposJson: null }
        : { isoNodeTree: null, isoNodeTreeReposJson: JSON.stringify(nodeTrees) },
  })
}

export interface MergeSettleOutcome {
  kind: 'merged' | 'conflict-human'
  /** Unresolved-conflict summary (conflict-human only). */
  detail?: string
}

/**
 * RFC-130 §段③ / §6.2-§6.3, extracted (RFC-188): snapshot the iso final state,
 * persist the node trees, then — under ONE brief writeSem window — 3-way
 * merge-back into canonical and (on conflict) run the injected resolver; settle
 * the row's merge_state to 'merged' or 'conflict-human'.
 *
 * - `nodeTrees` given (crash REPLAY: the iso worktree may be gone) ⇒ the
 *   snapshot+persist phase is skipped and the persisted trees drive the merge.
 * - Git-level failures THROW RAW — the merge-throw disposition is per-site
 *   (markMergeFailed vs the workgroup hook's leave-for-replay, see header).
 * - Holding writeSem across the (rare) conflict resolution is the §6.2/D5
 *   tradeoff — the resolver's runNode bypasses globalSem (§7 no-cycle);
 *   moving the agent out of the lock is the separately-RFC'd T5b.
 */
export async function mergeBackAndSettle(args: {
  db: DbClient
  writeSem: WriteSemLike
  handle: IsoHandle
  nodeRunId: string
  repoCount: number
  nodeTrees?: Record<string, string>
  via: 'live' | 'replay'
  conflictResolver: (
    conflicts: MergeBackConflict[],
    containerPath: string,
  ) => Promise<{ allResolved: boolean; detail: string }>
  log?: Logger
}): Promise<MergeSettleOutcome> {
  const { db, writeSem, handle, nodeRunId, via, log } = args
  let nodeTrees = args.nodeTrees
  if (nodeTrees === undefined) {
    nodeTrees = await snapshotNodeIsoFinal(handle, log)
    await persistIsoNodeTree(db, nodeRunId, args.repoCount, nodeTrees)
  }
  const trees = nodeTrees
  const merge = await writeSem.run(async () => {
    const mergeRes = await mergeBackNodeIso(handle, trees, log)
    if (mergeRes.clean) return { kind: 'merged' as const }
    const res = await args.conflictResolver(mergeRes.conflicts, handle.containerPath)
    return res.allResolved
      ? { kind: 'merged' as const }
      : { kind: 'conflict-human' as const, detail: res.detail }
  })
  if (merge.kind === 'merged') {
    await transitionMergeState({ db, nodeRunId, event: { kind: 'mark-merged', via } })
    return { kind: 'merged' }
  }
  await transitionMergeState({ db, nodeRunId, event: { kind: 'park-conflict-human', via } })
  return { kind: 'conflict-human', detail: merge.detail }
}

/**
 * RFC-130 robustness / RFC-144 §5 — the merge-throw stamp three sites share:
 * flip the row to 'merge-failed' (try-variant so a CAS loss can never mask the
 * ORIGINAL git error) and report whether the flip landed. The workgroup hook
 * deliberately does NOT call this (leave-for-replay, see module header).
 */
export async function markMergeFailed(
  db: DbClient,
  nodeRunId: string,
  reason: string,
  log?: Logger,
): Promise<void> {
  const flipped = await tryTransitionMergeState({
    db,
    nodeRunId,
    event: { kind: 'mark-merge-failed', reason },
  })
  if (!flipped) log?.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId })
}
