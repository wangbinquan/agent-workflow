import { getRuntimeDriver } from '@/services/runtime'
import type { RuntimeBinaryConfig, RuntimeProbe } from '@/services/runtime/types'
import type { RuntimeKind } from '../../public/types'

/**
 * RFC-487: probe a protocol's default binary as configured — the driver's own `probe(defaultBinary(config)[0])`, returned
 * unchanged — and expose the driver's minimum version for callers that log it. Only bootstrap binds it: the native doctor
 * receives it through system-operations' own port, and the standalone start uses it for the soft claude-code probe.
 */
export function createDefaultRuntimeBinaryProbe() {
  return Object.freeze({
    async probe(protocol: RuntimeKind, config: RuntimeBinaryConfig): Promise<RuntimeProbe> {
      const driver = getRuntimeDriver(protocol)
      return await driver.probe(driver.defaultBinary(config)[0]!)
    },
    minVersion(protocol: RuntimeKind): string | null {
      return getRuntimeDriver(protocol).minVersion
    },
  })
}
