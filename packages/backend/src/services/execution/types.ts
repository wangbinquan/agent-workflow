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
  TriggerContext,
} from '@agent-workflow/shared'
import type { StartCodeRoundInput } from '@/services/codeRoundContract'
import type { MultipartFilePart } from '@/services/launchMultipart'
import type { UploadLimits } from '@/services/upload'
import type { SourceTerminationSnapshot } from '@/modules/task-execution/public/types'

// RFC-304 adds the fourth: `code-round`. Registered in RFC-294's W2 input list
// so the eventual task-execution consolidation collects four kinds, not three.
export type ExecutionKind = 'workflow' | 'agent' | 'workgroup' | 'code-round'

export type ExecutionRef = { kind: ExecutionKind; id: string }

/**
 * Who is asking for this execution. `user` = an interactive HTTP launch (the
 * actor becomes the owner); `scheduled` = the RFC-159 scheduled-task loop
 * (stamps `tasks.scheduled_task_id`); `node` = a call node inside a running
 * parent task (RFC-243 PR-3/4 — carries the parent linkage + depth guard
 * input; rejected until those PRs land).
 */
export type ExecutionInvoker =
  | { type: 'user'; launchKind: 'direct-json' | 'direct-multipart' }
  | { type: 'scheduled'; scheduledTaskId: string }
  | { type: 'node'; parentTaskId: string; parentNodeRunId: string; invocationDepth: number }
  // RFC-257 — a webhook trigger fire (stamps tasks.webhook_trigger_id /
  // webhook_fire_id, same run-history-attribution discipline as `scheduled`).
  // RFC-269: triggerContext is execution input, not post-launch metadata. It
  // must ride the same request so the initial task INSERT publishes all three
  // fields before scheduler can observe the row.
  | {
      type: 'webhook'
      webhookTriggerId: string
      webhookFireId: string
      triggerContext: TriggerContext
      /** RFC-303: frozen by the durable launch guard; absent for legacy/unprotected fires. */
      sourceTerminationSnapshot?: SourceTerminationSnapshot
    }

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
   * RFC-304 — one round of a code capability. `refId` is the round id, which is
   * also what lands in `tasks.code_round_id`; there is no separate resource to
   * disagree with it, so this variant has no ref/payload mismatch check.
   *
   * Note this kind is NOT reachable from `invoker: {type:'user'}` in the sense
   * the others are: rounds are minted by the capability's state machine, not by
   * someone filling in the launch wizard. It rides the same executor anyway so
   * cancel / watch / outcome stay one vocabulary (design §D5).
   */
  | {
      kind: 'code-round'
      refId: string
      invoker: ExecutionInvoker
      payload: StartCodeRoundInput
    }

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
