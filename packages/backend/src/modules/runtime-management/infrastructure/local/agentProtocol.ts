import type { AgentInvocationProtocol } from '../../application/ports/agentProtocol'
import type { RuntimeDriver } from '@/services/runtime/types'
import type { RuntimeUsageMeterInput } from '../../domain/usageMeter'

/** Explicit compatibility projection of pure protocol members. Lookup stays
 * lazy, optional absence stays absent, and methods retain the original driver
 * receiver. No physical capability is included in the returned view. */
export function bindNativeAgentProtocol(driver: RuntimeDriver): AgentInvocationProtocol {
  return {
    get kind() {
      return driver.kind
    },
    get capabilities() {
      return driver.capabilities
    },
    parseEvent(line) {
      return driver.parseEvent(line)
    },
    get usageMeter() {
      // Stream-only meter for callers without material evidence (no child environment).
      const method = driver.usageMeter
      return method === undefined
        ? undefined
        : (input: RuntimeUsageMeterInput) => method.call(driver, input)
    },
    get observeSystemEvent() {
      const method = driver.observeSystemEvent
      return method === undefined ? undefined : (line: string) => method.call(driver, line)
    },
    get parseTerminalResultError() {
      const method = driver.parseTerminalResultError
      return method === undefined ? undefined : (line: string) => method.call(driver, line)
    },
  }
}
