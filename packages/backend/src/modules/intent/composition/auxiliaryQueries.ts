import type { IntentPersistence } from '../application/ports/intentPersistence'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPlatformInventoryParticipant,
  IntentTurnRuntimeResolver,
} from '../application/ports/intentAuxiliaryQueries'

export function composeIntentTurnRuntimeResolver(
  persistence: IntentPersistence,
): IntentTurnRuntimeResolver {
  const resolver: IntentTurnRuntimeResolver = {
    async resolve(config) {
      const runtime = await persistence.resolveIntentRuntime(
        config.runtimeName ?? config.defaultRuntime ?? 'opencode',
      )
      const agentDefault = await persistence.resolveIntentRuntime(
        config.defaultRuntime ?? 'opencode',
      )
      return {
        runtime,
        effectiveDefaultRuntime: {
          name: agentDefault.name,
          protocol: agentDefault.protocol,
        },
      }
    },
  }
  return Object.freeze(resolver)
}

export function composeIntentDumpAuxiliaryQueries(input: {
  readonly persistence: IntentPersistence
  readonly defaultRuntime?: string
  readonly platformInventory: IntentPlatformInventoryParticipant
}): IntentDumpAuxiliaryQueries {
  const queries: IntentDumpAuxiliaryQueries = {
    runtimeInventory: Object.freeze({
      list: () => input.persistence.listIntentRuntimeInventory(),
      async resolveDefault() {
        const runtime = await input.persistence.resolveIntentRuntime(
          input.defaultRuntime ?? 'opencode',
        )
        return { name: runtime.name, protocol: runtime.protocol }
      },
    }),
    loadAgentPorts: (ids) => input.persistence.loadIntentAgentPortNames(ids),
    platformInventory: input.platformInventory,
  }
  return Object.freeze(queries)
}
