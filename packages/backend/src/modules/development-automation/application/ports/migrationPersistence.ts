import type { MigrationReport, MigrationTargetResource } from '../migrationAnalyzer'

export interface MaterializedMigrationCandidate {
  readonly resource: MigrationTargetResource
  readonly proposedName: string
  readonly resourceId: string
  readonly sourceDigest: string
}

export interface SkippedMigrationCandidate {
  readonly resource: MigrationTargetResource
  readonly proposedName: string
  readonly reason: 'name-exists' | 'manual-authoring-required' | 'proposal-only'
}

export interface MaterializeMigrationResult {
  readonly created: readonly MaterializedMigrationCandidate[]
  readonly skipped: readonly SkippedMigrationCandidate[]
}

export interface PersistedMigrationRun {
  readonly report: MigrationReport
  readonly materializedAt: number
  readonly created: readonly MaterializedMigrationCandidate[]
  readonly skipped: readonly SkippedMigrationCandidate[]
}

export interface DevelopmentMigrationPersistence {
  analyze(generatedAt: number): Promise<MigrationReport>
  materialize(report: MigrationReport): Promise<MaterializeMigrationResult>
  readPersisted(): Promise<PersistedMigrationRun | null>
}
