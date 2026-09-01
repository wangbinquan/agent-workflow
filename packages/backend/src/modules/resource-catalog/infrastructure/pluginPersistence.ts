import {
  PluginSchema,
  pluginOperationConfigHashWith,
  type Plugin,
  type PluginSourceKind,
} from '@agent-workflow/shared'
import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { plugins } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { ConflictError } from '@/util/errors'
import { ValidationError, staleConflictError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { PluginAgentReference, PluginProjection } from '../application/plugins/ports'
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

function selectPluginRowInTx(tx: DbTxSync, id: string): PluginPersistenceRow | null {
  return tx.select().from(plugins).where(eq(plugins.id, id)).get() ?? null
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

function changedRows(result: unknown): number {
  return (result as { readonly changes?: number }).changes ?? 0
}

function stalePluginError(id: string): ConflictError {
  return staleConflictError(
    'plugin',
    `plugin '${id}' changed while the operation was running; reload and retry`,
  )
}

export function commitLegacyPluginCreateInTx(
  tx: DbTxSync,
  prepared: LegacyPreparedPluginCreate,
): Plugin {
  tx.insert(plugins)
    .values({
      id: prepared.id,
      name: prepared.parsed.name,
      spec: prepared.parsed.spec,
      optionsJson: JSON.stringify(prepared.parsed.options),
      description: prepared.parsed.description,
      enabled: prepared.parsed.enabled,
      sourceKind: prepared.install.sourceKind,
      cachedPath: prepared.install.cachedPath,
      resolvedVersion: prepared.install.resolvedVersion,
      installedAt: prepared.now,
      ...prepared.initialAcl,
      createdAt: prepared.now,
      updatedAt: prepared.now,
    })
    .run()
  const created = selectPluginRowInTx(tx, prepared.id)
  if (created === null) throw new Error('plugin disappeared during create publication')
  return pluginFromPersistenceRow(created)
}

export function commitLegacyPluginPublishInTx(
  tx: DbTxSync,
  captured: PluginPersistenceRow,
  set: LegacyPluginPublishSet,
): Plugin {
  const current = selectPluginRowInTx(tx, captured.id)
  if (current === null) throw stalePluginError(captured.id)
  const result = tx.update(plugins).set(set).where(fullPluginRowWhere(captured)).run()
  if (changedRows(result) !== 1) throw stalePluginError(captured.id)
  const published = selectPluginRowInTx(tx, captured.id)
  if (published === null) throw new Error('plugin disappeared during generation publication')
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
