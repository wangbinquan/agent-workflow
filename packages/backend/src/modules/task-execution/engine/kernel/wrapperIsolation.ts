// RFC-413 — the wrapper-canonical isolated worktree (RFC-130 T11 / RFC-144 / RFC-193 K1 / RFC-210 / RFC-356 T15):
// create or rebuild it when a wrapper generation opens, and merge its total delta back as one unit. Moved verbatim
// from composition/wrapperMechanics.ts onto the isolation mechanics ports; the git / loop wrappers reach it through
// the wrapper workspace port (engine/wrapper/wrapperWorkspace.ts).
import type { WorkflowNode } from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import { taskCheckpointRefs, type TaskRepositoryCheckpoint } from '../../domain/taskCheckpoint'
import { describeEffectError } from '../../domain/effectErrorDescription'
// RFC-210 replay: submodule topology read-back + the fail-closed gate around it.
import { parseIsoSubmodules } from '../../domain/isoSubmodules'
import type { Logger } from '../../application/ports/executionKernel'
import type { IsolationMechanicsPorts } from '../../application/ports/isolationMechanics'
// RFC-188: the shared assembly for isolated agent runs — iso lock-window,
// iso-column persistence and the merge-back/settle block.
import { createIsoUnderLock, persistIsoBase, persistIsoNodeTree } from './isolation'
import { discardNodeIso } from './isolationCleanup'

/**
 * RFC-130 T11 — create (fresh mint) or rebuild (resume) the wrapper-canonical iso
 * for a wrapper node. Fresh: snapshot the task canonical into an iso worktree keyed
 * by the wrapper's run id + persist its base. Resume: rebuild the handle pointing at
 * the SAME worktree (kept across a park — carrying the inner scope's accumulated
 * changes — so it must NOT be recreated). A non-git task worktree (mock harness)
 * yields a passthrough handle (the wrapper runs directly on the task canonical).
 */
