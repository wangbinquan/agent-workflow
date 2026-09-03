import { decideScopeOutcome } from '@/services/dispatchFrontier'
import { maybeRunCommitPush } from '@/services/scheduler'
import { deriveFrontier } from './dagFrontier'
import { buildScopeUpstreams, findScopeCycle } from './taskDagGraph'
import type { TaskScopeOutcome } from '../domain/taskEngine'
import type {
  NodeMechanicsResult,
  TaskMechanicsState,
  TaskScopeArgs,
} from '@/services/execution/taskMechanicsState'
import { executeNode } from './nodeExecution'
import type { WrapperRuntimeFactory } from './taskExecutionComponents'

export async function runScope(
  state: TaskMechanicsState,
  args: TaskScopeArgs,
  wrapperRuntimeFactory: WrapperRuntimeFactory,
): Promise<TaskScopeOutcome> {
  const { taskId, definition, opts } = state
  const { scopeId, scopeIds, containerRunId, iteration, log } = args

  // RFC-076 PR-B — completion-driven dispatch frontier (replaces the
  // snapshot-batch + Promise.all-barrier + rescan/recompute reconcile model).
  //
  // Each tick re-reads node_runs and re-derives the dispatchable frontier from
  // scratch (`deriveFrontier`); there is no mutable completed/remaining snapshot
  // to keep in sync, so the old `rescanScopeForNewPendingRows` (mid-execution
  // clarify answers) and `recomputeFreshnessAndDemote` (RFC-074 multi-hop
  // demotion) are subsumed — both effects fall out of re-deriving from the DB.
  //
  // Newly-ready nodes start IMMEDIATELY and we await the FIRST in-flight
  // completion (`Promise.race`), so a finished node's downstream dispatches the
  // instant its last upstream settles — no waiting on the slowest sibling in a
  // batch. RFC-130: every node runs in its OWN isolated worktree, so ALL nodes
  // run truly in parallel under the node pool (the `readonly` flag was removed —
  // there is no read/write distinction); `writeSem` only serializes the brief
  // per-node snapshot-at-dispatch (§段①) + merge-back (§段③), not the agent run.
  //
  // `scopeNodes` includes output sinks: each gets a virtual node_run mirroring
  // its upstream port content, so invariant T3 (task.done ⟹ every output node
  // has a done node_run) holds and the detail page reads outputs uniformly.
  const scopeNodes = definition.nodes.filter((n) => scopeIds.has(n.id))
  const upstreamsOf = buildScopeUpstreams(definition, scopeIds, scopeId, state.containerOf)
  const scopeNodeById = new Map(scopeNodes.map((n) => [n.id, n]))

  // Defensive cycle check for the dispatch graph. runTask topologically validates
  // the TOP scope at launch, but inner wrapper scopes (loop / git / fanout) were
  // never checked: a same-iteration data cycle between two inner nodes makes
  // areTransitiveUpstreamsCompleted false for both forever, so the scope goes
  // quiescent and fails with an opaque "scheduler stalled". Surface a clear cycle
  // error instead (channel/back edges are already dropped by buildScopeUpstreams,
  // so a cycle here is a genuine same-iteration data cycle). See
  // scheduler-boundary-intra-loop-cycle-stall.test.ts.
  const cycleNode = findScopeCycle(scopeNodes, upstreamsOf)
  if (cycleNode !== null) {
    return {
      kind: 'failed',
      detail: {
        summary: `cycle detected inside scope at node '${cycleNode}'`,
        message: 'scope-cycle',
        nodeId: cycleNode,
      },
    }
  }

  // In-flight node promises keyed by nodeId; `dispatchedThisInvocation` recovers
  // the per-invocation dedup the old `remaining.delete(n.id)` provided (N3): a
  // pure status read can't distinguish "failed row already (re-)dispatched this
  // call" from "failed row awaiting a fresh resume", so we remember what we
  // started. `parkedDetail` captures awaiting/failed summaries as they happen so
  // the terminal block can bubble the right message (a node parked in a PRIOR
  // invocation has no entry → falls back to '' / the generic detail, matching
  // the old `?? ''` wrapper bubbling).
  const inFlight = new Map<string, Promise<{ nodeId: string; result: NodeMechanicsResult }>>()
  const dispatchedThisInvocation = new Set<string>()
  // One top-level node can complete more than once in the same scope iteration:
  // a fresh pending clarify/review rerun is deliberately redispatched below.
  // Commit synthetics therefore need a trigger generation in addition to
  // nodeId+iteration; otherwise Map.set overwrites the older live Promise and
  // cancel/normal drain can return while that worktree writer still runs.
  let nextCommitPushSequence = 0
  // Synthetic publication stays non-blocking for the DAG, but two publication
  // attempts for the same canonical task worktree must never mutate its Git
  // index concurrently. The tail only orders commit synthetics created by this
  // scope invocation; ordinary node promises continue racing in `inFlight`.
  let commitPushTail: Promise<void> = Promise.resolve()
  // RFC-092 (audit S-1): pending anchor rows already released this invocation.
  // A node in `dispatchedThisInvocation` re-dispatches when an out-of-band
  // rerun mints a FRESH pending row (mid-run clarify answer / review
  // decision); this set bounds that bypass to one release per row id.
  const dispatchedPendingRowIds = new Set<string>()
  const parkedDetail = new Map<string, { summary: string; message: string }>()
  let firstFailureDetail: { summary: string; message: string; nodeId?: string } | undefined

  // RFC-098 B1: in-flight auto commit&push promises are keyed
  // 'commitpush:<nodeId>:<iter>:<sequence>' — a unique NON-node key, so
  // repeated same-node reruns cannot overwrite a still-live commit Promise;
  // deriveFrontier's in-flight node set never matches a scope node, so dispatch is
  // not frozen while a commit session runs (the synchronous await here used
  // to freeze the whole dispatch loop, audit S-17 second half). Canceled
  // exits MUST drain them (their inner runNode holds the shared signal and
  // returns quickly) — abandoning a commit session past runTask's finally
  // would orphan a worktree-writing process AND let the write-lock registry
  // gc race it (adversarial-review revision #2).
  const drainCommitPush = async (): Promise<void> => {
    const pending = [...inFlight.entries()].filter(([k]) => k.startsWith('commitpush:'))
    for (const [k, p] of pending) {
      try {
        await p
      } catch {
        /* commit failures never break task execution */
      }
      inFlight.delete(k)
    }
  }

  while (true) {
    if (opts.signal?.aborted === true) {
      // Cancel is a hard short-circuit: the abort already fired, so every live
      // child receives SIGTERM through the shared signal. Return immediately
      // without draining in-flight NODE promises — but commit&push synthetics
      // must be drained (see drainCommitPush above).
      await drainCommitPush()
      return { kind: 'canceled', detail: { summary: 'task canceled', message: 'signal aborted' } }
    }

    const handoffRequested =
      opts.executionContext !== undefined &&
      (await opts.persistence.intents.hasPendingGateSuccessor(taskId))

    let f: ReturnType<typeof deriveFrontier> | undefined
    if (!handoffRequested) {
      // RFC-140 W2 — auto-redispatch the auto-split-DEFERRED task questions (marker set at batch
      // dispatch + still undispatched + still staged) BEFORE deriving the frontier. The tick re-
      // enters after EVERY node-run completion, so the home whose in-flight rerun just finished
      // redispatches its deferred cause batch on this very tick (the in-flight gate inside
      // dispatchTaskQuestions releases on done, incl. done-no-output — RFC-133/139). Retryable
      // conflicts keep the marker for the next tick; non-recoverable ones clear it (WARN, back to
      // the manual board). Runs OUTSIDE lock B (dispatch acquires it internally). A successful
      // redispatch mints pending rows that the deriveFrontier below picks up in the same tick.
      await opts.taskDagCollaboration.autoDispatchDeferredQuestions(taskId)
      // RFC-311 (audit L2-4): the frontier consumes six scalar columns; the old
      // select() decoded every run's prompt_text + iso/inventory JSON on EVERY
      // scheduler tick (the tick re-enters after each node-run completion), so
      // long tasks made the scheduler itself the event-loop hog.
      const rows = await opts.persistence.nodeExecution.list({ taskId })
      const openClarify = await opts.taskDagCollaboration.loadOpenClarifyEvidence(taskId)
      // RFC-132 PR-B (universal deferred model): the park gate applies to ALL tasks now — a
      // sealed-undispatched entry (a designer waiting for its siblings — "park 等齐" — or a
      // self/questioner entry whose auto-dispatch was deferred by a recoverable conflict) parks its
      // home so the frontier never falsely completes the asking node on a clarify-only output
      // (RFC-076 T0). loadUndispatchedParkTargets returns EMPTY for a task with no sealed-undispatched
      // entries (every steady-state task the instant its answers dispatch), so this stays byte-for-byte
      // the old frontier for that case; the `deferredQuestionDispatch` flag is no longer read.
      // RFC-128 P5-BC (clean-path ③) + P5-D (Codex round-3 fix): the park set classifies designer +
      // self/questioner entries TOGETHER (loadUndispatchedParkTargets), NOT as the per-role UNION. The
      // union deadlocks a SAME-HOME node that holds an undispatched entry of one role AND an in-flight
      // rerun of another (the per-role designer source is blind to an in-flight questioner → parks the
      // node → stalls its pending rerun forever). The all-role partition is in-flight-aware across every
      // role, so such a node RUNS its in-flight rerun + re-parks next tick.
      const deferredHandlerNodeIds =
        await opts.taskDagCollaboration.loadUndispatchedParkTargets(taskId)
      f = deriveFrontier(
        rows,
        definition,
        scopeNodes,
        scopeIds,
        { containerRunId, iteration },
        upstreamsOf,
        new Set(inFlight.keys()),
        dispatchedThisInvocation,
        openClarify.clarifyNodeIds,
        openClarify.askingRunIds,
        dispatchedPendingRowIds,
        deferredHandlerNodeIds,
      )

      for (const nodeId of f.ready) {
        const node = scopeNodeById.get(nodeId)
        if (node === undefined) continue
        dispatchedThisInvocation.add(nodeId)
        const anchor = f.pendingAnchors.get(nodeId)
        if (anchor !== undefined) dispatchedPendingRowIds.add(anchor)
        inFlight.set(
          nodeId,
          executeNode(state, { node, containerRunId, iteration, log }, wrapperRuntimeFactory).then(
            (result) => ({ nodeId, result }),
          ),
        )
      }
    }

    if (inFlight.size === 0) {
      if (handoffRequested) return { kind: 'handoff' }
      if (f === undefined) throw new Error('task DAG frontier was not derived')
      // Quiescent — nothing running and nothing newly ready. The priority
      // decision (awaiting_human > awaiting_review > firstFailure > exhausted
      // > done > stalled) lives in the pure decideScopeOutcome (RFC-095,
      // dispatchFrontier.ts) so it is table-testable; the stalled branch now
      // names the blocked nodes (audit S-12) instead of a bare message.
      const outcome = decideScopeOutcome(f, firstFailureDetail)
      if (outcome.kind === 'awaiting_human' || outcome.kind === 'awaiting_review') {
        return { kind: outcome.kind, detail: detailFor(outcome.nodeId, parkedDetail) }
      }
      return outcome
    }

    const { nodeId, result } = await Promise.race(inFlight.values())
    inFlight.delete(nodeId)

    if (result.processUnreaped === true) {
      // Do not derive another frontier while an old framework child can still
      // write the canonical worktree. Existing siblings were already admitted;
      // let them settle, but mint no replacement work in this invocation.
      await Promise.allSettled(inFlight.values())
      inFlight.clear()
      return {
        kind: 'failed',
        processUnreaped: true,
        detail: {
          summary: result.summary,
          message: result.message,
          nodeId,
        },
      }
    }

    if (result.kind === 'canceled') {
      // Hard short-circuit (user-tripped signal): no point draining the rest
      // of the NODE promises; commit&push synthetics are drained (revision #2).
      await drainCommitPush()
      return {
        kind: 'canceled',
        detail: { summary: result.summary, message: result.message, nodeId },
      }
    }
    if (result.kind === 'awaiting_review' || result.kind === 'awaiting_human') {
      // Park: record the detail and re-derive next tick. Other branches may
      // still be in flight; only when the scope goes quiescent does the
      // terminal block bubble this up (priority canceled > awaiting_human >
      // awaiting_review > failed). An un-answered clarify cannot be silently
      // lost just because a sibling failed.
      parkedDetail.set(nodeId, { summary: result.summary, message: result.message })
      continue
    }
    if (result.kind === 'failed') {
      // Record the first failure but do NOT short-circuit — sibling branches
      // may still surface awaiting_human / awaiting_review. The failed row is
      // in `dispatchedThisInvocation`, so deriveFrontier will NOT re-dispatch
      // it this call (it lands in the `failed` bucket); a fresh invocation
      // (resume/retry) re-mints it via isDispatchable (N1).
      if (firstFailureDetail === undefined) {
        firstFailureDetail = { summary: result.summary, message: result.message, nodeId }
      }
      continue
    }
    // ok — RFC-075 auto commit&push after a top-level node completes (opt-in;
    // a commit failure must NEVER break task execution). RFC-098 B1: runs as
    // a SYNTHETIC in-flight entry instead of a synchronous await — the
    // dispatch loop keeps racing node completions and dispatching ready
    // nodes while the commit session runs. The synthetic resolves kind 'ok'
    // unconditionally (failures are logged inside).
    if (
      state.task.autoCommitPush &&
      state.topLevelIds.has(nodeId) &&
      !nodeId.startsWith('commitpush:')
    ) {
      const node = scopeNodeById.get(nodeId)
      if (node !== undefined) {
        const syntheticKey = `commitpush:${nodeId}:${iteration}:${nextCommitPushSequence++}`
        const commitWork = commitPushTail.then(() =>
          maybeRunCommitPush(state, node, iteration, log),
        )
        commitPushTail = commitWork.then(
          () => undefined,
          () => undefined,
        )
        inFlight.set(
          syntheticKey,
          commitWork
            .catch((err) => {
              log.warn('auto commit&push trigger failed (ignored)', {
                nodeId,
                syntheticKey,
                error: err instanceof Error ? err.message : String(err),
              })
              return {} as { processUnreaped?: true }
            })
            .then((commitResult) => ({
              nodeId: syntheticKey,
              result: (commitResult.processUnreaped === true
                ? {
                    kind: 'failed',
                    summary: 'commit agent child could not be reaped',
                    message: 'commit-agent-child-unreaped',
                    processUnreaped: true,
                  }
                : {
                    kind: 'ok',
                    summary: 'commit&push settled',
                    message: '',
                  }) as NodeMechanicsResult,
            })),
        )
      }
    }
  }
}

/**
 * RFC-076 PR-B — terminal detail for a parked / failed node when the scope goes
 * quiescent. A node parked THIS invocation has its summary/message captured in
 * `parked`; a node parked in a PRIOR invocation (e.g. a resume that never had to
 * re-run it) has no entry and falls back to '' — matching the old wrapper
 * bubbling (`subRes.detail?.summary ?? ''`) and the fact that the top-level
 * runTask ignores awaiting detail entirely (it only sets the task status chip).
 */
function detailFor(
  nodeId: string,
  parked: Map<string, { summary: string; message: string }>,
): { summary: string; message: string; nodeId: string } {
  const d = parked.get(nodeId)
  return { summary: d?.summary ?? '', message: d?.message ?? '', nodeId }
}
