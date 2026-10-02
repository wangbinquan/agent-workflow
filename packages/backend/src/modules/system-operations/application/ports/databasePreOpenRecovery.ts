// The boot sequence owns generation selection; the host supplies pre-open effects.
import type { DatabaseGenerationBootstrapCandidate } from '@/platform/persistence/generationValidation'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'

export interface DatabasePreOpenRecoveryPort<THistory> {
  readMigrationHistory(): THistory | Promise<THistory>
  readGeneration(input: {
    readonly contract: LogicalSchemaContract
    readonly history: THistory
  }): DatabaseGenerationBootstrapCandidate | Promise<DatabaseGenerationBootstrapCandidate>
  applyStagedRestore(): boolean | Promise<boolean>
}
