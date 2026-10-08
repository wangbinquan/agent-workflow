import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { systemAgentObservationOwners } from '@/db/observationSystem'
import {
  NativeHistoryPreparationSchema,
  type ObservationNativeScopeSource,
  type ObservationNativeHistorySource,
} from '@/modules/run-observability/public/participants'
import { createObservationNativeScopes } from './observationNativeScopes'
import { createObservationNativeHistory } from './observationNativeHistory'

/** Both source namespaces bind to the same original snapshot/ledger transaction. */
export function createCombinedObservationNativeScopes(
  db: ProviderNeutralDatabase,
): ObservationNativeScopeSource {
  const task = createObservationNativeScopes(db)
  const system = createObservationNativeScopes(db, 'system')
  const forBinding = async (binding: Parameters<ObservationNativeScopeSource['resolve']>[0]) => {
    const original = await db
      .select({ groupId: systemAgentObservationOwners.groupId })
      .from(systemAgentObservationOwners)
      .where(eq(systemAgentObservationOwners.id, binding.invocationId))
      .get()
    if (original && original.groupId !== binding.taskId)
      throw new Error('Original System native scope changed its group')
    return original ? system : task
  }
  const forSource = (sourceId: string) => (sourceId.startsWith('system-agent:') ? system : task)
  return {
    onReader(reader) {
      if (!('select' in reader) || typeof reader.select !== 'function')
        throw new Error('Original native source reader is unavailable')
      return createCombinedObservationNativeScopes(reader as ProviderNeutralDatabase)
    },
    qualify: (value) => forSource(value.sourceId).qualify(value),
    verify: (value) => forSource(value.sourceId).verify(value),
    resolve: async (binding, scope) => (await forBinding(binding)).resolve(binding, scope),
    path: async function* (binding, scope) {
      yield* (await forBinding(binding)).path(binding, scope)
    },
  }
}

export function createCombinedObservationNativeHistory(
  db: ProviderNeutralDatabase,
  prepare: ObservationNativeHistorySource['prepare'],
): ObservationNativeHistorySource {
  const task = createObservationNativeHistory(db, prepare)
  const system = createObservationNativeHistory(db, prepare, 'system')
  return {
    prepare,
    onReader(reader) {
      if (!('select' in reader) || typeof reader.select !== 'function')
        throw new Error('Original native history reader is unavailable')
      return createCombinedObservationNativeHistory(reader as ProviderNeutralDatabase, prepare)
    },
    page(raw, after) {
      const original = NativeHistoryPreparationSchema.parse(raw)
      return (original.value.sourceId.startsWith('system-agent:') ? system : task).page(raw, after)
    },
  }
}
