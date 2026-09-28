// RFC-370: raw legacy defaults must be read before schema parsing strips them.
import { readFileSync } from 'node:fs'
import type { RuntimeLegacyConfigurationPort } from '../../application/ports/runtimeRegistryEffects'

export function createFileRuntimeLegacyConfiguration(
  configPath: string,
): RuntimeLegacyConfigurationPort {
  return Object.freeze({ readText: () => readFileSync(configPath, 'utf8') })
}
