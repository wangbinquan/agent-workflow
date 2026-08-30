import { PluginSchema, pluginOperationConfigHashWith, type Plugin } from '@agent-workflow/shared'
import { and, eq, isNull, like, ne, type SQL } from 'drizzle-orm'
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core'
import type { DbClient } from '@/db/client'
import { agents, plugins } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type {
  PluginAgentReference,
  PluginProjection,
  PluginRepository,
} from '../application/plugins/ports'
import type { PluginCatalogResource } from '../public/types'

type PluginRow = typeof plugins.$inferSelect

export interface SqlitePluginRepositoryBundle {
  readonly repository: PluginRepository
  readonly projection: PluginProjection
}

function rowToPlugin(row: PluginRow): Plugin {
  let options: unknown
  try {
    options = JSON.parse(row.optionsJson)
  } catch {
    options = {}
  }
  const parsed = PluginSchema.safeParse({
    id: row.id,
    name: row.name,
    spec: row.spec,
    options,
    description: row.description,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    aclRevision: row.aclRevision,
    enabled: row.enabled,
    sourceKind: row.sourceKind,
    cachedPath: row.cachedPath,
    resolvedVersion: row.resolvedVersion,
    installedAt: row.installedAt,
    schemaVersion: row.schemaVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) {
    throw new ValidationError(
      'plugin-row-corrupt',
      `plugin row '${row.name}' (id=${row.id}) failed schema validation`,
      { issues: parsed.error.issues },
    )
  }
  return parsed.data
}

function configHashOf(plugin: Plugin): string {
  return pluginOperationConfigHashWith(plugin, sha256Hex)
}

function resourceOf(plugin: Plugin): PluginCatalogResource {
  return Object.freeze({ ...plugin, operationConfigHash: configHashOf(plugin) })
}

function ownerScopedNameWhere(
  ownerColumn: AnySQLiteColumn,
  nameColumn: AnySQLiteColumn,
  ownerUserId: string | null,
  name: string,
  excludeId?: { readonly column: AnySQLiteColumn; readonly id: string },
): SQL {
  const owner = ownerUserId === null ? isNull(ownerColumn) : eq(ownerColumn, ownerUserId)
  const identity = and(owner, eq(nameColumn, name))
  return excludeId === undefined ? identity! : and(identity, ne(excludeId.column, excludeId.id))!
}

function isOwnerNameUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|constraint failed/i.test(message)) {
    return false
  }
  return message.includes('plugins_owner_name_unique') || message.includes('plugins.name')
}

function nameConflict(name: string, purpose: 'create' | 'rename'): ConflictError {
  return new ConflictError(
    'plugin-name-in-use',
    purpose === 'rename'
      ? `plugin '${name}' already exists; pick a different name`
      : `plugin '${name}' already exists`,
  )
}

function assertExpectedHash(row: PluginRow, expectedConfigHash: string, action: string): Plugin {
  const plugin = rowToPlugin(row)
  const currentConfigHash = configHashOf(plugin)
  if (currentConfigHash !== expectedConfigHash) {
    throw staleConflictError('plugin', `plugin changed before ${action}; reload and retry`, {
      expectedConfigHash,
      currentConfigHash,
    })
  }
  return plugin
}

function collectAgentReferences(
  rows: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly raw: unknown
    readonly ownerUserId: string | null
    readonly visibility: 'public' | 'private'
  }>,
  pluginId: string,
): PluginAgentReference[] {
  const references: PluginAgentReference[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(String(row.raw)) as unknown
      if (Array.isArray(parsed) && parsed.includes(pluginId)) {
        references.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
      }
    } catch {
      // Preserve the legacy corrupt-JSON behavior: malformed rows do not disclose a reference.
    }
  }
  return references
}

const referenceSelect = {
  id: agents.id,
  name: agents.name,
  raw: agents.plugins,
  ownerUserId: agents.ownerUserId,
  visibility: agents.visibility,
}

function findAgentReferencesInTx(tx: DbTxSync, pluginId: string): PluginAgentReference[] {
  return collectAgentReferences(
    tx
      .select(referenceSelect)
      .from(agents)
      .where(like(agents.plugins, `%"${pluginId}"%`))
      .all(),
    pluginId,
  )
}

function selectPluginRowById(tx: DbTxSync, id: string): PluginRow | null {
  return tx.select().from(plugins).where(eq(plugins.id, id)).get() ?? null
}

