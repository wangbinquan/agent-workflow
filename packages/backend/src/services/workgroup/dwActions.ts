// RFC-217 T4 — dynamic-workflow gate actions (confirm / save-as), split from
// taskActions to keep every workgroup module ≤800 lines (AC-1).

// RFC-217 T4 — workgroup task-room WRITE orchestration, moved verbatim out of
// routes/workgroupTasks.ts (366-line config PUT included). The route layer is
// transport only (params + status codes); every business step — membership
// gate, assignment state machine, room message rows, WS frames, resume kicks —
// lives here. G2 locks the room-table writes to this module.

import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import {} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DwState } from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { nodeRuns } from '@/db/schema'
import { DW_GATE_CAUSE, DW_MAX_REJECT_ROUNDS } from '@/services/dynamicWorkflowRunner'
import { buildWorkflowValidationContext, validateWorkflowDef } from '@/services/workflow.validator'
import { validateDynamicWorkflowDef } from '@/services/orchestratorAgent'
import { setNodeRunStatus, setTaskStatus } from '@/services/lifecycle'
import { emitTaskStatus, getTask, resumeDynamicWorkflowExecution } from '@/services/task'
import { createWorkflow } from '@/services/workflow'
import { assertNewRefsUsable, extractWorkflowAgentRefs } from '@/services/resourceRefs'
import { setDwState } from '@/services/workgroup/state'
import { ConflictError, ValidationError } from '@/util/errors'
import {} from '@/services/workgroup/lifecycle'
import {} from '@/services/workgroup/state'

import { ConfirmSchema, SaveAsWorkflowSchema } from '@/services/workgroup/taskActions'
import type { buildWorkgroupTaskActions } from '@/services/workgroup/taskActions'

type Core = ReturnType<typeof buildWorkgroupTaskActions>

