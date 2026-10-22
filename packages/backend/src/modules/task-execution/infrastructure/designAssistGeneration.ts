import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type {
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '../application/ports/systemAgentRunFamily'
import { createLogger } from '@/util/log'
import { DEFAULT_TIMEOUT_MS } from '../application/systemAgentRun'

/** Ordinary System Agent invocation, including selected hosted material/execution owners. */
export function createDesignAssistGeneration(input: {
  registry: RuntimeExecutionQueries
  getDefaultRuntime: () => Promise<string | null | undefined>
  family: SystemAgentRunFamily
  bindRuntime: <T extends { readonly binaryPath: string | null }>(
    profile: T,
  ) => Omit<T, 'binaryPath'> & { readonly runtimeBinding: SystemAgentRunRequest['runtimeBinding'] }
}) {
  const log = createLogger('design-assist')
  return {
    async generate(request: {
      caseId: string
      requestId: string
      prompt: string
      signal: AbortSignal
    }) {
      const runtime = input.bindRuntime(
        await input.registry.resolveAgentRuntime(undefined, await input.getDefaultRuntime()),
      )
      const result = await input.family.run({
        feature: 'graph-design-assist',
        agentName: 'graph-design-assist',
        observationDemand: {
          kind: 'graph-design-assist',
          originalId: request.caseId,
          originalAttempt: request.requestId,
          name: '设计图辅助',
          purpose: 'system',
        },
        systemPrompt:
          'Return one JSON design proposal matching the supplied schema and catalog. Preserve all human answers exactly. A proposal is not a human approval or a test receipt. Never execute the business implementation.',
        // Full design/schema material exceeds Windows argv limits. The selected
        // material owner creates this file in the invocation workspace on both deployments.
        prompt:
          'Read graph-design-request.json in the current workspace. It contains the complete request, design, capability catalog and outputSchema. Return only the JSON proposal specified there.',
        seedFiles: [{ path: 'graph-design-request.json', content: request.prompt }],
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
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxEventTextBytes: 512 * 1024,
        log,
      })
      try {
        if (result.status !== 'ok')
          throw new Error(
            `graph-assist-${result.status}: ${result.resultError ?? result.stderrTail}`,
          )
        // Parsed event text can include the runtime's progress narration before
        // the final answer. Keep the complete object byte-for-byte; do not strip
        // fences inside JSON strings or select one of several competing objects.
        if (result.outputEvidence.eventTextCapHit) throw new Error('graph-assist-output-truncated')
        const start = result.eventText.indexOf('{')
        const end = result.eventText.lastIndexOf('}')
        if (start < 0 || end < start) throw new Error('graph-assist-json-missing')
        const text = result.eventText.slice(start, end + 1)
        if (result.eventText.slice(end + 1).includes('{'))
          throw new Error('graph-assist-output-incomplete')
        JSON.parse(text)
        return {
          invocationRef: `system:graph-design-assist:${request.caseId}:${request.requestId}`,
          outputJson: text,
        }
      } finally {
        input.family.retainedContents.forget({ retainedRef: result.retainedRef })
      }
    },
  }
}
