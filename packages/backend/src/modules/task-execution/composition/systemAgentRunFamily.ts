import type {
  SystemAgentInvocationFamily,
  SystemAgentRunFamily,
} from '../application/ports/systemAgentRunFamily'
import type {
  SystemAgentRetainedContents,
  SystemAgentWorkspaceScopes,
} from '@/modules/runtime-management/public/participants'
import {
  DEFAULT_MAX_EVENT_TEXT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runSystemAgentCore,
} from '../application/systemAgentRun'
import { createLogger } from '@/util/log'
import type { ExecutionRecoveryReferencePort } from '../application/ports/executionEffect'

/** One common business core, with a complete already-selected invocation family. */
export function composeSystemAgentRunFamily(input: {
  readonly invocations: SystemAgentInvocationFamily
  readonly retainedContents: SystemAgentRetainedContents
  readonly workspaces: SystemAgentWorkspaceScopes
  readonly recovery: ExecutionRecoveryReferencePort
}): SystemAgentRunFamily {
  const recovery = input.recovery
  const recoverReference = recovery?.recoverReference
  if (typeof recoverReference !== 'function')
    throw new Error('system-agent-recovery-contract-incomplete')
  const family = Object.freeze<SystemAgentRunFamily>({
    workspaces: input.workspaces,
    retainedContents: input.retainedContents,
    recovery: Object.freeze({
      recoverReference: (request) => recoverReference.call(recovery, request),
    }),
    async run(request) {
      const log = request.log ?? createLogger('systemAgentRun')
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const maxEventTextBytes = request.maxEventTextBytes ?? DEFAULT_MAX_EVENT_TEXT_BYTES
      const startedAt = Date.now()
      const retainedContents = family.retainedContents
      const forget = retainedContents.forget
      const invocation = input.invocations.open(request, log)
      let forgetInvocation: (() => void) | undefined
      try {
        const retainedRef = invocation.workspace.retainedRef
        forgetInvocation = () => forget.call(retainedContents, { retainedRef })
        return await runSystemAgentCore(request, {
          log,
          timeoutMs,
          maxEventTextBytes,
          startedAt,
          invocation,
          retainedRef,
        })
      } catch (error) {
        // A rejected invocation transfers no result reference to its caller.
        try {
          forgetInvocation?.()
        } catch (retirementError) {
          try {
            log.warn('system-agent-retained-reference-forget-failed', {
              feature: request.feature,
              err:
                retirementError instanceof Error
                  ? retirementError.message
                  : String(retirementError),
            })
          } catch {
            // Preserve the original invocation rejection, including raw values.
          }
        }
        throw error
      }
    },
  })
  return family
}
