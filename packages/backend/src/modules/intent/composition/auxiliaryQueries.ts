import type { IntentPersistence } from '../application/ports/intentPersistence'
import type {
  IntentDumpAuxiliaryQueries,
  IntentPlatformInventoryParticipant,
  IntentTurnRuntimeResolver,
  IntentResolvedRuntime,
  IntentTurnResolvedRuntime,
} from '../application/ports/intentAuxiliaryQueries'

type RuntimeSelectionResolver<Runtime> = {
  resolve(input: Parameters<IntentTurnRuntimeResolver['resolve']>[0]): Promise<
    Omit<Awaited<ReturnType<IntentTurnRuntimeResolver['resolve']>>, 'runtime'> & {
      readonly runtime: Runtime
    }
  >
}

export function composeIntentTurnRuntimeResolver<Runtime = IntentTurnResolvedRuntime>(
  persistence: IntentPersistence,
  selectRuntime: (runtime: IntentResolvedRuntime) => Runtime,
): RuntimeSelectionResolver<Runtime> {
  const resolver: RuntimeSelectionResolver<Runtime> = {
    async resolve(config) {
      const runtime = await persistence.resolveIntentRuntime(
        config.runtimeName ?? config.defaultRuntime ?? 'opencode',
      )
      const agentDefault = await persistence.resolveIntentRuntime(
        config.defaultRuntime ?? 'opencode',
      )
      return {
        runtime: selectRuntime(runtime),
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
