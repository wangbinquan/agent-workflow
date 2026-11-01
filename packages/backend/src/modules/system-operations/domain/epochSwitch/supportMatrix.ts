import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { EpochSwitchError } from './model'
import { supportsDatabaseMigration } from '@/platform/persistence/migrationSupport'
import { persistenceDialect } from '@/platform/persistence/nativeDialect'

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
  try {
    return persistenceDialect('postgresql').environmentProfileRef(name)
  } catch {
    throw new EpochSwitchError('v3-invalid-url-environment-name', { category: 'unsupported-path' })
  }
}

/** Runtime validation also covers untyped CLI/host inputs, before planning effects. */
export function resolveEpochProfile(
  input: { readonly urlEnv?: string; readonly profileRef?: string },
  hostedRole?: 'source' | 'target',
): string | undefined {
  if (input.urlEnv !== undefined && input.profileRef !== undefined)
    throw new EpochSwitchError('v3-profile-ref-and-url-env-mutually-exclusive', {
      category: 'unsupported-path',
    })
  if (input.profileRef !== undefined) {
    if (!persistenceDialect('postgresql').isProfileRef(input.profileRef, hostedRole))
      throw new EpochSwitchError('v3-invalid-postgresql-profile-ref', {
        category: 'unsupported-path',
      })
    return input.profileRef
  }
  return input.urlEnv === undefined ? undefined : environmentProfile(input.urlEnv)
}
