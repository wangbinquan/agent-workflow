// RFC-242 T1/T2 — the unified executor facade (design §1.1). The ONE start
// choke point for all task-level execution kinds: routes, the scheduled-task
// loop and (from PR-3) call nodes go through `startExecution` instead of
// calling the per-kind launch services directly (source-text lock in
// rfc242-executor-facade.test.ts).
//
// Behavior freeze: each adapter is the pre-existing launch service called with
// an unchanged argument shape — validation order, error codes and side effects
// are byte-identical to the direct calls this facade replaced. Route-level
// gates that were never part of the universal launch path (e.g.
// assertWorkflowLaunchable on the JSON POST /api/tasks branch — deliberately
// absent from scheduled workflow fires) STAY at their call sites.
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { Task } from '@agent-workflow/shared'
import type { StartTaskDeps } from '@/services/task'
import { cancelTask, startTask } from '@/services/task'
import { startAgentTask } from '@/services/agentLaunch'
import { startWorkgroupTask } from '@/services/workgroup/launch'
import { ValidationError } from '@/util/errors'
import type { ExecutionOutcome, StartExecutionRequest } from './types'
import { getExecutionOutcome } from './outcome'
import { watchTaskTerminal, type TerminalWatchResult } from './executionWatch'

function depsForInvoker(deps: StartTaskDeps, req: StartExecutionRequest): StartTaskDeps {
  const invoker = req.invoker
  if (invoker.type === 'scheduled') {
    return { ...deps, scheduledTaskId: invoker.scheduledTaskId }
  }
  if (invoker.type === 'node') {
    // Parent-child launches land with RFC-242 PR-3 (call-workflow) / PR-4
    // (call-workgroup). Fail closed until the linkage columns + guards exist.
    throw new ValidationError(
      'execution-invoker-unsupported',
      'node-invoked executions land with RFC-242 PR-3/PR-4',
    )
  }
  return deps
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
  const effectiveDeps = depsForInvoker(deps, req)
  if (req.kind === 'agent') {
    return await startAgentTask(db, actor, req.refId, req.payload, effectiveDeps, req.uploads)
  }
  if (req.kind === 'workgroup') {
    return await startWorkgroupTask(db, actor, req.refId, req.payload, effectiveDeps)
  }
  // workflow — `refId` and the payload's own target must agree; a mismatch is
  // a programming error at the call site, surfaced loudly instead of silently
  // trusting one side.
  if (req.payload.workflowId !== req.refId) {
    throw new ValidationError(
      'execution-ref-mismatch',
      `ref targets workflow '${req.refId}' but payload.workflowId is '${req.payload.workflowId}'`,
    )
  }
  return await startTask(req.payload, effectiveDeps)
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
