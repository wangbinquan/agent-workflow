// RFC-243 T1/T2 — the unified executor facade (design §1.1). The ONE start
// choke point for all task-level execution kinds: routes, the scheduled-task
// loop and (from PR-3) call nodes go through `startExecution` instead of
// calling the per-kind launch services directly (source-text lock in
// rfc243-executor-facade.test.ts).
//
// Behavior freeze: each adapter is the pre-existing launch service called with
// an unchanged argument shape — validation order, error codes and side effects
// are byte-identical to the direct calls this facade replaced. Caller-level
// gates STAY at their call sites rather than moving into the facade: the JSON
// POST /api/tasks branch runs assertWorkflowLaunchable in the route, and
// scheduled/webhook fires run it via fireSchedule's assertScheduledTargetUsable
// (services/scheduledTasks.ts — so it is NOT absent there, just owned by the
// fire path; 2026-08-12 审计对账修正，此前这里写成 "deliberately absent from
// scheduled workflow fires"，与实际相反).
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { directTaskInitiatorFromActorSource } from '@/modules/task-execution/inbound/directTaskInitiator'
import type { Task } from '@agent-workflow/shared'
import type { StartTaskDeps } from '@/services/task'
import { cancelTask, startTask } from '@/services/task'
import { startAgentTask } from '@/services/agentLaunch'
import { startWorkgroupTask } from '@/services/workgroup/launch'
import { ValidationError } from '@/util/errors'
import type { ExecutionOutcome, StartExecutionRequest } from './types'
import { getExecutionOutcome } from './outcome'
import { watchTaskTerminal, type TerminalWatchResult } from './executionWatch'

function depsForInvoker(
  actor: Actor,
  deps: StartTaskDeps,
  req: StartExecutionRequest,
): StartTaskDeps {
  const invoker = req.invoker
  if (deps.launchProvenance !== undefined) {
    throw new ValidationError(
      'task-launch-provenance-conflict',
      'startExecution owns root provenance; callers may not pre-populate launchProvenance',
    )
  }
  if (invoker.type === 'scheduled') {
    return {
      ...deps,
      scheduledTaskId: invoker.scheduledTaskId,
      launchProvenance: { kind: 'schedule' },
    }
  }
  if (invoker.type === 'webhook') {
    // RFC-257/RFC-269: attribution and trigger inputs share one publication
    // boundary. startTask writes them in the initial INSERT before scheduler is
    // kicked; a follow-up UPDATE would race scheduler's one-time task read.
    return {
      ...deps,
      webhookTriggerId: invoker.webhookTriggerId,
      webhookFireId: invoker.webhookFireId,
      triggerContext: invoker.triggerContext,
      sourceTerminationSnapshot: invoker.sourceTerminationSnapshot,
      launchProvenance: { kind: 'webhook' },
    }
  }
  if (invoker.type === 'event') {
    return {
      ...deps,
      eventSubscriptionId: invoker.eventSubscriptionId,
      eventDeliveryId: invoker.eventDeliveryId,
      triggerContext: invoker.triggerContext,
      sourceTerminationSnapshot: invoker.sourceTerminationSnapshot,
      launchProvenance: { kind: 'event' },
    }
  }
  if (invoker.type === 'node') {
    // PR-3: the scheduler's call-node launcher supplies the full child deps
    // (callLaunch + synthesized inherited space). The facade only asserts the
    // invoker and the deps agree — a mismatch is a programming error.
    if (
      req.kind !== 'workflow' ||
      deps.callLaunch === undefined ||
      deps.callLaunch.parentTaskId !== invoker.parentTaskId ||
      deps.callLaunch.parentNodeRunId !== invoker.parentNodeRunId
    ) {
      throw new ValidationError(
        'execution-invoker-unsupported',
        'node-invoked executions require a matching callLaunch deps payload (workgroup calls ride startWorkgroupTaskFromFrozen — design §6.3)',
      )
    }
    return deps
  }
  return {
    ...deps,
    launchProvenance: {
      kind: invoker.launchKind,
      initiator: directTaskInitiatorFromActorSource(actor.source),
    },
  }
}

/**
 * Start an execution of `req.ref` with the kind-matching payload. Returns the
 * created Task exactly as the underlying launch service produced it.
 */
export async function startExecution(
  db: DbClient,
  actor: Actor,
  req: StartExecutionRequest,
  deps: StartTaskDeps,
): Promise<Task> {
  // Preserve the established mismatch diagnostic before consulting actor/deps.
  if (req.kind === 'workflow' && req.payload.workflowId !== req.refId) {
    throw new ValidationError(
      'execution-ref-mismatch',
      `ref targets workflow '${req.refId}' but payload.workflowId is '${req.payload.workflowId}'`,
    )
  }
  const effectiveDeps = depsForInvoker(actor, deps, req)
  // RFC-317 R4 —— 分派必须是**编译器能证明穷尽**的形式。
  //
  // 原本是 `if (agent) … if (workgroup) … return startTask(…)`：最后那个 return 是
  // **兜底**，将来给 StartExecutionRequest 加第四个变体时，它会被静默当成 workflow 走
  // startTask——一个新业务种类接错启动路径，而且没有任何测试会红。
  // 换成 switch + `_exhaustive: never`（本仓既有写法，见 shared/src/lifecycle.ts）后，
  // 漏掉一个变体是**编译错误**，而不是运行期的静默错路。行为与改前逐字一致。
  switch (req.kind) {
    case 'agent':
      return await startAgentTask(db, actor, req.refId, req.payload, effectiveDeps, req.uploads)
    case 'workgroup':
      return await startWorkgroupTask(db, actor, req.refId, req.payload, effectiveDeps)
    case 'workflow':
      // `refId` 与 payload 自带的目标必须一致——不一致是调用点的编程错误，已在函数
      // 开头（消费 actor/deps 之前）大声抛出，此处不再重复判断以保持错误优先级不变。
      return await startTask(req.payload, effectiveDeps)
    default: {
      const _exhaustive: never = req
      throw new Error(`unreachable execution kind: ${JSON.stringify(_exhaustive)}`)
    }
  }
}

/** Unified cancel verb — delegates to cancelTask (PR-2 adds the child cascade there). */
export async function cancelExecution(db: DbClient, taskId: string): ReturnType<typeof cancelTask> {
  return await cancelTask(db, taskId)
}

export type WatchExecutionResult =
  | { kind: 'outcome'; outcome: ExecutionOutcome }
  | { kind: 'missing' }
  | { kind: 'aborted' }

/**
 * Wait for the execution to reach a terminal status, then project its outcome.
 * `missing` = the task row disappeared (deleted) — never hangs; `aborted` =
 * the caller's signal fired first.
 */
export async function watchExecutionTerminal(
  db: DbClient,
  taskId: string,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<WatchExecutionResult> {
  const result: TerminalWatchResult = await watchTaskTerminal(db, taskId, opts)
  if (result.kind === 'terminal') {
    return { kind: 'outcome', outcome: await getExecutionOutcome(db, taskId) }
  }
  return result
}

export { getExecutionOutcome }
