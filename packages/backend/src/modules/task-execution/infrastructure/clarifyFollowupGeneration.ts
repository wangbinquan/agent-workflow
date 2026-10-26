import { nodeRunReadColumns } from './nodeRunQueries'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createLogger } from '@/util/log'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  RuntimeStatusEntrySchema,
  utf16MaxLength,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type {
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../application/ports/systemAgentRunFamily'
import { DEFAULT_TIMEOUT_MS } from '../application/systemAgentRun'
import { taskReadColumns } from './taskRepositorySql'

/**
 * RFC-372 follow-up generation for clarify rounds. Reads only Task Execution's
 * own records (the asking run's frozen runtime, the task's launcher inputs and
 * frozen workflow) and runs the ordinary System executor. It matches the
 * collaboration-owned generator port structurally; bootstrap checks the fit.
 */
export function createClarifyFollowupGeneration(input: {
  readonly db: PersistenceDb
  readonly registry: RuntimeExecutionQueries
  readonly family: SystemAgentRunFamily
  readonly bindRuntime: <T extends { readonly binaryPath: string | null }>(
    profile: T,
  ) => Omit<T, 'binaryPath'> & {
    readonly runtimeBinding: SystemAgentRunRequest['runtimeBinding']
  }
}) {
  const log = createLogger('clarify-followup')
  return {
    /** Bounded background: declared launcher inputs plus the asking node's
     * authored template (unexpanded, so no framework protocol text). */
    async context(request: { askingNodeRunId: string; taskId: string }) {
      const valueLimit = 4000,
        inputLimit = 8000,
        instructionLimit = 4000
      try {
        const { nodeRuns } = tablesOf(input.db)

        const { tasks } = tablesOf(input.db)
        const task = (
          await input.db
            .select({
              inputs: taskReadColumns(input.db).inputs,
              workflowSnapshot: taskReadColumns(input.db).workflowSnapshot,
            })
            .from(tasks)
            .where(eq(tasks.id, request.taskId))
            .limit(1)
        )[0]
        const run = (
          await input.db
            .select({ taskId: nodeRuns.taskId, nodeId: nodeRuns.nodeId })
            .from(nodeRuns)
            .where(eq(nodeRuns.id, request.askingNodeRunId))
            .limit(1)
        )[0]
        if (!task || run?.taskId !== request.taskId) return null
        const definition = JSON.parse(task.workflowSnapshot) as WorkflowDefinition
        const parsed: unknown = JSON.parse(task.inputs)
        const values =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {}
        let remaining = inputLimit,
          truncated = false
        const inputs: { key: string; label: string; value: string }[] = []
        for (const declared of definition.inputs ?? []) {
          const value = values[declared.key]
          const text =
            typeof value === 'string'
              ? value
              : typeof value === 'number' || typeof value === 'boolean'
                ? String(value)
                : Array.isArray(value) && value.every((item) => typeof item === 'string')
                  ? value.join('\n')
                  : null
          if (text === null || !text.trim()) continue
          if (remaining <= 0) {
            truncated = true
            break
          }
          const limit = Math.min(valueLimit, remaining)
          if (text.length > limit) truncated = true
          const shown = text.slice(0, limit)
          remaining -= shown.length
          inputs.push({ key: declared.key, label: declared.label, value: shown })
        }
        const node = definition.nodes.find((candidate) => candidate.id === run.nodeId) as
          | { promptTemplate?: unknown }
          | undefined
        const template =
          typeof node?.promptTemplate === 'string' && node.promptTemplate.trim()
            ? node.promptTemplate
            : null
        if (template && template.length > instructionLimit) truncated = true
        const instruction = template?.slice(0, instructionLimit) ?? null
        return inputs.length || instruction ? { inputs, instruction, truncated } : null
      } catch (error) {
        log.warn('clarify follow-up task context unavailable', {
          taskId: request.taskId,
          askingNodeRunId: request.askingNodeRunId,
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    },
    /** Reuse the ordinary System executor with the asking run's frozen runtime. */
    async generate(request: {
      askingNodeRunId: string
      taskId: string
      requestId: string
      prompt: string
      signal: AbortSignal
    }) {
      const { nodeRuns } = tablesOf(input.db)
      const nodeRunColumns = nodeRunReadColumns(input.db)
      const row = (
        await input.db
          .select({
            protocol: nodeRunColumns.runtime,
            binaryPath: nodeRunColumns.runtimeBinary,
            params: nodeRunColumns.runtimeParamsJson,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, request.askingNodeRunId))
          .limit(1)
      )[0]
      let params: Record<string, unknown> = {}
      try {
        const parsed: unknown = JSON.parse(row?.params ?? '{}')
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          params = parsed as Record<string, unknown>
      } catch {
        /* Legacy rows may have no usable frozen parameters. */
      }
      const config = params.__configDir as { env?: unknown; name?: unknown } | undefined
      const observation = z
        .object({
          registrationId: z.string().min(1),
          configurationRevision: z.number().int().nonnegative(),
          acceptedName: z.string().min(1).check(utf16MaxLength(200)).optional(),
        })
        .safeParse(params.__observation)
      const protocol = RuntimeStatusEntrySchema.shape.protocol.safeParse(row?.protocol)
      const runtime = input.bindRuntime(
        row && protocol.success
          ? {
              protocol: protocol.data,
              binaryPath: row.binaryPath,
              model: typeof params.model === 'string' ? params.model : null,
              isSandbox: params.isSandbox === true,
              ...(observation.success ? { observationIdentity: observation.data } : {}),
              configDir:
                config && typeof config.env === 'string' && typeof config.name === 'string'
                  ? { env: config.env, name: config.name }
                  : DEFAULT_CONFIG_DIR_PROFILE[protocol.data],
            }
          : await input.registry.resolveRuntimeByName(undefined),
      )
      const result = await input.family.run({
        feature: 'clarify-followup',
        agentName: 'clarify-followup',
        observationDemand: {
          kind: 'clarify-followup',
          originalId: request.askingNodeRunId,
          originalAttempt: request.requestId,
          name: '分支追问',
          parentTaskId: request.taskId,
          purpose: 'system',
        },
        systemPrompt:
          'Generate classified clarification questions from the provided conversation. Only ask questions; do not perform the business task.',
        prompt: request.prompt,
        protocol: runtime.protocol,
        runtimeBinding: runtime.runtimeBinding,
        configDirEnv: runtime.configDir.env,
        configDirName: runtime.configDir.name,
        model: runtime.model,
        isSandbox: runtime.isSandbox,
        ...(runtime.observationIdentity
          ? { runtimeObservationIdentity: runtime.observationIdentity }
          : {}),
        workspaceScope: input.family.workspaces.capture({ namespace: 'shared' }),
        abortSignal: request.signal,
        // Use the ordinary System Agent budget. Hosted startup and deep reasoning
        // can exceed the old three-minute cap before any answer is emitted.
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxEventTextBytes: 64000,
        log,
      })
      try {
        if (result.status !== 'ok')
          throw new Error(
            `clarify-followup-${result.status}: ${result.resultError ?? result.stderrTail}`,
          )
        return result.eventText
      } finally {
        input.family.retainedContents.forget({ retainedRef: result.retainedRef })
      }
    },
  }
}
