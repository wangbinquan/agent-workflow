import type {
  InsightRunRequest,
  InsightRunResult,
  InsightRunner,
} from '@/modules/run-observability/public/participants'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import { createLogger } from '@/platform/logging/logger'
import type {
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../application/ports/systemAgentRunFamily'
import { DEFAULT_TIMEOUT_MS } from '../application/systemAgentRun'

const AGENT_NAME = 'process-insight'
const SYSTEM_PROMPT =
  'You group short pieces of text people wrote into recurring themes and suggest what to change ' +
  'so a theme stops recurring. You only analyse the text you are given: you do not perform ' +
  'tasks, read files or call tools. You answer with the one JSON object you are asked for.'

/**
 * RFC-616 §9.3 — the model call of a text-theme analysis, run through the
 * ordinary system agent family like change narratives and clarify follow-ups.
 * The call is recorded by run observation as system work of kind
 * `process-insight`, owned by whoever asked for the analysis and attached to no
 * task. It matches run-observability's runner port; bootstrap binds it.
 */
export function createProcessInsightGeneration(input: {
  readonly registry: RuntimeExecutionQueries
  readonly family: SystemAgentRunFamily
  readonly bindRuntime: <T extends { readonly binaryPath: string | null }>(
    profile: T,
  ) => Omit<T, 'binaryPath'> & {
    readonly runtimeBinding: SystemAgentRunRequest['runtimeBinding']
  }
  /**
   * The settings read at the moment of the call: the runtime chosen for process insight, and the default
   * runtime it falls back to through the registry's rule for internal agents.
   */
  readonly runtimeSelection: () => Promise<{
    readonly runtimeName: string | null
    readonly defaultRuntime: string | null
  }>
}): InsightRunner {
  const log = createLogger('process-insight')
  return {
    async run(request: InsightRunRequest): Promise<InsightRunResult> {
      const runtime = input.bindRuntime(
        await input.registry.resolveInternalAgentRuntime(await input.runtimeSelection()),
      )
      const result = await input.family.run({
        feature: 'process-insight',
        agentName: AGENT_NAME,
        observationDemand: {
          kind: 'process-insight',
          originalId: request.analysisId,
          originalAttempt: `${request.analysisId}:${request.attempt}`,
          name: `过程主题分析 · ${request.subjectName}`,
          ...(request.ownerUserId === null ? {} : { ownerUserId: request.ownerUserId }),
          purpose: 'system',
        },
        systemPrompt: SYSTEM_PROMPT,
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
        timeoutMs: DEFAULT_TIMEOUT_MS,
        log,
      })
      try {
        if (result.status !== 'ok') {
          return {
            ok: false,
            code: `run-${result.status}`,
            message: result.resultError ?? result.stderrTail,
          }
        }
        return { ok: true, answer: result.eventText }
      } finally {
        input.family.retainedContents.forget({ retainedRef: result.retainedRef })
      }
    },
  }
}
