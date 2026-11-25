// RFC-584: moved verbatim from task-execution composition/systemAgentRun.ts — only the RFC-370 selected-run contract test uses
// it; no production entry reaches it.
import type {
  PreparedSystemAgentRunOptions,
  PreparedSystemAgentRunResult,
} from '@/modules/task-execution/application/ports/systemAgentRun'
import {
  DEFAULT_MAX_EVENT_TEXT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runSystemAgentCore,
} from '@/modules/task-execution/application/systemAgentRun'
import { createLogger } from '@/platform/logging/logger'

/** Run the selected preparation through the shared System business core. */
export async function runPreparedSystemAgent(
  opts: PreparedSystemAgentRunOptions,
): Promise<PreparedSystemAgentRunResult> {
  const log = opts.log ?? createLogger('systemAgentRun')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxEventTextBytes = opts.maxEventTextBytes ?? DEFAULT_MAX_EVENT_TEXT_BYTES
  const startedAt = Date.now()
  const preparation = opts.preparation
  const coreInput: Omit<Parameters<typeof runSystemAgentCore>[1], 'retainedRef'> = {
    log,
    timeoutMs,
    maxEventTextBytes,
    startedAt,
    invocation: {
      workspace: preparation.workspace,
      acknowledgeStart: () => true,
      prepareWorkspace: () => preparation.workspace.prepare(opts.seedFiles),
      compile: () => preparation.compile(opts.intent),
    },
  }
  return runSystemAgentCore(opts, {
    ...coreInput,
    retainedRef: coreInput.invocation.workspace.retainedRef,
  })
}
