import type { Plugin } from '@agent-workflow/shared'
import { and, eq, isNull, like, ne } from 'drizzle-orm'
import { agents, plugins } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, staleConflictError } from '@/util/errors'
import type {
  PluginAgentReference,
  PluginProjection,
  PluginRepository,
} from '../application/plugins/ports'
import {
  collectPluginAgentReferences,
  pluginConfigHash,
  pluginFromPersistenceRow,
  pluginProjection,
  type PluginPersistenceRow,
} from './pluginPersistence'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

export interface PostgresqlPluginRepositoryBundle {
  readonly repository: PluginRepository
  readonly projection: PluginProjection
}

const referenceSelect = {
  id: agents.id,
  name: agents.name,
  raw: agents.plugins,
  ownerUserId: agents.ownerUserId,
  visibility: agents.visibility,
}

function ownerScopedNameWhere(ownerUserId: string | null, name: string, excludeId?: string) {
  const owner =
    ownerUserId === null ? isNull(plugins.ownerUserId) : eq(plugins.ownerUserId, ownerUserId)
  const identity = and(owner, eq(plugins.name, name))
  return excludeId === undefined ? identity : and(identity, ne(plugins.id, excludeId))
}

function nameConflict(name: string, purpose: 'create' | 'rename'): ConflictError {
  return new ConflictError(
    'plugin-name-in-use',
    purpose === 'rename'
      ? `plugin '${name}' already exists; pick a different name`
      : `plugin '${name}' already exists`,
  )
}

function assertExpectedHash(row: PluginPersistenceRow, expectedConfigHash: string, action: string) {
  const plugin = pluginFromPersistenceRow(row)
  const currentConfigHash = pluginConfigHash(plugin)
  if (currentConfigHash !== expectedConfigHash) {
    throw staleConflictError('plugin', `plugin changed before ${action}; reload and retry`, {
      expectedConfigHash,
      currentConfigHash,
    })
  }
  return plugin
}

function fullPluginRowWhere(row: PluginPersistenceRow) {
  return and(
    eq(plugins.id, row.id),
    eq(plugins.name, row.name),
    eq(plugins.spec, row.spec),
    eq(plugins.optionsJson, row.optionsJson),
    eq(plugins.description, row.description),
    eq(plugins.enabled, row.enabled),
    eq(plugins.sourceKind, row.sourceKind),
    eq(plugins.cachedPath, row.cachedPath),
    row.resolvedVersion === null
      ? isNull(plugins.resolvedVersion)
      : eq(plugins.resolvedVersion, row.resolvedVersion),
    eq(plugins.installedAt, row.installedAt),
    row.ownerUserId === null
      ? isNull(plugins.ownerUserId)
      : eq(plugins.ownerUserId, row.ownerUserId),
    eq(plugins.visibility, row.visibility),
    eq(plugins.aclRevision, row.aclRevision),
    eq(plugins.schemaVersion, row.schemaVersion),
    eq(plugins.createdAt, row.createdAt),
    eq(plugins.updatedAt, row.updatedAt),
  )
}

async function selectPluginRowById(
  transaction: PostgresqlResourceCatalogTransaction,
  id: string,
): Promise<PluginPersistenceRow | null> {
  return (await transaction.select().from(plugins).where(eq(plugins.id, id)).get()) ?? null
}

async function findAgentReferencesInTransaction(
  transaction: PostgresqlResourceCatalogTransaction,
  pluginId: string,
): Promise<PluginAgentReference[]> {
  return collectPluginAgentReferences(
    await transaction
      .select(referenceSelect)
      .from(agents)
      .where(like(agents.plugins, `%"${pluginId}"%`))
      .all(),
    pluginId,
  )
}

function requireChangedRow(
  rows: readonly { readonly id: string }[],
  resourceId: string,
  action: string,
): void {
  if (rows.length === 1 && rows[0]?.id === resourceId) return
  throw staleConflictError('plugin', `plugin changed during ${action}`)
}

