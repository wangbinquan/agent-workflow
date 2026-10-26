import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { EpochSwitchError } from './model'
import { supportsDatabaseMigration } from '@/platform/persistence/migrationSupport'

export function assertEpochSwitchSupported(input: {
  sourceProvider: DatabaseProvider
  targetProvider: DatabaseProvider
  sourceEpoch: number
  targetEpoch: number
}): void {
  if (input.sourceEpoch !== 1 || input.targetEpoch !== 2)
    throw new EpochSwitchError('v3-unsupported-epoch-path', { category: 'unsupported-path' })
  if (!supportsDatabaseMigration(input))
    throw new EpochSwitchError('v3-postgresql-to-sqlite-unsupported', {
      category: 'unsupported-path',
    })
}

export function environmentProfile(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new EpochSwitchError('v3-invalid-url-environment-name', { category: 'unsupported-path' })
  return `env:${name}`
}
