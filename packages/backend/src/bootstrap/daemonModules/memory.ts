import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'
import {
  createNodeOutputQueries,
  createNodeRunQueries,
  createTaskGateQueries,
  createTaskKnowledgeQueries,
} from '@/modules/task-execution/composition'
import {
  createRepositoryIdentityQueries,
  repositoryExistsExpression,
} from '@/modules/source-control/composition'
import type {
  ComposeMemoryOperationsOptions,
  MemoryCatalogBinding,
} from '@/modules/memory/composition'
import {
  composeTaskMemorySnapshotPort,
  composeMemoryInjectionQueriesFor,
  composeMemoryOperationsFor,
} from '@/modules/memory/composition'
import { composeResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'

export function composeDaemonMemoryModules(
  input: Omit<
    ComposeMemoryOperationsOptions,
    | 'injectionQueries'
    | 'catalogBinding'
    | 'clarifyAnswers'
    | 'taskNodeRuns'
    | 'taskNodeOutputs'
    | 'taskKnowledge'
  > & {
    readonly contexts: MemoryCatalogBinding['contexts']
  },
) {
  // RFC-485: task-execution's node-run and node-output reads memory uses, built on the root db (memory reads them outside
  // transactions only); collaboration's clarify answer queries take just the node-run and task-gate query factories.
  const taskNodeRuns = createNodeRunQueries(input.db)
  const taskNodeOutputs = createNodeOutputQueries(input.db)
  // RFC-565: Task Execution's knowledge read (its distillation scope composes Source Control's repository existence
  // fragment into the one task row read) and Source Control's repository identity read, built on the same root db.
  const taskKnowledge = createTaskKnowledgeQueries(input.db, repositoryExistsExpression)
  const memoryInjectionQueries = composeMemoryInjectionQueriesFor(
    input.db,
    taskNodeRuns,
    taskKnowledge,
    createRepositoryIdentityQueries(input.db),
  )
  const memoryOperations = composeMemoryOperationsFor({
    ...input,
    injectionQueries: memoryInjectionQueries,
    clarifyAnswers: createClarifyAnswerQueries(input.db, {
      createNodeRunQueries,
      createTaskGateQueries,
    }),
    taskNodeRuns,
    taskNodeOutputs,
    taskKnowledge,
    catalogBinding: {
      contexts: input.contexts,
      authorization: composeResourceScopeAccessParticipant(),
    },
  })
  const memoryCatalog = memoryOperations.catalog
  return Object.freeze({
    memoryOperations,
    memoryInjectionQueries,
    memoryCatalog,
    memorySnapshots: composeTaskMemorySnapshotPort(),
  })
}
export type DaemonMemoryModules = ReturnType<typeof composeDaemonMemoryModules>
