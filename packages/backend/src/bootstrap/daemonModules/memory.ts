import type {
  ComposeMemoryOperationsOptions,
  MemoryCatalogBinding,
} from '@/modules/memory/composition'
import {
  composeMemoryInjectionQueriesFor,
  composeMemoryOperationsFor,
} from '@/modules/memory/composition'
import { composeResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'

export function composeDaemonMemoryModules(
  input: Omit<ComposeMemoryOperationsOptions, 'injectionQueries' | 'catalogBinding'> & {
    readonly contexts: MemoryCatalogBinding['contexts']
  },
) {
  const memoryInjectionQueries = composeMemoryInjectionQueriesFor(input.db)
  const memoryOperations = composeMemoryOperationsFor({
    ...input,
    injectionQueries: memoryInjectionQueries,
    catalogBinding: {
      contexts: input.contexts,
      authorization: composeResourceScopeAccessParticipant(),
    },
  })
  const memoryCatalog = memoryOperations.catalog
  return Object.freeze({ memoryOperations, memoryInjectionQueries, memoryCatalog })
}
export type DaemonMemoryModules = ReturnType<typeof composeDaemonMemoryModules>