export async function createOrRebuildWrapperIso(
  ports: IsolationMechanicsPorts,
  wrapperRunId: string,
  existing: {
    checkpoints: readonly TaskRepositoryCheckpoint[]
  } | null,
): Promise<IsoHandle> {
  const { taskId } = ports
  // RFC-144 (Codex impl-gate P2) — same-row wrapper revival: a revived wrapper
  // row may arrive with a SETTLED prior generation ('merged': crash inside
  // mergeBackWrapperIso got its pending-merge replayed at entry;
  // 'conflict-human': canceled while parked). This run opens a NEW isolation
  // generation on the same row — re-enter 'isolating' so the strict machine's
  // mark-pending-merge (from=isolating) holds at the wrapper's merge-back.
  // isolating (mid-run revival, the common case) and NULL (fresh row /
  // passthrough) rows never emit this.
  const cur = await ports.persistence.nodeExecution.read(wrapperRunId)
  // RFC-356 T15 —— 这棵 wrapper iso 的**物理键**。
  //
  // 它不一定等于 `wrapperRunId`：RFC-356 的代际自愈会在残留清不掉时把键推进成
  // `{原键}-2`，而路径的 basename 就是键（`isoKeyOf`，RFC-210 round 6 P2）。
  //
  // ⚠️ **顺序约束**：必须用 CAS **之前**读到的 `cur`。下面 `merged` 再入分支的
  // reenter CAS 会显式把 `isoWorktreePath` 写成 null，之后再读就只剩 wrapperRunId
  // 可派生——那恰好是代际自愈已经放弃的那个阻塞目录。挪动这个读取点会静默失效。
  const scope = await ports.workspace.scope()
  const wrapperIsoKey = await scope.recoverKey(cur?.isoWorktreePath ?? null, wrapperRunId)
  let effectiveExisting = existing
  if (cur !== null && (cur.mergeState === 'merged' || cur.mergeState === 'conflict-human')) {
    if (cur.mergeState === 'merged') {
      // Impl-gate P2 second half: the prior generation's delta is ALREADY in
      // canonical — the new generation must branch from the CURRENT canonical,
      // NOT the stale gen-1 base. A three-way merge against the old base would
      // treat gen-1 files (now in canon) as `ours` additions and resurrect
      // content the new generation deleted.
      //
      // ORDER (impl-gate P2 rounds 3-5): the reenter CAS runs FIRST — it is the
      // ownership claim. A concurrent reviver that also read 'merged' loses the
      // CAS here and throws BEFORE any destructive cleanup (it can never remove
      // the winner's freshly-built iso). The CAS ATOMICALLY clears the base
      // columns + wrapperProgressJson, so a crash anywhere after it leaves an
      // isolating row with NULL base/progress — the next resume re-detects
      // "generation start" from durable state and the stale-iso cleanup below
      // (derived paths only, no column values needed) makes the re-create
      // idempotent. conflict-human re-entry keeps base + progress: its delta
      // never reached canonical (D27), so the old base/baseline stay the
      // correct merge/diff anchors.
      await ports.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        extra: {
          runtime: {
            isoWorktreePath: null,
            wrapperProgressJson: null,
          },
          checkpoint: {
            checkpoints: ports.repos.map((repo) => ({
              mountPath: repo.mountPath,
              isolationBase: undefined,
            })),
          },
        },
        ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
      })
      effectiveExisting = null
    } else {
      await ports.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'reenter-isolation' },
        ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
      })
    }
  }
  if (effectiveExisting !== null) {
    const baseSnapshots = taskCheckpointRefs(effectiveExisting.checkpoints, 'isolationBase')
    if (Object.keys(baseSnapshots).length > 0) {
      const taskBaseHeads: Record<string, string> = {}
      for (const repo of ports.repos) {
        taskBaseHeads[repo.mountPath] = (await scope.head(repo.worktreePath)).stdout.trim()
      }
      return await ports.workspace.restore({
        // 这个 handle **要拿去 merge-back**：指错路径不是少清一个目录，
        // 而是把不存在的树当成节点产物去合并，属硬故障。
        key: wrapperIsoKey,
        dbNodeRunId: wrapperRunId,
        workspaceRef: cur?.isoWorktreePath ?? null,
        baseSnapshots,
        taskBaseHeads,
        forcedContainerPaths: [...(await ports.persistence.artifactPaths.forcedPaths(taskId))],
        // RFC-210: a rebuilt wrapper iso merges back like any other, so it
        // carries the same submodule topology. (The discard-only rebuild below
        // deliberately does not — it needs paths and refs, nothing else.)
        submodules: parseIsoSubmodules(effectiveExisting.checkpoints),
      })
    }
    // No persisted iso base (legacy / passthrough row) — fall through to create.
  }
  if (existing !== null) {
    // Reaching CREATE for a row that has lived before (merged re-entry, or a
    // crash inside a prior re-entry window that cleared the base columns): a
    // stale iso worktree may still sit at this wrapper's derived path, and
    // `git worktree add` fails LOUDLY on an existing dir — without cleanup the
    // task would wedge on every resume. discardNodeIso only needs the derived
    // paths + refs (base snapshot VALUES are unused for removal), so a handle
    // rebuilt with empty snapshot maps cleans up regardless of what the crash
    // left behind. Tolerant: nothing there → warn-and-continue.
    await discardNodeIso(
      ports.cleanup,
      await ports.workspace.restore({
        // 只做 discard，路径缺失可容忍（比 :1662 那处低一档风险）。
        key: wrapperIsoKey,
        dbNodeRunId: wrapperRunId,
        workspaceRef: cur?.isoWorktreePath ?? null,
        baseSnapshots: {},
        taskBaseHeads: {},
      }),
      ports.log,
      ports.writeSem,
    )
  }
  // Wrapper-private canonicals and ordinary sibling agent isos mutate the same
  // repository's `.git/worktrees` registry. They MUST share the task write
  // semaphore; otherwise a top-level wrapper and a slow sibling can overlap
  // `git worktree add`, leaving a partially initialized registration whose
  // `commondir` cannot be read. Keep only the short create/snapshot window
  // locked — wrapper execution itself remains concurrent.
  const handle = await createIsoUnderLock({
    writeSem: ports.writeSem,
    appHome: ports.appHome,
    taskId,
    isoKeyRunId: wrapperRunId,
    canonRepos: ports.repos,
    binding: ports.binding,
    log: ports.log,
  })
  if (!handle.passthrough) await persistIsoBase(ports.binding, wrapperRunId, handle)
  return handle
}

