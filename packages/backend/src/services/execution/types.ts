// RFC-243 T1 — the unified executor contract. One vocabulary for "start an
// execution / read its outcome / wait for its terminal state / cancel it"
// across the three task-level execution kinds. The kind domain deliberately
// equals `taskExecutionKind()` (shared/schemas/task.ts) — parent/child links
// added by RFC-243 PR-2 are an orthogonal dimension and never change a task's
// kind.
//
// The executor does NOT re-model the per-kind launch inputs: the three wire
// schemas (StartTask / StartAgentTask / StartWorkgroupTask) stay authoritative
// (proposal D10 — wire freeze), what is unified is the verb set and the
// lifecycle around it.
import type {
  StartAgentTask,
  StartTask,
  StartWorkgroupTask,
  TaskStatus,
} from '@agent-workflow/shared'
import type { MultipartFilePart } from '@/services/launchMultipart'
import type { UploadLimits } from '@/services/upload'

export type ExecutionKind = 'workflow' | 'agent' | 'workgroup'

export type ExecutionRef = { kind: ExecutionKind; id: string }

/**
 * Who is asking for this execution. `user` = an interactive HTTP launch (the
 * actor becomes the owner); `scheduled` = the RFC-159 scheduled-task loop
 * (stamps `tasks.scheduled_task_id`); `node` = a call node inside a running
 * parent task (RFC-243 PR-3/4 — carries the parent linkage + depth guard
 * input; rejected until those PRs land).
 */
export type ExecutionInvoker =
  | { type: 'user' }
  | { type: 'scheduled'; scheduledTaskId: string }
  | { type: 'node'; parentTaskId: string; parentNodeRunId: string; invocationDepth: number }
  // RFC-257 — a webhook trigger fire (stamps tasks.webhook_trigger_id /
  // webhook_fire_id, same run-history-attribution discipline as `scheduled`).
  | { type: 'webhook'; webhookTriggerId: string; webhookFireId: string }

/**
 * Kind-discriminated start request (top-level `kind` discriminant so TS
 * narrows the payload union). `refId` is the target resource id and must agree
 * with the id the payload targets where the payload carries one (asserted by
 * the executor, not silently reconciled).
 */
export type StartExecutionRequest =
  | { kind: 'workflow'; refId: string; invoker: ExecutionInvoker; payload: StartTask }
  | {
      kind: 'agent'
      refId: string
      invoker: ExecutionInvoker
      payload: StartAgentTask
      uploads?: { parts: MultipartFilePart[]; limits: UploadLimits }
    }
  | { kind: 'workgroup'; refId: string; invoker: ExecutionInvoker; payload: StartWorkgroupTask }

/**
 * The unified result projection (design §1.3). `outputs` is {} for any
 * non-done task; `error` mirrors the tasks-row triple verbatim (repo
 * convention: error_summary is the human line, error_message carries the
 * machine code — projected as-is, not re-interpreted).
 */
export type ExecutionOutcome = {
  taskId: string
  status: TaskStatus
  terminal: boolean
  outputs: Record<string, { content: string; kind: string | null; archiveJson?: string | null }>
  /** Non-fatal projection notes (e.g. legacy workgroup task without a result anchor). */
  warnings: string[]
  error?: {
    summary: string | null
    message: string | null
    failedNodeId: string | null
  }
}
