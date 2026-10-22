import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createExecutionContractResourceAdapterFromLookup } from '../application/adapters/execution-contract-adapter'
import { createExecutionContractResourceLookup } from '../infrastructure/adapters/executionContractResourceAdapter'
export function createExecutionContractResourceAdapter(
  db: PersistenceDb,
  implicitAgentDeclarations: (input: {
    readonly frontmatterExtra: Readonly<Record<string, unknown>>
  }) => readonly { readonly contractId: string; readonly version: number }[] = () => [],
) {
  return createExecutionContractResourceAdapterFromLookup(
    createExecutionContractResourceLookup(db),
    implicitAgentDeclarations,
  )
}
