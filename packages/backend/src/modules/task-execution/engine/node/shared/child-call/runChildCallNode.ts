import { DAEMON_RESTART_ERROR_SUMMARY, TERMINAL_TASK_STATUSES } from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type {
  ChildCallNodeExecutionPorts,
  ChildCallOutcome,
  ChildCallSlotHold,
  ChildCallTerminalWatch,
} from '../../../../application/ports/childCallNodeExecution'
import {
  childLaunchFailureCode,
  isToleratedChildCancelRace,
} from '../../../../application/childCallErrors'
import type { NodeStepOutcome, NodeStepRequest } from '../../../../domain/nodeExecution'
import { pickString } from '../../../../domain/nodeFields'
import { describeEffectError } from '../../../../domain/effectErrorDescription'
import {
  decodeCallHumanWait,
  encodeCallHumanWait,
  type CallHumanWait,
} from '../../../../domain/resourceLimitUsage'
import { taskCheckpointRefs } from '../../../../domain/taskCheckpoint'
import {
  awaitShutdownAbort,
  CALL_CHILD_OBSERVE_MS,
  isShutdownAbort,
  SHUTDOWN_CONFIRM_MS,
} from './childCallWatch'
import { launchCallChild, launchCallWorkgroupChild } from './launchChildCall'

// =============================================================================
// RFC-243 §6.2 — call-workflow node: invoke another workflow as an independent
// child task running INSIDE this node's iso worktree. From the parent's
// perspective the node is agent-shaped: derive iso → run (the child task) →
// write outputs → merge back; conflict parking, merge_state gating, replay and
// GC all reuse the RFC-130 machinery. Recovery (daemon restart, reap) re-enters
// through the SAME function: the frontier redispatches the interrupted row and
// the adoption block decides attach / resume-child / finalize instead of
// re-launching (design §4.2 — minting here would run the mint program's
// supersede closure over the child's canonical iso generation, so adoption
// NEVER mints).
//
// RFC-404: one body for call-workflow and call-workgroup (the selector field,
// launch arm and output projection differ); it holds no node-pool slot and
// does not run through runAssembly (RFC-243 P2-4, RFC-287 T9).
// =============================================================================