/**
 * RFC-130 T11 — merge a completed wrapper's total delta (its wrapper-canonical)
 * back into the parent (task) canonical as ONE unit, exactly like a node merge-back
 * (§6). Clean → merge_state='merged' (D15 lets downstream consume) + iso discarded;
 * conflict → merge agent, unresolved → the wrapper is parked conflict-human (iso
 * kept) — the caller returns awaiting_human; a merge-back error → merge-failed, the
 * caller fails the wrapper. Shared by the git + loop (+ fanout) wrappers so the
 * merge-back semantics can't fork.
 */
export async function mergeBackWrapperIso(
  ports: IsolationMechanicsPorts,
  wrapperIso: IsoHandle,
  wrapperRunId: string,
  node: WorkflowNode,
  iteration: number,
  log: Logger,
): Promise<
  // RFC-144 naming收敛: the parked-conflict variant is 'conflict-human' — same
  // vocabulary as the merge_state column and the node-path union above (the
  // old 'awaiting_human' kind said what the TASK would do, not what the row
  // is; callers translate conflict-human → awaiting_human scope outcome).
  | { kind: 'merged' }
  | { kind: 'conflict-human'; detail: string }
  | { kind: 'merge-failed'; msg: string }
> {
  const { taskId } = ports
  try {
    // RFC-193 K1: re-aggregate at wrapper-final time — the wrapper handle is
    // the one LONG-LIVED handle (inner nodes archived new port files during
    // its lifetime; the create-time roster predates them, design §4.5).
    const nodeTrees = await ports.binding.workspace.snapshotIsolatedWorkspace(wrapperIso, log, [
      ...(await ports.persistence.artifactPaths.forcedPaths(taskId)),
    ])
    // RFC-210 impl-gate: the handle rides along so a topology the snapshot
    // extended (submodule added inside the wrapper) survives into crash replay.
    await persistIsoNodeTree(ports.binding, wrapperRunId, nodeTrees, wrapperIso)
    const merge = await ports.writeSem.run(async () => {
      const mr = await ports.binding.workspace.mergeIsolatedWorkspace(wrapperIso, nodeTrees, log)
      if (mr.clean) return { kind: 'merged' as const }
      const res = await ports.conflicts.resolveMergeConflicts({
        conflicts: mr.conflicts,
        containerPath: wrapperIso.containerPath,
        conflictNodeRunId: wrapperRunId,
        nodeId: node.id,
        iteration,
      })
      return res.allResolved
        ? { kind: 'merged' as const }
        : { kind: 'conflict-human' as const, detail: res.detail }
    })
    if (merge.kind !== 'merged') {
      await ports.persistence.mergeStates.transition({
        nodeRunId: wrapperRunId,
        event: { kind: 'park-conflict-human', via: 'live' },
        ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
      })
      // D10: merge_state and status remain orthogonal. This adapter owns only
      // the merge fact; WrapperRunLedger performs the one status CAS and
      // WrapperRuntime publishes only after that write commits.
      return { kind: 'conflict-human', detail: merge.detail }
    }
    await ports.persistence.mergeStates.transition({
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merged', via: 'live' },
      ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
    })
    await discardNodeIso(ports.cleanup, wrapperIso, log, ports.writeSem)
    return { kind: 'merged' }
  } catch (err) {
    const msg = describeEffectError(err)
    const flipped = await ports.persistence.mergeStates.tryTransition({
      nodeRunId: wrapperRunId,
      event: { kind: 'mark-merge-failed', reason: msg },
      ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
    })
    if (!flipped) {
      log.warn('merge_state flip to merge-failed lost/illegal', { nodeRunId: wrapperRunId })
    }
    return { kind: 'merge-failed', msg }
  }
}
