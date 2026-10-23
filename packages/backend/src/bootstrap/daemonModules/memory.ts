import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'
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
  input: Omit<
    ComposeMemoryOperationsOptions,
    'injectionQueries' | 'catalogBinding' | 'clarifyAnswers'
  > & {
    readonly contexts: MemoryCatalogBinding['contexts']
  },
) {
  const memoryInjectionQueries = composeMemoryInjectionQueriesFor(input.db)
  const memoryOperations = composeMemoryOperationsFor({
    ...input,
    injectionQueries: memoryInjectionQueries,
    clarifyAnswers: createClarifyAnswerQueries(input.db),
    catalogBinding: {
      contexts: input.contexts,
      authorization: composeResourceScopeAccessParticipant(),
    },
  })
  const memoryCatalog = memoryOperations.catalog
  return Object.freeze({ memoryOperations, memoryInjectionQueries, memoryCatalog })
}
export type DaemonMemoryModules = ReturnType<typeof composeDaemonMemoryModules>
