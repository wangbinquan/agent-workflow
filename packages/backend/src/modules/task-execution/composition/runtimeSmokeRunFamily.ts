import { randomBytes } from 'node:crypto'
import { createLogger } from '@/util/log'
import { DEFAULT_TIMEOUT_MS, runRuntimeSmokeCore } from '../application/runtimeSmoke'
import type {
  RuntimeSmokeInvocationFamily,
  RuntimeSmokeRunFamily,
} from '../application/ports/runtimeSmoke'

/** Opening reads the selected protocol at the original driver boundary;
 * workspace materialization follows the original nonce allocation. */
export function composeRuntimeSmokeRunFamily(input: {
  readonly invocations: RuntimeSmokeInvocationFamily
}): RuntimeSmokeRunFamily {
  return Object.freeze<RuntimeSmokeRunFamily>({
    async run(request) {
      const log = request.log ?? createLogger('runtimeSmoke')
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
      const opened = input.invocations.open(request, log)
      const nonce = `awsmoke-${randomBytes(8).toString('hex')}`
      const invocation = opened.materialize()
      return runRuntimeSmokeCore(request, { log, timeoutMs, nonce, invocation })
    },
  })
}
