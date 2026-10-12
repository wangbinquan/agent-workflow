import { eq } from 'drizzle-orm'
import { DEFAULT_CONFIG_DIR_PROFILE } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import type { ClarifyFollowupGenerator } from '@/modules/collaboration/public/participants'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import { createLogger } from '@/util/log'
import type { SystemAgentObservationFactory } from '../application/ports/systemAgentObservation'
import { composeLocalSystemAgentRunFamily } from './localSystemAgentRunFamily'

/** Reuse the ordinary System executor with the asking run's frozen runtime. */
export function composeClarifyFollowupGenerator(input: {
  db: ProviderNeutralDatabase
  appHome: () => string
  registry: RuntimeExecutionQueries
  observations?: () => SystemAgentObservationFactory
}): ClarifyFollowupGenerator {
  const binding = composeLocalSystemAgentRunFamily({
    appHome: input.appHome,
    observations: input.observations,
  })
  return {
    async generate(request) {
      const row = (
        await input.db
          .select({
            protocol: nodeRuns.runtime,
            binaryPath: nodeRuns.runtimeBinary,
            params: nodeRuns.runtimeParamsJson,
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
      const runtime = binding.bindRuntime(
        row && (row.protocol === 'opencode' || row.protocol === 'claude-code')
          ? {
              protocol: row.protocol as RuntimeKind,
              binaryPath: row.binaryPath,
              model: typeof params.model === 'string' ? params.model : null,
              isSandbox: params.isSandbox === true,
              configDir:
                config && typeof config.env === 'string' && typeof config.name === 'string'
                  ? { env: config.env, name: config.name }
                  : DEFAULT_CONFIG_DIR_PROFILE[row.protocol],
            }
          : await input.registry.resolveRuntimeByName(undefined),
      )
      const result = await binding.family.run({
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
        workspaceScope: binding.family.workspaces.capture({ namespace: 'shared' }),
        abortSignal: request.signal,
        timeoutMs: 180000,
        maxEventTextBytes: 64000,
        log: createLogger('clarify-followup'),
      })
      try {
        if (result.status !== 'ok')
          throw new Error(
            `clarify-followup-${result.status}: ${result.resultError ?? result.stderrTail}`,
          )
        return result.eventText
      } finally {
        binding.family.retainedContents.forget({ retainedRef: result.retainedRef })
      }
    },
  }
}
