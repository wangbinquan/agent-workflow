import type {
  ComposeMemoryOperationsOptions,
  MemoryCatalogBinding,
} from '@/modules/memory/composition'
import {
  composeMemoryCatalogOperations,
  composeMemoryInjectionQueriesFor,
  composeMemoryOperationsFor,
} from '@/modules/memory/composition'
import type { MemoryOperations } from '@/modules/memory/public/operations'
import { composeResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'

export function composeDaemonMemoryModules(
  input: Omit<ComposeMemoryOperationsOptions, 'injectionQueries' | 'catalogBinding'> & {
    readonly operations?: MemoryOperations
    readonly contexts: MemoryCatalogBinding['contexts']
  },
) {
  const memoryInjectionQueries =
    input.operations?.injectionQueries ?? composeMemoryInjectionQueriesFor(input.db)
  const memoryOperations =
    input.operations ??
    composeMemoryOperationsFor({
      ...input,
      injectionQueries: memoryInjectionQueries,
      catalogBinding: {
        contexts: input.contexts,
        authorization: composeResourceScopeAccessParticipant(),
      },
    })
  const memoryCatalog =
    memoryOperations.catalog ??
    composeMemoryCatalogOperations({
      db: input.db,
      contexts: input.contexts,
      authorization: composeResourceScopeAccessParticipant(),
    })
  return Object.freeze({ memoryOperations, memoryInjectionQueries, memoryCatalog })
}
export type DaemonMemoryModules = ReturnType<typeof composeDaemonMemoryModules>
