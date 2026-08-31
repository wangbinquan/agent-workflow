// RFC-349 — PostgreSQL restore composition over the provider-neutral archive
// and logical replay. The target session is opened only after the outer
// manifest/envelope pass and is always released by portableDatabaseRestore.

import type {
  LogicalDatabaseRestoreProgress,
  LogicalDatabaseRestoreTarget,
} from '@/platform/persistence/logicalDatabaseRestore'
import {
  openPostgresqlLogicalTarget,
  type PostgresqlLogicalTarget,
} from '@/platform/persistence/postgresqlLogicalTarget'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  restorePortableDatabaseBackup,
  type PortableDatabaseRestoreResult,
  type PortableRestoreFilesystemAssets,
} from './portableDatabaseRestore'

type ProviderRestoreTarget = LogicalDatabaseRestoreTarget &
  Readonly<{
    provider: 'postgresql'
    close(): Promise<void>
  }>

export interface OpenPostgresqlProviderRestoreTargetInput {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly operationId: string
  readonly sourceGenerationId: string
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
}

type OpenPostgresqlProviderRestoreTarget = (
  input: OpenPostgresqlProviderRestoreTargetInput,
) => Promise<ProviderRestoreTarget>

export interface RestorePostgresqlProviderBackupOptions {
  readonly tarballPath: string
  readonly appHome: string
  readonly restoreOperationId: string
  readonly runtime: PostgresqlDatabaseRuntime
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
  readonly filesystem: PortableRestoreFilesystemAssets
  readonly now?: () => number
  readonly onProgress?: (progress: LogicalDatabaseRestoreProgress) => void
  /** Infrastructure test seam; production opens the advisory-lock target. */
  readonly openTarget?: OpenPostgresqlProviderRestoreTarget
}

export async function restorePostgresqlProviderBackup(
  options: RestorePostgresqlProviderBackupOptions,
): Promise<PortableDatabaseRestoreResult> {
  const openTarget: OpenPostgresqlProviderRestoreTarget =
    options.openTarget ??
    (openPostgresqlLogicalTarget as (
      input: OpenPostgresqlProviderRestoreTargetInput,
    ) => Promise<PostgresqlLogicalTarget>)

  return await restorePortableDatabaseBackup({
    tarballPath: options.tarballPath,
    appHome: options.appHome,
    restoreOperationId: options.restoreOperationId,
    contract: options.contract,
    filesystem: options.filesystem,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    async openTarget({ envelope }) {
      const target = await openTarget({
        runtime: options.runtime,
        operationId: options.restoreOperationId,
        sourceGenerationId: envelope.payload.sourceGenerationId,
        contract: options.contract,
        plan: options.plan,
      })
      return Object.freeze({
        target,
        close: () => target.close(),
      })
    },
  })
}