export function createPostgresqlPluginRepository(
  db: PostgresqlDatabaseClient,
): PostgresqlPluginRepositoryBundle {
  async function get(id: string): Promise<Plugin | null> {
    const row = await db.select().from(plugins).where(eq(plugins.id, id)).limit(1).get()
    return row === undefined ? null : pluginFromPersistenceRow(row)
  }

  const repository: PluginRepository = {
    async list(): Promise<Plugin[]> {
      return (await db.select().from(plugins).all()).map(pluginFromPersistenceRow)
    },
    get,
    async assertNameAvailable(input): Promise<void> {
      const collision = await db
        .select({ id: plugins.id })
        .from(plugins)
        .where(ownerScopedNameWhere(input.ownerUserId, input.name, input.excludeId))
        .limit(1)
        .get()
      if (collision !== undefined) throw nameConflict(input.name, input.purpose)
    },
    async create(record): Promise<Plugin> {
      try {
        return await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
          const created = await transaction
            .insert(plugins)
            .values({
              id: record.id,
              name: record.name,
              spec: record.spec,
              optionsJson: JSON.stringify(record.options),
              description: record.description,
              enabled: record.enabled,
              sourceKind: record.sourceKind,
              cachedPath: record.cachedPath,
              resolvedVersion: record.resolvedVersion,
              installedAt: record.now,
              ownerUserId: record.ownerUserId,
              visibility: record.visibility,
              aclRevision: record.aclRevision,
              createdAt: record.now,
              updatedAt: record.now,
            })
            .returning()
            .all()
          if (created.length !== 1) throw new Error('plugin insert did not return one row')
          return pluginFromPersistenceRow(created[0]!)
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['plugins_owner_name_unique'])) {
          throw nameConflict(record.name, 'create')
        }
        throw error
      }
    },
    async publish(input): Promise<Plugin> {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const row = await selectPluginRowById(transaction, input.id)
        if (row === null) {
          throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
        }
        assertExpectedHash(row, input.expectedConfigHash, 'generation publication')
        const updated = await transaction
          .update(plugins)
          .set({
            spec: input.set.spec,
            optionsJson: JSON.stringify(input.set.options),
            description: input.set.description,
            enabled: input.set.enabled,
            sourceKind: input.set.sourceKind,
            cachedPath: input.set.cachedPath,
            resolvedVersion: input.set.resolvedVersion,
            installedAt: input.set.installedAt,
            updatedAt: input.set.updatedAt,
          })
          .where(fullPluginRowWhere(row))
          .returning()
          .all()
        requireChangedRow(updated, input.id, 'generation publication')
        return pluginFromPersistenceRow(updated[0]!)
      })
    },
    async rename(input): Promise<Plugin> {
      try {
        return await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
          const row = await selectPluginRowById(transaction, input.id)
          if (row === null) {
            throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
          }
          const plugin = assertExpectedHash(row, input.expectedConfigHash, 'rename')
          const collision = await transaction
            .select({ id: plugins.id })
            .from(plugins)
            .where(ownerScopedNameWhere(plugin.ownerUserId ?? null, input.newName, input.id))
            .get()
          if (collision !== undefined) throw nameConflict(input.newName, 'rename')
          const updated = await transaction
            .update(plugins)
            .set({ name: input.newName, updatedAt: input.updatedAt })
            .where(fullPluginRowWhere(row))
            .returning()
            .all()
          requireChangedRow(updated, input.id, 'rename')
          return pluginFromPersistenceRow(updated[0]!)
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['plugins_owner_name_unique'])) {
          throw nameConflict(input.newName, 'rename')
        }
        throw error
      }
    },
    async findAgentReferences(id): Promise<readonly PluginAgentReference[]> {
      return collectPluginAgentReferences(
        await db
          .select(referenceSelect)
          .from(agents)
          .where(like(agents.plugins, `%"${id}"%`))
          .all(),
        id,
      )
    },
    async delete(input): Promise<readonly PluginAgentReference[]> {
      return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const row = await selectPluginRowById(transaction, input.id)
        if (row === null) {
          throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
        }
        assertExpectedHash(row, input.expectedConfigHash, 'delete')
        const references = await findAgentReferencesInTransaction(transaction, input.id)
        if (references.length > 0) return references
        const deleted = await transaction
          .delete(plugins)
          .where(fullPluginRowWhere(row))
          .returning({ id: plugins.id })
          .all()
        requireChangedRow(deleted, input.id, 'delete')
        return []
      })
    },
  }

  return Object.freeze({ repository: Object.freeze(repository), projection: pluginProjection })
}
