import {
  PluginSchema,
  pluginOperationConfigHashWith,
  type Plugin,
  type PluginSourceKind,
} from '@agent-workflow/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { plugins } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import type { ConflictError } from '@/util/errors'
import { ValidationError, staleConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type {
  PluginAgentReference,
  PluginCreateRecord,
  PluginProjection,
} from '../application/plugins/ports'
import type { PluginCatalogResource } from '../public/types'

export interface PluginPersistenceRow {
  readonly id: string
  readonly name: string
  readonly spec: string
  readonly optionsJson: string
  readonly description: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
  readonly aclRevision: number
  readonly enabled: boolean
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly installedAt: number
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

export function pluginFromPersistenceRow(row: PluginPersistenceRow): Plugin {
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

export function pluginConfigHash(plugin: Plugin): string {
  return pluginOperationConfigHashWith(plugin, sha256Hex)
}

export function pluginCatalogResource(plugin: Plugin): PluginCatalogResource {
  return Object.freeze({ ...plugin, operationConfigHash: pluginConfigHash(plugin) })
}

export const pluginProjection: PluginProjection = Object.freeze({
  configHashOf: pluginConfigHash,
  resourceOf: pluginCatalogResource,
})

export interface LegacyPluginInstallResult {
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
}

export interface LegacyPreparedPluginCreate {
  readonly id: string
  readonly parsed: {
    readonly name: string
    readonly spec: string
    readonly options: Readonly<Record<string, unknown>>
    readonly description: string
    readonly enabled: boolean
  }
  readonly initialAcl: {
    readonly ownerUserId: string | null
    readonly visibility: 'private'
    readonly aclRevision: 0
  }
  readonly install: LegacyPluginInstallResult
  readonly now: number
}

export interface LegacyPluginPublishSet {
  readonly spec: string
  readonly optionsJson: string
  readonly description: string
  readonly enabled: boolean
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly installedAt: number
  readonly updatedAt: number
}

export async function loadLegacyPluginRow(
  db: DbClient,
  id: string,
): Promise<PluginPersistenceRow | null> {
  return (await db.select().from(plugins).where(eq(plugins.id, id)).limit(1))[0] ?? null
}

export function fullPluginRowWhere(row: PluginPersistenceRow) {
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

function stalePluginError(id: string): ConflictError {
  return staleConflictError(
    'plugin',
    `plugin '${id}' changed while the operation was running; reload and retry`,
  )
}

type PluginInsertRecord = Omit<PluginCreateRecord, 'ownerUserId'> & {
  readonly ownerUserId: string | null
}

/** Join the caller's transaction; timestamps and installed artifacts are already captured. */
export async function insertPluginRowInTx(
  tx: DatabaseTransaction,
  record: PluginInsertRecord,
): Promise<PluginPersistenceRow[]> {
  return await tx
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
      schemaVersion: 1,
      createdAt: record.now,
      updatedAt: record.now,
    })
    .returning()
}

/** The complete captured row remains the publication CAS, including nullable columns. */
export async function publishPluginRowInTx(
  tx: DatabaseTransaction,
  captured: PluginPersistenceRow,
  set: LegacyPluginPublishSet,
): Promise<PluginPersistenceRow[]> {
  return await tx.update(plugins).set(set).where(fullPluginRowWhere(captured)).returning()
}

export async function commitLegacyPluginCreateInTx(
  tx: DatabaseTransaction,
  prepared: LegacyPreparedPluginCreate,
): Promise<Plugin> {
  const [created] = await insertPluginRowInTx(tx, {
    id: prepared.id,
    name: prepared.parsed.name,
    spec: prepared.parsed.spec,
    options: prepared.parsed.options,
    description: prepared.parsed.description,
    enabled: prepared.parsed.enabled,
    ownerUserId: prepared.initialAcl.ownerUserId,
    visibility: prepared.initialAcl.visibility,
    aclRevision: prepared.initialAcl.aclRevision,
    sourceKind: prepared.install.sourceKind,
    cachedPath: prepared.install.cachedPath,
    resolvedVersion: prepared.install.resolvedVersion,
    now: prepared.now,
  })
  if (created === undefined) throw new Error('plugin disappeared during create publication')
  return pluginFromPersistenceRow(created)
}

export async function commitLegacyPluginPublishInTx(
  tx: DatabaseTransaction,
  captured: PluginPersistenceRow,
  set: LegacyPluginPublishSet,
): Promise<Plugin> {
  const [published] = await publishPluginRowInTx(tx, captured, set)
  if (published === undefined) throw stalePluginError(captured.id)
  return pluginFromPersistenceRow(published)
}

export interface PluginAgentReferencePersistenceRow {
  readonly id: string
  readonly name: string
  readonly raw: unknown
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

export function collectPluginAgentReferences(
  rows: readonly PluginAgentReferencePersistenceRow[],
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
      // Preserve the established fail-closed behavior for corrupt legacy JSON.
    }
  }
  return references
}
