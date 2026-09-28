import type { RuntimeObservationQueries } from '../public/queries'
import type { RuntimeRegistryOperations } from './ports/runtimeRegistry'

/** Pricing never loads launch material, tests a model or writes a runtime profile. */
export function createRuntimeObservationQueries(
  registry: Pick<RuntimeRegistryOperations, 'listRuntimes'>,
): RuntimeObservationQueries {
  return {
    async directory() {
      return {
        runtimes: (await registry.listRuntimes()).map((row) => ({
          registrationId: row.id,
          name: row.name,
          configurationRevision: row.probeFence,
          protocol: row.protocol,
          model: row.model,
          enabled: row.enabled,
        })),
      }
    },
  }
}
