import type {
  PreparedSystemAgentRunOptions,
  PreparedSystemAgentRunResult,
} from '../application/ports/systemAgentRun'
import {
  DEFAULT_MAX_EVENT_TEXT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runSystemAgentCore,
} from '../application/systemAgentRun'
import { createLogger } from '@/util/log'

/** Run the selected preparation through the shared System business core. */
export async function runPreparedSystemAgent(
  opts: PreparedSystemAgentRunOptions,
): Promise<PreparedSystemAgentRunResult> {
  const log = opts.log ?? createLogger('systemAgentRun')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxEventTextBytes = opts.maxEventTextBytes ?? DEFAULT_MAX_EVENT_TEXT_BYTES
  const startedAt = Date.now()
  const preparation = opts.preparation
  return runSystemAgentCore(opts, {
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
  })
}
