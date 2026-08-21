// RFC-310 PR-11 — TaskEngine-backed program executor for digital employees.
//
// `scriptRef` is `<workflow-id>@<sha256(stored definition)>`.  The referenced
// workflow must contain exactly one Script node; its body/dependencies/env are
// copied into a synthesized immutable host snapshot.  This gives programs the
// same scheduler, cancellation, worktree isolation, envelope validation and
// workspace rollback path as Agent attempts without executing a subprocess
// directly from development-automation.

import { eq } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import {
  isTerminalTaskStatus,
  ScriptNodeSchema,
  type StartTask,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks, workflows } from '@/db/schema'
import { sha256Hex } from '@/util/hash'
import { getExecutionOutcome, watchExecutionTerminal } from '@/services/execution/executor'
import { cancelTask, startTask, type StartTaskDeps } from '@/services/task'
import { normalizeTaskPlatformInputPaths } from '@/services/taskPlatformInputPaths'
import {
  DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
  DIGITAL_EMPLOYEE_PROMPT_KEY,
  DIGITAL_EMPLOYEE_RESULT_PORT,
  synthesizeDigitalEmployeeScriptHostSnapshot,
} from '../domain/digitalEmployeeHost'
import {
  ensureDigitalEmployeeHostWorkflow,
  type AgentExecutionFailure,
  type DigitalEmployeeExecutionSnapshot,
} from './agentActionExecution'

export interface DigitalEmployeeScriptLaunchInput {
  readonly actionRunId: string
  readonly capabilityId: string
  readonly scriptRef: string
  readonly prompt: string
  readonly workspacePath: string
  readonly baselineSha: string
  readonly platformInputPaths: readonly string[]
  readonly wallTimeMs: number | null
}

export interface ScriptActionExecutionRunner {
  launch(
    input: DigitalEmployeeScriptLaunchInput,
  ): Promise<
    | { readonly ok: true; readonly executionRef: string }
    | { readonly ok: false; readonly failure: AgentExecutionFailure }
  >
  fetchOutcome(executionRef: string): Promise<DigitalEmployeeExecutionSnapshot>
  cancel(
    executionRef: string,
  ): Promise<{ readonly settled: 'canceled' | 'already-terminal' | 'not-found' }>
}

function fail(
  category: AgentExecutionFailure['category'],
  code: string,
  retryability: AgentExecutionFailure['retryability'],
  remediation: string,
): { ok: false; failure: AgentExecutionFailure } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

function parseScriptRef(value: string): { workflowId: string; digest: string } | null {
  const at = value.lastIndexOf('@')
  if (at <= 0) return null
  const digest = value.slice(at + 1)
  return /^[0-9a-f]{64}$/.test(digest) ? { workflowId: value.slice(0, at), digest } : null
}

