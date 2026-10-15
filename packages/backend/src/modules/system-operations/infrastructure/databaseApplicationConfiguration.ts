// RFC-370 M0 — the Settings document kept in the database. A CrewStation
// service slot has no persistent disk, so the document standalone keeps in
// config.json is one singleton row here. Settings the deployment owns (the
// database connection) are overlaid on every read and refused in patches.
import { DEFAULT_CONFIG, type Config, type DatabaseConfig } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { applicationConfiguration } from '@/db/schema'
import {
  mergeValidatedConfigurationPatch,
  resolveConfigurationValue,
  validateConfigurationPatch,
} from '@/platform/configuration/configurationValues'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import type { ApplicationConfigurationPersistencePort } from '../application/ports/applicationConfiguration'

const DOCUMENT_ID = 'global'

export interface DeploymentManagedSettings {
  readonly database: DatabaseConfig
}

export function createDatabaseApplicationConfiguration(input: {
  readonly db: ProviderNeutralDatabase
  readonly managed: DeploymentManagedSettings
  readonly now?: () => number
}): ApplicationConfigurationPersistencePort {
  const session = databaseSessionFor(input.db)
  const now = input.now ?? Date.now
  const overlay = (config: Config): Config => ({ ...config, database: input.managed.database })
  const decode = (document: string | undefined): Config =>
    overlay(
      document === undefined ? DEFAULT_CONFIG : resolveConfigurationValue(JSON.parse(document)),
    )
  const read = async (handle: ProviderNeutralDatabase): Promise<Config> => {
    const row = (
      await handle
        .select({ document: applicationConfiguration.document })
        .from(applicationConfiguration)
        .where(eq(applicationConfiguration.id, DOCUMENT_ID))
        .limit(1)
    )[0]
    return decode(row?.document)
  }
  const preview = (current: Config, patch: unknown): Config => {
    const validated = validateConfigurationPatch(patch)
    if ('database' in validated) {
      throw new ConflictError(
        'setting-managed-by-deployment',
        'the database connection is provided by the deployment and cannot be changed here',
      )
    }
    return overlay(mergeValidatedConfigurationPatch(current, validated))
  }

  return Object.freeze({
    load: () => read(input.db),
    async previewPatch(patch: unknown) {
      return preview(await read(input.db), patch)
    },
    async applyPatch(patch: unknown) {
      return await session.transaction(async (tx) => {
        await tx
          .insert(applicationConfiguration)
          .values({
            id: DOCUMENT_ID,
            document: JSON.stringify(DEFAULT_CONFIG),
            revision: 0,
            updatedAt: now(),
          })
          .onConflictDoNothing()
        await session.engine.lockAggregateRoot(
          tx,
          applicationConfiguration,
          applicationConfiguration.id,
          DOCUMENT_ID,
        )
        const row = (
          await tx
            .select()
            .from(applicationConfiguration)
            .where(eq(applicationConfiguration.id, DOCUMENT_ID))
            .limit(1)
        )[0]
        if (row === undefined) throw new Error('application configuration document is missing')
        const next = preview(decode(row.document), patch)
        const { database: _managed, ...document } = next
        await tx
          .update(applicationConfiguration)
          .set({
            document: JSON.stringify(document),
            revision: row.revision + 1,
            updatedAt: now(),
          })
          .where(eq(applicationConfiguration.id, DOCUMENT_ID))
        return next
      })
    },
  } satisfies ApplicationConfigurationPersistencePort)
}
