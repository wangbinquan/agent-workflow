import { opencodeUsageDatabasePath } from '@/services/runtime'
import { sha256Hex } from '@/util/hash'
import { opencodeNativeStoreGeneration } from '../infrastructure/opencodeNativeStoreGeneration'
import { openHistoricalOpencodeUsagePass } from '../infrastructure/opencodeUsagePass'
import type { HistoricalNativeUsageQuery } from '../application/ports/historicalNativeUsage'

/** Reads the actual native artifact under the original daemon environment; no current model/rate lookup. */
export function createHistoricalNativeUsageQuery(
  env: Readonly<Record<string, string | undefined>>,
): HistoricalNativeUsageQuery {
  const path = opencodeUsageDatabasePath(env)
  return {
    generation: () => (path === null ? Promise.resolve(null) : opencodeNativeStoreGeneration(path)),
    async open(input) {
      if (path === null) return null
      const sourceGeneration = await opencodeNativeStoreGeneration(path)
      if (sourceGeneration === null) return null
      const nativeSource = sha256Hex(JSON.stringify(['opencode-native-db', path]))
      return openHistoricalOpencodeUsagePass(path, {
        kind: 'historical-observed',
        referenceId: input.referenceId,
        passId: sha256Hex(
          JSON.stringify([
            'historical-original-pass',
            sourceGeneration,
            input.referenceId,
            input.rootSessionId,
          ]),
        ),
        nativeSource,
        sourceGeneration,
        rootSessionId: input.rootSessionId,
      })
    },
  }
}
