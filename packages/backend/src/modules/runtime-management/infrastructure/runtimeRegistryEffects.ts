import { readFileSync } from 'node:fs'
import { getRuntimeDriver, RUNTIME_KINDS, CLAUDE_PLATFORM_OWNED_FLAGS } from '@/services/runtime'
import type { RuntimeRegistryEffects } from '../application/ports/runtimeRegistryEffects'

export function createRuntimeRegistryEffects(): RuntimeRegistryEffects {
  return {
    protocols: RUNTIME_KINDS,
    ownedExtraArgFlags: CLAUDE_PLATFORM_OWNED_FLAGS,
    driver: (protocol) => getRuntimeDriver(protocol),
    readConfigText: (configPath) => readFileSync(configPath, 'utf8'),
  }
}