export function buildDwActions(
  deps: { db: DbClient; configPath: string },
  core: Pick<Core, 'loadVisibleWorkgroupTask' | 'buildResumeDeps'>,
) {
  const { loadVisibleWorkgroupTask, buildResumeDeps } = core
  async function dwConfirm(actor: Actor, taskId: string, rawBody: unknown) {
    const { task, config, state } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = ConfirmSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-confirm-invalid', 'invalid confirm payload', {
        issues: parsed.error.issues,
      })
    }
    const dw = state.dwState
    if (
      config.mode !== 'dynamic_workflow' ||
      dw === null ||
      dw.phase !== 'awaiting_confirm' ||
      task.status !== 'awaiting_review'
    ) {
      throw new ConflictError(
        'workgroup-dw-gate-not-open',
        'the dynamic workflow confirm gate is not awaiting confirmation',
      )
    }

    // Codex impl-gate P1 (re-review): the entry snapshot above only serves the
    // fast gate check — every decision below re-loads the config row and
    // re-verifies the gate RIGHT BEFORE composing durable state, so a
    // concurrent PUT config (member/switch edit) landing mid-handler is
    // neither validated against nor overwritten. The residual fresh-read→CAS
    // microsecond window is a documented v1 residual (same posture as
    // consumeTasksAdd's same-instant insert race).
    async function freshGateView(): Promise<{
      config: WorkgroupRuntimeConfig
      dw: DwState
    }> {
      const fresh = await loadVisibleWorkgroupTask(actor, taskId)
      const freshDw = fresh.state.dwState
      if (
        fresh.config.mode !== 'dynamic_workflow' ||
        freshDw === null ||
        freshDw.phase !== 'awaiting_confirm' ||
        fresh.task.status !== 'awaiting_review'
      ) {
        throw new ConflictError(
          'workgroup-dw-gate-not-open',
          'the dynamic workflow confirm gate is not awaiting confirmation',
        )
      }
      return { config: fresh.config, dw: freshDw }
    }

    // Close the gate holder run(s) first (wg-confirm ordering precedent): the
    // decision is durable human input; a subsequently lost resume race leaves
    // the task re-parkable (the generate engine re-mints a holder on re-entry).
    const holders = (
      await deps.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.rerunCause, DW_GATE_CAUSE)))
    ).filter((r) => r.status === 'awaiting_review')

    if (parsed.data.decision === 'approve') {
      // Codex impl-gate P2: members / agents may have changed between
      // generation and this approval (mid-run config edits, agent deletion) —
      // re-run BOTH validation layers against the CURRENT context so a stale
      // proposal is refused here instead of failing (or silently escaping the
      // pool) at execution time. Reject-with-feedback regenerates against the
      // current pool. The long context load runs first; the fresh view comes
      // after it so the validated pool is the composed pool.
      const layer1Ctx = await buildWorkflowValidationContext(deps.db)
      const fresh = await freshGateView()
      const generated = WorkflowDefinitionSchema.safeParse(fresh.dw.generatedDef)
      if (!generated.success) {
        throw new ConflictError(
          'dw-generated-def-invalid',
          'the stored generated workflow is unreadable — reject with feedback to regenerate',
        )
      }
      const poolNames = fresh.config.members.flatMap((m) =>
        m.memberType === 'agent' && m.agentName !== null ? [m.agentName] : [],
      )
      const layer1 = validateWorkflowDef(generated.data, layer1Ctx)
      const layer2 = validateDynamicWorkflowDef(generated.data, poolNames)
      const staleIssues = [...layer1.issues, ...layer2.issues].filter(
        (i) => (i.severity ?? 'error') === 'error',
      )
      if (staleIssues.length > 0) {
        throw new ConflictError(
          'dw-generated-def-stale',
          'the generated workflow no longer validates against the current agent pool — reject with feedback to regenerate',
          { issues: staleIssues },
        )
      }
      for (const h of holders) {
        await setNodeRunStatus({
          db: deps.db,
          nodeRunId: h.id,
          to: 'done',
          allowedFrom: ['awaiting_review'],
          reason: 'dw-gate-approved',
        })
      }
      const { rejectionComment: _consumed, ...dwRest } = fresh.dw
      const nextDw: DwState = { ...dwRest, phase: 'executing' }
      await resumeDynamicWorkflowExecution(deps.db, taskId, buildResumeDeps(), {
        workflowSnapshot: JSON.stringify(generated.data),
        dw: nextDw,
      })
      return { decision: 'approve' }
    }

    // reject — ConfirmSchema guarantees a non-empty comment.
    const comment = parsed.data.comment ?? ''
    const fresh = await freshGateView()
    for (const h of holders) {
      await setNodeRunStatus({
        db: deps.db,
        nodeRunId: h.id,
        to: 'done',
        allowedFrom: ['awaiting_review'],
        reason: 'dw-gate-rejected',
      })
    }
    const rejectRounds = fresh.dw.rejectRounds + 1
    if (rejectRounds >= DW_MAX_REJECT_ROUNDS) {
      // Hard cap (design §8): repeated rejection is a signal the orchestrator
      // cannot satisfy the human — fail the task instead of looping forever.
      // The dw slot rides the SAME status CAS (extra whitelist) so a lost
      // race can't leave rounds counted on a task that never flipped.
      const nextDw: DwState = {
        ...fresh.dw,
        phase: 'rejected',
        rejectRounds,
        rejectionComment: comment,
      }
      await setTaskStatus({
        db: deps.db,
        taskId,
        to: 'failed',
        allowedFrom: ['awaiting_review'],
        extra: {
          finishedAt: Date.now(),
          errorSummary: 'dw-reject-exhausted',
          errorMessage: `dynamic workflow rejected ${rejectRounds} time(s) — DW_MAX_REJECT_ROUNDS reached`,
        },
        reason: 'dw-reject-exhausted',
      })
      // RFC-217 T2 — the checkpoint write follows the status CAS instead of
      // riding its extra-columns (dw now lives in workgroup_task_state). A
      // crash between the two leaves status=failed with phase stuck at
      // awaiting_confirm — benign: every dw gate requires status
      // awaiting_review, so nothing re-opens; the phase is display-only on a
      // terminal task.
      await setDwState(deps.db, taskId, nextDw)
      const failed = await getTask(deps.db, taskId)
      if (failed !== null) emitTaskStatus(failed)
      return { decision: 'reject', exhausted: true }
    }
    const { generatedDef: _dropped, ...dwRest } = fresh.dw
    const nextDw: DwState = {
      ...dwRest,
      phase: 'generating',
      generateAttempts: 0,
      rejectRounds,
      rejectionComment: comment,
    }
    // Codex impl-gate P1: the phase reset rides the resume ownership CAS —
    // NOT a separate write + fire-and-forget kick. A failed resume (lost CAS,
    // 410 worktree preflight) therefore leaves phase='awaiting_confirm' and
    // the gate re-triable, instead of stranding an awaiting_review task whose
    // phase already moved (generic /resume refuses turn-engine workgroup
    // tasks, so that stranding had no recovery path). The already-closed
    // holder is benign: the gate check reads (phase, status), and the
    // generate engine re-mints a holder on its awaiting_confirm branch.
    // RFC-217 T2: the write itself is setDwStateTx inside the claim tx.
    await resumeDynamicWorkflowExecution(deps.db, taskId, buildResumeDeps(), { dw: nextDw })
    return { decision: 'reject' }
  }

  async function dwSaveAsWorkflow(actor: Actor, taskId: string, rawBody: unknown) {
    const { config, state } = await loadVisibleWorkgroupTask(actor, taskId)
    const parsed = SaveAsWorkflowSchema.safeParse(rawBody)
    if (!parsed.success) {
      throw new ValidationError('workgroup-save-as-invalid', 'invalid save-as-workflow body', {
        issues: parsed.error.issues,
      })
    }
    const dw = state.dwState
    if (config.mode !== 'dynamic_workflow' || dw === null || dw.generatedDef === undefined) {
      throw new ConflictError(
        'dw-no-generated-workflow',
        'this task has no generated workflow to save',
      )
    }
    const generated = WorkflowDefinitionSchema.safeParse(dw.generatedDef)
    if (!generated.success) {
      throw new ConflictError(
        'dw-generated-def-invalid',
        'the stored generated workflow is unreadable',
      )
    }
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'agent', names: [...extractWorkflowAgentRefs(generated.data)] },
    ])
    const created = await createWorkflow(
      deps.db,
      {
        name: parsed.data.name,
        description: parsed.data.description ?? '',
        definition: generated.data,
      },
      { ownerUserId: actor.user.id },
    )
    return { id: created.id, name: created.name }
  }

  return { dwConfirm, dwSaveAsWorkflow }
}