export async function runChildCallNode(
  ports: ChildCallNodeExecutionPorts,
  request: NodeStepRequest<'call-workflow'> | NodeStepRequest<'call-workgroup'>,
): Promise<NodeStepOutcome> {
  const { task, log } = ports
  const { taskId } = task
  const { node, iteration } = request

  const isWorkgroupCall = node.kind === 'call-workgroup'
  const selectorField = isWorkgroupCall ? 'workgroupName' : 'workflowName'
  const workflowName = pickString(node, selectorField) ?? undefined
  if (workflowName === undefined) {
    return {
      kind: 'failed',
      summary: `call node is missing its ${selectorField} selector`,
      message: 'workflow-call-ref-missing',
    }
  }
  // RFC-271 T6e：v2 闭包按边取（source = 本任务的工作流 id + 该 call 节点 id）；
  // v1 存量闭包由 accessor 内部回退到按名字取，**零迁移**。
  const callSource = { workflowId: task.workflowAnchorId, nodeId: node.id }
  const frozen = isWorkgroupCall
    ? null
    : ports.closure.frozenWorkflow(task.refClosureJson, workflowName, callSource)
  const frozenGroup = isWorkgroupCall
    ? ports.closure.frozenWorkgroup(task.refClosureJson, workflowName, callSource)
    : null
  if ((isWorkgroupCall ? frozenGroup : frozen) === null) {
    return {
      kind: 'failed',
      summary: `${isWorkgroupCall ? 'workgroup' : 'workflow'} '${workflowName}' is missing from the frozen call closure`,
      message: 'workflow-call-ref-missing',
    }
  }

  const { inputs: upstreamInputs, consumed: consumedUpstream } =
    await ports.input.resolveUpstreamInputs(node.id, {
      containerRunId: request.containerRunId,
      iteration,
    })
  const consumedUpstreamJson = ports.input.prepareConsumedInputs(consumedUpstream)

  // ---- locate the row: adopt an in-flight/interrupted call row, else reuse
  // pending, else mint (agent-path idiom; fanout shard rows never reach here —
  // the validator rejects call nodes inside wrapper-fanout in v1).
  const sameNodeIterRuns = await ports.ledger.listNodeRuns({
    taskId,
    nodeId: node.id,
    iteration,
  })
  let adoptedChildTaskId: string | null = null
  let launchedChildId: string | null = null
  let liveIso: IsoHandle | null = null
  // RFC-287 T8：取行前奏收编，但**领养区不进收编**——它复用一条 running /
  // interrupted / canceled 的行并就地转 running，与「铸行」是两码事（下面的
  // RFC-243-LOCK 说明为什么这里绝不能 mint）。以 preResolve 回调短路：拿到
  // latestExisting 后本线自己判领养，命中即整段前奏不执行。
  const resolvedCallRow = await ports.ledger.resolveSchedulerRunRow({
    taskId,
    containerRunId: request.containerRunId,
    nodeId: node.id,
    iteration,
    consumedUpstreamJson,
    rows: sameNodeIterRuns,
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'pending'),
    broadcastCanceled: (id) => ports.status.broadcastNodeStatus(taskId, id, node.id, 'canceled'),
    preResolve: async (latestExisting) => {
      // RFC-243-LOCK:adoption-no-mint-begin — this block re-attaches; minting
      // here would let the mint program's supersede closure retire the child's
      // canonical iso.
      // 实现门 P1-5：领养判据按「这一代是否已收尾」而不是单看 running/interrupted。
      // daemon shutdown 的收尾会把调用行落成 canceled（RFC-095 revival 语义下它
      // 仍是可复活行），只认 running/interrupted 会漏掉领养 → 重新 mint → 同一
      // 父任务下重复发起第二个子任务（rfc243-call-workflow 恢复矩阵实测）。
      // done/failed/exhausted 是已收尾代：retry 会 mint 新行，那条行 childTaskId
      // 为空，自然走下面的发起分支。
      const ADOPTABLE_CALL_ROW_STATUSES = new Set(['pending', 'running', 'interrupted', 'canceled'])
      if (
        latestExisting === undefined ||
        latestExisting.childTaskId === null ||
        latestExisting.childTaskId === undefined ||
        !ADOPTABLE_CALL_ROW_STATUSES.has(latestExisting.status)
      ) {
        return null
      }
      adoptedChildTaskId = latestExisting.childTaskId
      if (latestExisting.status !== 'running') {
        // Wrapper-revive escape hatch (RFC-053/095 precedent): the parked /
        // reaped / shutdown-canceled call row RESUMES in place — never a fresh
        // mint (see header).
        await ports.ledger.setNodeRunStatus({
          nodeRunId: latestExisting.id,
          to: 'running',
          allowedFrom: ['pending', 'interrupted', 'canceled'],
          allowTerminal: true,
          reason: 'call-adoption',
        })
        ports.status.broadcastNodeStatus(taskId, latestExisting.id, node.id, 'running')
      }
      log.info('call node adopted its in-flight child task', {
        nodeId: node.id,
        childTaskId: adoptedChildTaskId,
      })
      return { nodeRunId: latestExisting.id }
      // RFC-243-LOCK:adoption-no-mint-end
    },
  })
  const nodeRunId = resolvedCallRow.nodeRunId
  const latestExisting = resolvedCallRow.latestExisting
  if (!resolvedCallRow.adopted) {
    await ports.ledger.transitionNodeRunStatus({
      nodeRunId,
      event: { kind: 'mark-running' },
    })
    ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'running')

    // ---- gates BEFORE side effects: depth, then the global child budget
    // (ancestor-exempt scan grants — §3.2; the wait holds NO locks).
    const maxDepth = ports.budget.maxInvocationDepth()
    const childDepth = task.invocationDepth + 1
    if (childDepth > maxDepth) {
      await failCallRow(
        ports,
        nodeRunId,
        node.id,
        'invocation-depth-exceeded',
        `invocation depth ${childDepth} exceeds the configured ceiling ${maxDepth}`,
      )
      return {
        kind: 'failed',
        summary: `invocation depth ${childDepth} exceeds the configured ceiling ${maxDepth}`,
        message: 'invocation-depth-exceeded',
      }
    }
    const budget = await ports.budget.ensureBudget()
    const ancestors: string[] = [taskId]
    {
      let cursor = task.parentTaskId
      while (cursor !== null && !ancestors.includes(cursor)) {
        ancestors.push(cursor)
        cursor = await ports.budget.parentTaskId(cursor)
      }
    }
    let hold: ChildCallSlotHold
    try {
      const signal = ports.policy.signal
      hold = await budget.acquire(ancestors, {
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch {
      await failCallRow(
        ports,
        nodeRunId,
        node.id,
        'canceled',
        'canceled while queued for a child-task slot',
        'canceled',
      )
      return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
    }

    // ---- D: derive the child's workspace from THIS node's iso (slot first,
    // snapshot second — the agent path's slot-then-iso ordering, so a
    // long budget queue cannot serve the child a stale base).
    try {
      liveIso = await ports.workspace.createIsoUnderLock(nodeRunId)
    } catch (err) {
      hold.release()
      const msg = describeEffectError(err)
      await failCallRow(
        ports,
        nodeRunId,
        node.id,
        'iso-setup-failed',
        `isolated worktree setup failed: ${msg}`,
      )
      return {
        kind: 'failed',
        summary: 'isolated worktree setup failed',
        message: 'iso-setup-failed',
      }
    }
    if (!liveIso.passthrough) await ports.workspace.persistIsoBase(nodeRunId, liveIso)
    const childIso: IsoHandle = liveIso

    // ---- L: launch the child through the executor facade. The child task id
    // is pre-minted so the call row's childTaskId stamp lands BEFORE the
    // child INSERT — a crash between the two surfaces as `child-deleted`
    // (dangling stamp) instead of a duplicate child on redispatch.
    const childId = ports.children.newChildTaskId()
    await ports.ledger.patch({
      nodeRunId,
      values: {
        identity: {
          childTaskId: childId,
        },
      },
    })
    try {
      if (isWorkgroupCall) {
        await launchCallWorkgroupChild(ports, {
          node,
          nodeRunId,
          childId,
          frozenGroup: frozenGroup!,
          inputs: upstreamInputs,
          iso: childIso,
          childDepth,
          iteration,
          inheritedShardKey: latestExisting?.shardKey ?? null,
        })
      } else {
        await launchCallChild(ports, {
          node,
          nodeRunId,
          childId,
          frozen: frozen!,
          inputs: upstreamInputs,
          iso: childIso,
          childDepth,
        })
      }
      hold.bind(childId)
      ports.budget.registerKnownChildTask(childId)
      launchedChildId = childId
    } catch (err) {
      hold.release()
      await ports.ledger.patch({
        nodeRunId,
        values: {
          identity: {
            childTaskId: null,
          },
        },
      })
      await ports.workspace.discardNodeIso(liveIso)
      const code = childLaunchFailureCode(err)
      const msg = describeEffectError(err)
      await failCallRow(ports, nodeRunId, node.id, code, `child launch failed: ${msg}`)
      return { kind: 'failed', summary: `child launch failed: ${msg}`, message: code }
    }
  }
  if (adoptedChildTaskId === null && launchedChildId === null) {
    // unreachable — both arms either set an id or returned; guard for TS + drift.
    return {
      kind: 'failed',
      summary: 'call node resolved no child task',
      message: 'child-launch-failed',
    }
  }
  const childTaskId: string = adoptedChildTaskId ?? (launchedChildId as string)

  // ---- W: await the child's terminal state, keeping the §4.5 human-wait
  // ledger current (observed at CALL_CHILD_OBSERVE_MS granularity) and
  // re-driving an interrupted child once per observation (design §4.2 ②).
  // 实现门 P2-1 — the human-wait ledger belongs to ONE invocation generation:
  // adopt the persisted account only when re-attaching the SAME row; a fresh
  // mint (retry supersession) starts at zero, otherwise the superseded
  // generation's wait would be deducted twice (callRowHumanWait sums ALL call
  // rows of the task).
  let ledger: CallHumanWait =
    adoptedChildTaskId !== null
      ? decodeCallHumanWait(latestExisting?.wrapperProgressJson ?? null)
      : decodeCallHumanWait(null)
  const persistLedger = async (): Promise<void> => {
    try {
      await ports.ledger.patch({
        nodeRunId,
        values: {
          runtime: {
            wrapperProgressJson: encodeCallHumanWait(ledger),
          },
        },
      })
    } catch {
      // Best-effort progress telemetry; the child terminal observation remains authoritative.
    }
  }
  const observeChild = async (): Promise<void> => {
    const row = await ports.children.findStatus(childTaskId)
    const awaiting =
      row !== null && (row.status === 'awaiting_review' || row.status === 'awaiting_human')
    const now = Date.now()
    if (awaiting && ledger.openSince === null) {
      ledger = { ...ledger, openSince: now }
      await persistLedger()
    } else if (!awaiting && ledger.openSince !== null) {
      ledger = {
        accumulatedMs: ledger.accumulatedMs + Math.max(0, now - ledger.openSince),
        openSince: null,
      }
      await persistLedger()
    }
  }

  let resumeAttempted = false
  let outcomeStatus: string
  for (;;) {
    const obsTimer = setInterval(() => {
      void observeChild().catch(() => {})
    }, CALL_CHILD_OBSERVE_MS)
    let watched: ChildCallTerminalWatch
    try {
      const signal = ports.policy.signal
      watched = await ports.children.watchTerminal(childTaskId, {
        ...(signal !== undefined ? { signal } : {}),
        pollMs: 20_000,
      })
    } finally {
      clearInterval(obsTimer)
      await observeChild().catch(() => {})
    }
    if (watched.kind === 'aborted') {
      const shutdown = isShutdownAbort(ports.policy.signal)
      if (!shutdown) {
        // User cancel — cascade into the child (belt; cancelTask's own child
        // enumeration is the suspenders) and settle the row canceled.
        try {
          await ports.children.cancelChild(childTaskId)
        } catch (error) {
          // Preserve the legacy terminal/race tolerance without swallowing a
          // missing or broken topology adapter as cancellation success.
          if (!isToleratedChildCancelRace(error)) {
            throw error
          }
        }
        await failCallRow(ports, nodeRunId, node.id, 'canceled', 'task canceled', 'canceled')
        return { kind: 'canceled', summary: 'task canceled', message: 'signal aborted' }
      }
      // Daemon shutdown: leave the row running — boot reap flips it to
      // interrupted and adoption re-attaches on resume (child stays revivable).
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    if (watched.kind === 'missing') {
      await failCallRow(
        ports,
        nodeRunId,
        node.id,
        'child-deleted',
        `child task '${childTaskId}' row disappeared before finalize`,
      )
      return {
        kind: 'failed',
        summary: `child task '${childTaskId}' was deleted before its result was consumed`,
        message: 'child-deleted',
      }
    }
    outcomeStatus = watched.status
    // 实现门 P1-5 实测缺陷：daemon 关停时子任务先落 `interrupted`，watch 因此
    // 以 terminal（而非 aborted）返回；若继续按终态映射，就会把「整机关停」
    // 误判成「子任务不可恢复」→ 调用行 failed → 父任务 failed（而非可恢复的
    // interrupted），resume 时该行已终态、不再被领养 → 重复发起第二个子任务、
    // 旧子任务沦为孤儿。关停期一律不收尾：保持行 running，交给 boot reap 翻
    // interrupted，由 resume 的 adoption 续上（design §4.2）。
    if (isShutdownAbort(ports.policy.signal)) {
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    if (outcomeStatus === 'interrupted' && !resumeAttempted) {
      // §4.2 ② — parent-driven child recovery (independent of autoResumeOnBoot).
      resumeAttempted = true
      try {
        // RFC-285 B3 Q6（用户拍板）：resume 是既有子任务行的执行延续，
        // **豁免** owner-inactive 检查——D7 边界只拦「新任务创建」两臂。
        // 续跑端口只带 taskId；task 级继承的 runtime 由绑定补上，不重建 owner。
        await ports.children.resumeChild(childTaskId)
        continue
      } catch (error) {
        // A missing/broken driver method is a composition defect, not a child
        // lifecycle race. Preserve the legacy re-read path for business
        // failures, but never disguise a TypeError as successful reattachment.
        if (error instanceof TypeError) throw error
        const fresh = await ports.children.findStatus(childTaskId)
        if (
          fresh !== null &&
          !(TERMINAL_TASK_STATUSES as readonly string[]).includes(fresh.status)
        ) {
          continue // someone else revived it — re-attach
        }
        // 实现门 P1-5 加固：`task-active` means ANOTHER in-process driver still
        // owns the child (a shutdown still draining, a concurrent resume). Its
        // row may read terminal for the moment, but the owner is the authority
        // — re-attach and let the watch settle instead of declaring failure.
        if (ports.children.isTaskActive(childTaskId)) {
          await Bun.sleep(200)
          resumeAttempted = false
          continue
        }
        // 实现门 P1-5 实测缺陷（时序无关判据）：a child interrupted by the
        // DAEMON RESTART is not "unrecoverable" — the process is going down and
        // the parent's own row is about to be reaped to interrupted too.
        // Writing a terminal failure here would (a) fail the parent instead of
        // leaving it resumable and (b) drop the call row out of the adoption
        // set, so the next resume launches a SECOND child and orphans the
        // first. `opts.signal` is NOT a reliable discriminator — the child's
        // abort can land before the parent controller fires.
        if (
          fresh?.errorSummary === DAEMON_RESTART_ERROR_SUMMARY &&
          (await awaitShutdownAbort(ports.policy.signal, SHUTDOWN_CONFIRM_MS))
        ) {
          return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
        }
        await failCallRow(
          ports,
          nodeRunId,
          node.id,
          'child-interrupted',
          `child task '${childTaskId}' is interrupted and could not be resumed`,
        )
        return {
          kind: 'failed',
          summary: `child task '${childTaskId}' is interrupted and could not be resumed`,
          message: 'child-interrupted',
        }
      }
    }
    break
  }

  // ---- terminal child → finalize. Non-done children map per design §6.2.
  const outcome = await ports.children.outcome(childTaskId)
  if (outcome.status === 'canceled') {
    const cascade = outcome.error?.message === 'canceled-by-parent-cascade'
    if (cascade) {
      await failCallRow(ports, nodeRunId, node.id, 'canceled', 'canceled with parent', 'canceled')
      return { kind: 'canceled', summary: 'task canceled', message: 'canceled-with-parent' }
    }
    await failCallRow(
      ports,
      nodeRunId,
      node.id,
      'child-canceled',
      `child task '${childTaskId}' was canceled directly`,
    )
    return {
      kind: 'failed',
      summary: `child task '${childTaskId}' was canceled outside this parent`,
      message: 'child-canceled',
    }
  }
  if (outcome.status === 'interrupted') {
    // 实现门 P1-5（同一判据，终态映射侧）：daemon-restart 中断留给 boot reap
    // + adoption，绝不写成 call 行的终态失败。
    if (
      outcome.error?.summary === DAEMON_RESTART_ERROR_SUMMARY &&
      (await awaitShutdownAbort(ports.policy.signal, SHUTDOWN_CONFIRM_MS))
    ) {
      return { kind: 'canceled', summary: 'daemon shutdown', message: 'signal aborted' }
    }
    await failCallRow(
      ports,
      nodeRunId,
      node.id,
      'child-interrupted',
      `child task '${childTaskId}' stayed interrupted`,
    )
    return {
      kind: 'failed',
      summary: `child task '${childTaskId}' is interrupted and could not be resumed`,
      message: 'child-interrupted',
    }
  }
  if (outcome.status !== 'done') {
    const summary = outcome.error?.summary ?? `child task '${childTaskId}' failed`
    await failCallRow(
      ports,
      nodeRunId,
      node.id,
      'child-task-failed',
      `${summary}${outcome.error?.message ? ` (${outcome.error.message})` : ''}`,
    )
    return {
      kind: 'failed',
      summary: `child task failed: ${summary}`,
      message: 'child-task-failed',
    }
  }

  // ---- F: copy the child's projected outputs onto the call row (idempotent —
  // the merge_state-staged replay re-enters here). archiveJson rides along so
  // forcedPortPathsForTask keeps covering child-produced gitignored files.
  // 实现门 P1-3 — a call-workgroup node declares EXACTLY one output (`result`).
  // dw-mode children project raw workflow ports; collapse them into `result`
  // (lexicographic `## name` sections, design §6.3) so the declared port is
  // never silently empty.
  const projectedOutputs: ChildCallOutcome['outputs'] = isWorkgroupCall
    ? Object.hasOwn(outcome.outputs, 'result')
      ? { result: outcome.outputs.result! }
      : {
          result: {
            content: Object.entries(outcome.outputs)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, v]) => `## ${name}\n${v.content}`)
              .join('\n\n'),
            kind: 'text',
          },
        }
    : outcome.outputs
  await ports.ledger.upsertOutputs({
    nodeRunId,
    outputs: Object.entries(projectedOutputs).map(([portName, value]) => ({
      portName,
      content: value.content,
      kind: value.kind,
      archiveJson: ports.input.copyPortArchive(value.archiveJson ?? null),
      active: value.active !== false,
    })),
  })
  // Row goes done BEFORE merge (runner precedent) — downstream still gates on
  // merge_state (deriveFrontier D15), so nothing dispatches early.
  const currentRow = await ports.ledger.read(nodeRunId)
  if (currentRow !== null && currentRow.status !== 'done') {
    await ports.ledger.setNodeRunStatus({
      nodeRunId,
      to: 'done',
      allowedFrom: ['running'],
      extra: {
        identity: {
          finishedAt: Date.now(),
        },
      },
      reason: 'call-child-done',
    })
    ports.status.broadcastNodeStatus(taskId, nodeRunId, node.id, 'done')
  }

  // ---- M: merge the iso (the child's canonical) back into the parent
  // canonical, staged by merge_state (design §4.2 R):
  //   merged         → outputs re-written above; nothing to merge.
  //   conflict-human → still parked; resume replay owns completion.
  //   pending-merge  → the task-entry replayPendingMerges already merged (or
  //                    will on next resume) — treat like merged here if it
  //                    settled, else leave for replay.
  //   isolating/null → live merge (snapshots the iso final state itself).
  const mergeStateNow = currentRow?.mergeState ?? null
  if (mergeStateNow === 'conflict-human') {
    return {
      kind: 'awaiting_human',
      summary: 'merge conflict awaiting human resolution',
      message: 'merge-conflict',
    }
  }
  if (mergeStateNow === null && liveIso === null) {
    // Passthrough/mock harness adoption: nothing persisted to merge.
    return { kind: 'ok', summary: `child task ${childTaskId} done`, message: '' }
  }
  if (mergeStateNow !== 'merged') {
    let handle = liveIso
    if (handle === null) {
      // Adoption after restart — rebuild from persisted columns (replay idiom).
      const baseSnapshots = taskCheckpointRefs(currentRow?.checkpoints ?? [], 'isolationBase')
      if (Object.keys(baseSnapshots).length === 0) {
        await ports.workspace.markMergeFailed(nodeRunId, 'call adoption: iso base snapshot missing')
        return {
          kind: 'failed',
          summary: 'call adoption could not rebuild the iso handle (base snapshot missing)',
          message: 'merge-back-failed',
        }
      }
      handle = await ports.workspace.restoreIso({
        nodeRunId,
        workspaceRef: currentRow?.isoWorktreePath ?? null,
        baseSnapshots,
        checkpoints: currentRow?.checkpoints ?? [],
      })
    }
    if (!handle.passthrough) {
      try {
        const merge = await ports.workspace.mergeBackAndSettle({
          handle,
          nodeRunId,
          via: 'live',
          conflictResolver: (conflicts, containerPath) =>
            ports.conflicts.resolveMergeConflicts({
              conflicts,
              containerPath,
              conflictNodeRunId: nodeRunId,
              nodeId: node.id,
              iteration,
            }),
        })
        if (merge.kind === 'conflict-human') {
          log.warn('call merge-back conflict unresolved → awaiting_human', {
            nodeId: node.id,
            detail: merge.detail,
          })
          return {
            kind: 'awaiting_human',
            summary: `merge conflict unresolved: ${merge.detail}`,
            message: 'merge-conflict',
          }
        }
      } catch (err) {
        const msg = describeEffectError(err)
        log.warn('call merge-back failed', { nodeId: node.id, error: msg })
        await ports.workspace.markMergeFailed(nodeRunId, msg)
        return {
          kind: 'failed',
          summary: `merge-back failed: ${msg}`,
          message: 'merge-back-failed',
        }
      }
    }
    await ports.workspace.discardNodeIso(handle)
  }
  return { kind: 'ok', summary: `child task ${childTaskId} done`, message: '' }
}

/** Settle a call row into a terminal status with its failure metadata. */
async function failCallRow(
  ports: ChildCallNodeExecutionPorts,
  nodeRunId: string,
  nodeId: string,
  failureCode: string,
  errorMessage: string,
  to: 'failed' | 'canceled' = 'failed',
): Promise<void> {
  const ok = await ports.ledger
    .setNodeRunStatus({
      nodeRunId,
      to,
      allowedFrom: ['pending', 'running'],
      extra: {
        identity: {
          finishedAt: Date.now(),
          errorMessage,
          failureCode,
        },
      },
      reason: 'call-settle',
    })
    .then(() => true)
    .catch(() => false)
  if (ok) ports.status.broadcastNodeStatus(ports.task.taskId, nodeRunId, nodeId, to)
}