function fullPluginRowWhere(row: PluginRow) {
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

function changesOf(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

export function createSqlitePluginRepository(db: DbClient): SqlitePluginRepositoryBundle {
  async function get(id: string): Promise<Plugin | null> {
    const row = (await db.select().from(plugins).where(eq(plugins.id, id)).limit(1))[0]
    return row === undefined ? null : rowToPlugin(row)
  }

  async function requireAfterWrite(id: string, action: string): Promise<Plugin> {
    const row = await get(id)
    if (row === null) throw new Error(`plugin disappeared ${action}`)
    return row
  }

  const repository: PluginRepository = {
    async list(): Promise<Plugin[]> {
      return (await db.select().from(plugins)).map(rowToPlugin)
    },
    get,
    async assertNameAvailable(input): Promise<void> {
      const collision = await db
        .select({ id: plugins.id })
        .from(plugins)
        .where(
          ownerScopedNameWhere(
            plugins.ownerUserId,
            plugins.name,
            input.ownerUserId,
            input.name,
            input.excludeId === undefined ? undefined : { column: plugins.id, id: input.excludeId },
          ),
        )
        .limit(1)
      if (collision.length > 0) throw nameConflict(input.name, input.purpose)
    },
    async create(record): Promise<Plugin> {
      try {
        dbTxSync(db, (tx) => {
          tx.insert(plugins)
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
            .run()
        })
      } catch (error) {
        if (isOwnerNameUniqueViolation(error)) throw nameConflict(record.name, 'create')
        throw error
      }
      return requireAfterWrite(record.id, 'right after insert')
    },
    async publish(input): Promise<Plugin> {
      dbTxSync(db, (tx) => {
        const row = selectPluginRowById(tx, input.id)
        if (row === null) {
          throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
        }
        assertExpectedHash(row, input.expectedConfigHash, 'generation publication')
        const result = tx
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
          .run()
        if (changesOf(result) !== 1) {
          throw staleConflictError('plugin', 'plugin changed during generation publication')
        }
      })
      return requireAfterWrite(input.id, 'during generation publication')
    },
    async rename(input): Promise<Plugin> {
      try {
        dbTxSync(db, (tx) => {
          const row = selectPluginRowById(tx, input.id)
          if (row === null) {
            throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
          }
          const plugin = assertExpectedHash(row, input.expectedConfigHash, 'rename')
          const collision = tx
            .select({ id: plugins.id })
            .from(plugins)
            .where(
              ownerScopedNameWhere(
                plugins.ownerUserId,
                plugins.name,
                plugin.ownerUserId ?? null,
                input.newName,
                { column: plugins.id, id: input.id },
              ),
            )
            .get()
          if (collision !== undefined) throw nameConflict(input.newName, 'rename')
          const result = tx
            .update(plugins)
            .set({ name: input.newName, updatedAt: input.updatedAt })
            .where(fullPluginRowWhere(row))
            .run()
          if (changesOf(result) !== 1) {
            throw staleConflictError('plugin', 'plugin changed during rename')
          }
        })
      } catch (error) {
        if (isOwnerNameUniqueViolation(error)) throw nameConflict(input.newName, 'rename')
        throw error
      }
      return requireAfterWrite(input.id, 'after rename')
    },
    async findAgentReferences(id): Promise<readonly PluginAgentReference[]> {
      return collectAgentReferences(
        await db
          .select(referenceSelect)
          .from(agents)
          .where(like(agents.plugins, `%"${id}"%`)),
        id,
      )
    },
    async delete(input): Promise<readonly PluginAgentReference[]> {
      return dbTxSync(db, (tx) => {
        const row = selectPluginRowById(tx, input.id)
        if (row === null) {
          throw new NotFoundError('plugin-not-found', `plugin '${input.id}' not found`)
        }
        assertExpectedHash(row, input.expectedConfigHash, 'delete')
        const references = findAgentReferencesInTx(tx, input.id)
        if (references.length > 0) return references
        const result = tx.delete(plugins).where(fullPluginRowWhere(row)).run()
        if (changesOf(result) !== 1) {
          throw staleConflictError('plugin', 'plugin changed during delete')
        }
        return [] as PluginAgentReference[]
      })
    },
  }
  Object.freeze(repository)

  return Object.freeze({
    repository,
    projection: Object.freeze({ configHashOf, resourceOf }),
  })
}