export function composeScriptActionExecution(deps: {
  readonly db: DbClient
  readonly startDeps: StartTaskDeps
  readonly onTerminal?: (executionRef: string) => void
  readonly terminalPollMs?: number
}): ScriptActionExecutionRunner {
  const { db } = deps
  return {
    async launch(input) {
      if (!/^[0-9a-f]{40}$/.test(input.baselineSha)) {
        return fail(
          'contract-violation',
          'de-baseline-invalid',
          'never',
          'baselineSha must be 40-hex',
        )
      }
      if (!existsSync(join(input.workspacePath, '.git'))) {
        return fail(
          'configuration',
          'de-workspace-unavailable',
          'after-configuration',
          'action workspace is not a git checkout',
        )
      }
      const platformInputPaths = normalizeTaskPlatformInputPaths(input.platformInputPaths)
      if (platformInputPaths === null) {
        return fail('contract-violation', 'de-input-mount-invalid', 'never', 'invalid input mounts')
      }
      const parsedRef = parseScriptRef(input.scriptRef)
      if (parsedRef === null) {
        return fail(
          'configuration',
          'de-script-ref-invalid',
          'after-configuration',
          'scriptRef must be workflow-id@definition-sha256',
        )
      }
      const row = db
        .select({ definition: workflows.definition })
        .from(workflows)
        .where(eq(workflows.id, parsedRef.workflowId))
        .get()
      if (row === undefined || sha256Hex(row.definition) !== parsedRef.digest) {
        return fail(
          'configuration',
          'de-script-revision-unavailable',
          'after-configuration',
          'publish a new exact script reference; the workflow is missing or changed',
        )
      }
      let definition: WorkflowDefinition
      try {
        definition = JSON.parse(row.definition) as WorkflowDefinition
      } catch {
        return fail(
          'configuration',
          'de-script-definition-invalid',
          'after-configuration',
          'invalid workflow JSON',
        )
      }
      const scriptNodes = definition.nodes.filter((node) => node.kind === 'script')
      if (scriptNodes.length !== 1) {
        return fail(
          'configuration',
          'de-script-node-count-invalid',
          'after-configuration',
          'the referenced workflow must contain exactly one Script node',
        )
      }
      const script = ScriptNodeSchema.safeParse(scriptNodes[0])
      if (!script.success) {
        return fail(
          'configuration',
          'de-script-node-invalid',
          'after-configuration',
          script.error.issues[0]?.message ?? 'invalid Script node',
        )
      }

      await ensureDigitalEmployeeHostWorkflow(db)
      const taskId = ulid()
      const startInput: StartTask = {
        workflowId: DIGITAL_EMPLOYEE_HOST_WORKFLOW_ID,
        name: `de-script:${input.capabilityId}:${input.actionRunId}`.slice(0, 255),
        inputs: { [DIGITAL_EMPLOYEE_PROMPT_KEY]: input.prompt },
        ...(input.wallTimeMs === null ? {} : { maxDurationMs: input.wallTimeMs }),
      }
      let task: { id: string }
      try {
        task = await startTask(startInput, {
          ...deps.startDeps,
          digitalEmployeeLaunch: {
            actionRunId: input.actionRunId,
            snapshotJson: JSON.stringify(
              synthesizeDigitalEmployeeScriptHostSnapshot({
                inputPort: DIGITAL_EMPLOYEE_PROMPT_KEY,
                language: script.data.language,
                script: script.data.script,
                dependencies: script.data.dependencies ?? [],
                env: script.data.env ?? {},
                readonly: script.data.readonly === true,
              }),
            ),
          },
          internalSource: {
            kind: 'local-path',
            repoPath: input.workspacePath,
            baseBranch: input.baselineSha,
          },
          platformInputPaths,
          preCreatedWorktree: {
            taskId,
            worktreePath: input.workspacePath,
            branch: '',
            baseCommit: input.baselineSha,
            cleanup: { kind: 'borrowed' },
          },
          ...(deps.startDeps.launchProvenance === undefined &&
          deps.startDeps.callLaunch === undefined
            ? { launchProvenance: { kind: 'direct-json' as const, initiator: 'api' as const } }
            : {}),
        })
      } catch (error) {
        return fail(
          'transient',
          'de-script-launch-failed',
          'same-input',
          error instanceof Error ? error.message.slice(0, 300) : 'startTask failed',
        )
      }
      if (deps.onTerminal !== undefined) {
        const notify = deps.onTerminal
        void watchExecutionTerminal(db, task.id, { pollMs: deps.terminalPollMs ?? 1_000 })
          .then(() => notify(task.id))
          .catch(() => {})
      }
      return { ok: true, executionRef: task.id }
    },
    async fetchOutcome(executionRef) {
      const row = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (row === undefined) return { kind: 'not-found', executionRef }
      if (!isTerminalTaskStatus(row.status))
        return { kind: 'pending', executionRef, taskStatus: row.status }
      const outcome = await getExecutionOutcome(db, executionRef)
      return {
        kind: 'exited',
        executionRef,
        taskStatus: row.status as 'done' | 'failed' | 'canceled' | 'interrupted',
        resultText: outcome.outputs[DIGITAL_EMPLOYEE_RESULT_PORT]?.content ?? null,
        errorSummary: outcome.error?.summary ?? null,
        errorMessage: outcome.error?.message ?? null,
      }
    },
    async cancel(executionRef) {
      const row = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, executionRef))
        .get()
      if (row === undefined) return { settled: 'not-found' }
      if (isTerminalTaskStatus(row.status)) return { settled: 'already-terminal' }
      try {
        await cancelTask(db, executionRef)
        return { settled: 'canceled' }
      } catch {
        return { settled: 'already-terminal' }
      }
    },
  }
}
