import type { Plugin } from '@agent-workflow/shared'
import { and, eq, isNull, like, ne } from 'drizzle-orm'
import { agents, plugins } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
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
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

export interface PluginRepositoryBundle {
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
  transaction: ResourceCatalogTransaction,
  id: string,
): Promise<PluginPersistenceRow | null> {
  return (await transaction.select().from(plugins).where(eq(plugins.id, id)).limit(1))[0] ?? null
}

async function findAgentReferencesInTransaction(
  transaction: ResourceCatalogTransaction,
  pluginId: string,
): Promise<PluginAgentReference[]> {
  return collectPluginAgentReferences(
    await transaction
      .select(referenceSelect)
      .from(agents)
      .where(like(agents.plugins, `%"${pluginId}"%`)),
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

/**
 * RFC-359 W4-D17 —— Plugin 聚合的唯一仓库实现（此前 `sqlitePluginRepository` / `postgresqlPluginRepository` 各一份）。
 * 写路径全在统一的 serializable 事务里，行级 OCC 用整行 WHERE + RETURNING 判定；owner + name 唯一冲突经能力矩阵
 * `uniqueViolationTarget` 映射回 `plugin-name-in-use`。
 */
export function createPluginRepository(deps: {
  readonly db: ProviderNeutralDatabase
}): PluginRepositoryBundle {
  const db = deps.db
  const engine = databaseSessionFor(db).engine
  const isOwnerNameConflict = (error: unknown): boolean => {
    const target = engine.uniqueViolationTarget(error)
    return target !== undefined && /plugins[._](?:owner|name)/i.test(target)
  }
  async function get(id: string): Promise<Plugin | null> {
    const row = (await db.select().from(plugins).where(eq(plugins.id, id)).limit(1))[0]
    return row === undefined ? null : pluginFromPersistenceRow(row)
  }

  const repository: PluginRepository = {
    async list(): Promise<Plugin[]> {
      return (await db.select().from(plugins)).map(pluginFromPersistenceRow)
    },
    get,
    async assertNameAvailable(input): Promise<void> {
      const collision = (
        await db
          .select({ id: plugins.id })
          .from(plugins)
          .where(ownerScopedNameWhere(input.ownerUserId, input.name, input.excludeId))
          .limit(1)
      )[0]
      if (collision !== undefined) throw nameConflict(input.name, input.purpose)
    },
    async create(record): Promise<Plugin> {
      try {
        return await runResourceCatalogTransaction(db, async (transaction) => {
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
          if (created.length !== 1) throw new Error('plugin insert did not return one row')
          return pluginFromPersistenceRow(created[0]!)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) throw nameConflict(record.name, 'create')
        throw error
      }
    },
    async publish(publication): Promise<Plugin> {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const row = await selectPluginRowById(transaction, publication.id)
        if (row === null) {
          throw new NotFoundError('plugin-not-found', `plugin '${publication.id}' not found`)
        }
        assertExpectedHash(row, publication.expectedConfigHash, 'generation publication')
        const updated = await transaction
          .update(plugins)
          .set({
            spec: publication.set.spec,
            optionsJson: JSON.stringify(publication.set.options),
            description: publication.set.description,
            enabled: publication.set.enabled,
            sourceKind: publication.set.sourceKind,
            cachedPath: publication.set.cachedPath,
            resolvedVersion: publication.set.resolvedVersion,
            installedAt: publication.set.installedAt,
            updatedAt: publication.set.updatedAt,
          })
          .where(fullPluginRowWhere(row))
          .returning()
        requireChangedRow(updated, publication.id, 'generation publication')
        return pluginFromPersistenceRow(updated[0]!)
      })
    },
    async rename(renaming): Promise<Plugin> {
      try {
        return await runResourceCatalogTransaction(db, async (transaction) => {
          const row = await selectPluginRowById(transaction, renaming.id)
          if (row === null) {
            throw new NotFoundError('plugin-not-found', `plugin '${renaming.id}' not found`)
          }
          const plugin = assertExpectedHash(row, renaming.expectedConfigHash, 'rename')
          const collision = (
            await transaction
              .select({ id: plugins.id })
              .from(plugins)
              .where(ownerScopedNameWhere(plugin.ownerUserId ?? null, renaming.newName, renaming.id))
              .limit(1)
          )[0]
          if (collision !== undefined) throw nameConflict(renaming.newName, 'rename')
          const updated = await transaction
            .update(plugins)
            .set({ name: renaming.newName, updatedAt: renaming.updatedAt })
            .where(fullPluginRowWhere(row))
            .returning()
          requireChangedRow(updated, renaming.id, 'rename')
          return pluginFromPersistenceRow(updated[0]!)
        })
      } catch (error) {
        if (isOwnerNameConflict(error)) throw nameConflict(renaming.newName, 'rename')
        throw error
      }
    },
    async findAgentReferences(id): Promise<readonly PluginAgentReference[]> {
      return collectPluginAgentReferences(
        await db
          .select(referenceSelect)
          .from(agents)
          .where(like(agents.plugins, `%"${id}"%`)),
        id,
      )
    },
    async delete(deletion): Promise<readonly PluginAgentReference[]> {
      return runResourceCatalogTransaction(db, async (transaction) => {
        const row = await selectPluginRowById(transaction, deletion.id)
        if (row === null) {
          throw new NotFoundError('plugin-not-found', `plugin '${deletion.id}' not found`)
        }
        assertExpectedHash(row, deletion.expectedConfigHash, 'delete')
        const references = await findAgentReferencesInTransaction(transaction, deletion.id)
        if (references.length > 0) return references
        const deleted = await transaction
          .delete(plugins)
          .where(fullPluginRowWhere(row))
          .returning({ id: plugins.id })
        requireChangedRow(deleted, deletion.id, 'delete')
        return []
      })
    },
  }

  return Object.freeze({ repository: Object.freeze(repository), projection: pluginProjection })
}
