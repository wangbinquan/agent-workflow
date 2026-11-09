// RFC-474: the `migration-report` command's analysis over the client the command opened, handed to the CLI by bootstrap.
// The CLI keeps resolving the provider and closing the runtime (RFC-349 / RFC-395 AF-D10). Read-only, as before: the legacy
// rows are collected and analyzed on every call; nothing is persisted and no candidate is created.
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  analyzeLegacyAssets,
  printMigrationReport,
  type MigrationReport,
} from '../application/migrationAnalyzer'
import { collectLegacyAssets } from '../infrastructure/migrationAssets'

export interface LegacyAssetMigrationReport {
  /** `now` is read once the legacy rows are collected: the report's `generatedAt`, as before. */
  analyze(now: () => number): Promise<MigrationReport>
  render(report: MigrationReport): string
}

export function composeLegacyAssetMigrationReport(db: PersistenceDb): LegacyAssetMigrationReport {
  return Object.freeze({
    async analyze(now: () => number) {
      return analyzeLegacyAssets(await collectLegacyAssets(db), now())
    },
    render: printMigrationReport,
  })
}
