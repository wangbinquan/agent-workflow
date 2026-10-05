import { randomBytes } from 'node:crypto'
import { createLogger } from '@/util/log'
import { DEFAULT_TIMEOUT_MS, runRuntimeSmokeCore } from '../application/runtimeSmoke'
import type { PreparedRuntimeSmokeOptions, SmokeResult } from '../application/ports/runtimeSmoke'

/** The caller/root already selected the compatible material/execution family. */
export async function runPreparedRuntimeSmoke(
  opts: PreparedRuntimeSmokeOptions,
): Promise<SmokeResult> {
  const log = opts.log ?? createLogger('runtimeSmoke')
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const nonce = `awsmoke-${randomBytes(8).toString('hex')}`
  const preparation = opts.preparation
  return runRuntimeSmokeCore(opts, {
    log,
    timeoutMs,
    nonce,
    invocation: {
      workspace: preparation.workspace,
      prepareWorkspace: () => preparation.workspace.prepare(),
      compile: (prompt) =>
        preparation.compile({
          protocol: opts.protocol,
          injection: { mcps: [] },
          prompt,
          agentName: 'aw-smoke',
          systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
          resolvedProfiles: [
            [
              'aw-smoke',
              {
                model: opts.model ?? null,
                variant: null,
                temperature: null,
                steps: null,
                maxSteps: null,
                isSandbox: opts.isSandbox === true,
              },
            ],
          ],
          workspace: preparation.workspace.workspace,
          runContent: preparation.workspace.runContent,
          freshAgentRun: false,
          ...(opts.extraArgs !== undefined && opts.extraArgs.length > 0
            ? { extraArgs: opts.extraArgs }
            : {}),
          runtimeBinding: opts.runtimeBinding,
          nodeRunId: 'runtime-smoke',
          log,
        }),
    },
  })
}
