import { opencodeUsageDatabasePath } from '@/services/runtime'
import { sha256Hex } from '@/util/hash'
import { opencodeNativeStoreGeneration } from '../infrastructure/opencodeNativeStoreGeneration'
import {
  openHistoricalOpencodeUsagePass,
  createHistoricalOpencodeUsagePassFactory,
} from '../infrastructure/opencodeUsagePass'
import type {
  HistoricalNativeUsageQuery,
  HistoricalNativePassIdentity,
  HistoricalNativePassReader,
} from '../application/ports/historicalNativeUsage'

/** Reads the actual native artifact under the original daemon environment; no current model/rate lookup. */
function assembleHistoricalNativeUsageQuery(
  env: Readonly<Record<string, string | undefined>>,
  read: (path: string, identity: HistoricalNativePassIdentity) => HistoricalNativePassReader,
): HistoricalNativeUsageQuery {
  const path = opencodeUsageDatabasePath(env)
  return {
    generation: () => (path === null ? Promise.resolve(null) : opencodeNativeStoreGeneration(path)),
    async open(input) {
      if (path === null) return null
      const sourceGeneration = await opencodeNativeStoreGeneration(path)
      if (sourceGeneration === null) return null
      const nativeSource = sha256Hex(JSON.stringify(['opencode-native-db', path]))
      return read(path, {
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

/** Standalone historical reads keep the original fresh physical connection lifecycle. */
export function createHistoricalNativeUsageQuery(
  env: Readonly<Record<string, string | undefined>>,
): HistoricalNativeUsageQuery {
  return assembleHistoricalNativeUsageQuery(env, openHistoricalOpencodeUsagePass)
}

/** Local Worker ownership only; close is not added to the cross-module public query contract. */
export function createReportHistoricalNativeUsageQuery(
  env: Readonly<Record<string, string | undefined>>,
): HistoricalNativeUsageQuery & { close(): void } {
  const path = opencodeUsageDatabasePath(env),
    readers = path === null ? null : createHistoricalOpencodeUsagePassFactory(path),
    query = assembleHistoricalNativeUsageQuery(env, (_path, identity) => readers!.open(identity))
  let closed = false
  return {
    generation: query.generation,
    async open(input) {
      if (closed) throw new Error('Historical native reader factory closed')
      return query.open(input)
    },
    close() {
      if (closed) return
      closed = true
      readers?.close()
    },
  }
}
