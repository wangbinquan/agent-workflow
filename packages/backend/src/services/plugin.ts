// Plugin persistence + immutable generation publication (RFC-031 / RFC-201).

import {
  CreatePluginSchema,
  PluginOptionsSchema,
  PluginSchema,
  type Plugin,
  type RenamePlugin,
  type UpdatePlugin,
} from '@agent-workflow/shared'
import type { z } from 'zod'
import { and, eq, isNull, like } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { agents, plugins } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  cleanupInstallGeneration,
  garbageCollectPluginGenerations,
  installPlugin,
  type InstallResult,
} from './pluginInstaller'
import { pluginOperationCoordinator } from './resourceOperationCoordinator'
import { discloseRefs } from './resourceAcl'
import type { Actor } from '@/auth/actor'

type PluginRow = typeof plugins.$inferSelect
type CreatePluginInput = z.input<typeof CreatePluginSchema>

export interface PluginServiceDeps {
  pluginsDir?: string
  npmBin?: string
  installTimeoutMs?: number
  /** Deterministic interleaving hook; production callers leave this absent. */
  beforePublish?: (captured: Plugin, prepared: InstallResult) => Promise<void>
}

const installOpts = (deps: PluginServiceDeps) => ({
  pluginsDir: deps.pluginsDir,
  npmBin: deps.npmBin,
  timeoutMs: deps.installTimeoutMs,
})

export async function listPlugins(db: DbClient): Promise<Plugin[]> {
  return (await db.select().from(plugins)).map(rowToPlugin)
}

export async function getPlugin(db: DbClient, idOrName: string): Promise<Plugin | null> {
  const row = await getPluginRow(db, idOrName)
  return row === null ? null : rowToPlugin(row)
}

/** Stable-id-only load used after a coordinator lock has been acquired. */
export async function getPluginById(db: DbClient, id: string): Promise<Plugin | null> {
  const rows = await db.select().from(plugins).where(eq(plugins.id, id)).limit(1)
  return rows[0] === undefined ? null : rowToPlugin(rows[0])
}

export async function createPlugin(
  db: DbClient,
  input: CreatePluginInput,
  deps: PluginServiceDeps = {},
  aclOpts?: { ownerUserId?: string },
): Promise<Plugin> {
  const parsed = CreatePluginSchema.parse(input)
  PluginOptionsSchema.parse(parsed.options)
  const id = ulid()
  return pluginOperationCoordinator.runExclusive(id, async () => {
    if ((await getPlugin(db, parsed.name)) !== null) {
      throw new ConflictError('plugin-name-in-use', `plugin '${parsed.name}' already exists`)
    }
    const prepared = await installPlugin(id, parsed.spec, installOpts(deps))
    try {
      const now = Date.now()
      return dbTxSync(db, (tx) => {
        tx.insert(plugins)
          .values({
            id,
            name: parsed.name,
            spec: parsed.spec,
            optionsJson: JSON.stringify(parsed.options),
            description: parsed.description,
            enabled: parsed.enabled,
            sourceKind: prepared.sourceKind,
            cachedPath: prepared.cachedPath,
            resolvedVersion: prepared.resolvedVersion,
            installedAt: now,
            ownerUserId: aclOpts?.ownerUserId ?? null,
            visibility: 'public',
            createdAt: now,
            updatedAt: now,
          })
          .run()
        const created = selectPluginRowById(tx, id)
        if (created === null) throw new Error('plugin disappeared during create publication')
        return rowToPlugin(created)
      })
    } catch (error) {
      await cleanupInstallGeneration(prepared)
      throw error
    }
  })
}

export async function updatePlugin(
  db: DbClient,
  id: string,
  patch: UpdatePlugin,
  deps: PluginServiceDeps = {},
): Promise<Plugin> {
  const captured = await requirePluginRow(db, id)
  const existing = rowToPlugin(captured)
  const nextOptions =
    patch.options === undefined ? existing.options : PluginOptionsSchema.parse(patch.options)
  const specChanged = patch.spec !== undefined && patch.spec !== existing.spec
  const changed =
    specChanged ||
    JSON.stringify(nextOptions) !== JSON.stringify(existing.options) ||
    (patch.description !== undefined && patch.description !== existing.description) ||
    (patch.enabled !== undefined && patch.enabled !== existing.enabled)
  if (!changed) return existing

  let prepared: InstallResult | null = null
  if (specChanged) prepared = await installPlugin(existing.id, patch.spec!, installOpts(deps))
  try {
    if (prepared !== null) await deps.beforePublish?.(existing, prepared)
    return publishPluginUpdate(db, captured, {
      spec: patch.spec ?? existing.spec,
      optionsJson: JSON.stringify(nextOptions),
      description: patch.description ?? existing.description,
      enabled: patch.enabled ?? existing.enabled,
      sourceKind: prepared?.sourceKind ?? existing.sourceKind,
      cachedPath: prepared?.cachedPath ?? existing.cachedPath,
      resolvedVersion: prepared?.resolvedVersion ?? existing.resolvedVersion,
      installedAt: prepared === null ? existing.installedAt : monotonicNow(existing.installedAt),
      updatedAt: monotonicNow(existing.updatedAt),
    })
  } catch (error) {
    if (prepared !== null) await cleanupInstallGeneration(prepared)
    throw error
  }
}

export async function reinstallPlugin(
  db: DbClient,
  id: string,
  deps: PluginServiceDeps = {},
): Promise<Plugin> {
  const captured = await requirePluginRow(db, id)
  const existing = rowToPlugin(captured)
  if (existing.sourceKind === 'file') {
    throw new ValidationError(
      'plugin-operation-unsupported',
      'file source is externally managed and cannot be upgraded',
    )
  }
  const prepared = await installPlugin(existing.id, existing.spec, installOpts(deps))
  try {
    await deps.beforePublish?.(existing, prepared)
    return publishPluginUpdate(db, captured, {
      spec: existing.spec,
      optionsJson: captured.optionsJson,
      description: existing.description,
      enabled: existing.enabled,
      sourceKind: prepared.sourceKind,
      cachedPath: prepared.cachedPath,
      resolvedVersion: prepared.resolvedVersion,
      installedAt: monotonicNow(existing.installedAt),
      updatedAt: monotonicNow(existing.updatedAt),
    })
  } catch (error) {
    await cleanupInstallGeneration(prepared)
    throw error
  }
}

export async function deletePlugin(
  db: DbClient,
  id: string,
  actor: Actor,
  _deps: PluginServiceDeps = {},
): Promise<void> {
  const captured = await requirePluginRow(db, id)
  const existing = rowToPlugin(captured)
  // RFC-223 (PR-1): agents.plugins stores ids — match by this plugin's id.
  const dependents = await findAgentsReferencingPlugin(db, existing.id)
  if (dependents.length > 0) {
    // RFC-203 T6: principal-aware disclosure (deleteWorkflow precedent).
    throw new ConflictError(
      'plugin-still-referenced',
      `plugin '${existing.name}' is referenced by ${dependents.length} agent(s)`,
      await discloseRefs(db, actor, 'agent', dependents),
    )
  }
  dbTxSync(db, (tx) => {
    const result = tx.delete(plugins).where(fullPluginRowWhere(captured)).run()
    if (changesOf(result) !== 1) throw stalePluginError(existing.id)
  })
  // Do not collect inline. Even an aged generation may still be imported by a
  // running child whose Plugin row has just been deleted. The boot/hourly GC
  // adds the coarse "no non-terminal node run" proof before collecting.
}

export async function renamePlugin(db: DbClient, id: string, input: RenamePlugin): Promise<Plugin> {
  const captured = await requirePluginRow(db, id)
  const existing = rowToPlugin(captured)
  if (input.newName === existing.name) return existing
  if ((await getPlugin(db, input.newName)) !== null) {
    throw new ConflictError(
      'plugin-name-in-use',
      `plugin '${input.newName}' already exists; pick a different name`,
    )
  }
  const updatedAt = monotonicNow(existing.updatedAt)
  // RFC-223 (PR-1 / D7): agents.plugins stores the plugin ID, stable across a
  // rename — no cascade. Just rename the row (the old agents.plugins name-rewrite
  // loop is removed).
  dbTxSync(db, (tx) => {
    const result = tx
      .update(plugins)
      .set({ name: input.newName, updatedAt })
      .where(fullPluginRowWhere(captured))
      .run()
    if (changesOf(result) !== 1) throw stalePluginError(existing.id)
  })
  const renamed = await getPluginById(db, existing.id)
  if (renamed === null) throw new Error('plugin disappeared after rename')
  return renamed
}

export interface ReferencingAgentRow {
  id: string
  name: string
  ownerUserId: string | null
  visibility: 'public' | 'private'
}

// RFC-223 (PR-1): agents.plugins stores ids, so the lookup key is the plugin id.
export async function findAgentsReferencingPlugin(
  db: DbClient,
  pluginId: string,
): Promise<ReferencingAgentRow[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      plugins: agents.plugins,
      ownerUserId: agents.ownerUserId,
      visibility: agents.visibility,
    })
    .from(agents)
    .where(like(agents.plugins, `%"${pluginId}"%`))
  const out: ReferencingAgentRow[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.plugins) as unknown
      if (Array.isArray(parsed) && parsed.includes(pluginId))
        out.push({
          id: row.id,
          name: row.name,
          ownerUserId: row.ownerUserId,
          visibility: row.visibility,
        })
    } catch {
      // Corrupt legacy row: same [] fallback as Agent mapper.
    }
  }
  return out
}

export async function collectPluginGenerationGarbage(
  db: DbClient,
  deps: PluginServiceDeps = {},
  opts: { activeCachedPaths?: ReadonlySet<string>; graceMs?: number; now?: number } = {},
): Promise<string[]> {
  const referenced = new Set((await listPlugins(db)).map((plugin) => plugin.cachedPath))
  return garbageCollectPluginGenerations({
    pluginsDir: deps.pluginsDir,
    referencedCachedPaths: referenced,
    activeCachedPaths: opts.activeCachedPaths,
    graceMs: opts.graceMs,
    now: opts.now,
  })
}

function publishPluginUpdate(
  db: DbClient,
  captured: PluginRow,
  set: Pick<
    typeof plugins.$inferInsert,
    | 'spec'
    | 'optionsJson'
    | 'description'
    | 'enabled'
    | 'sourceKind'
    | 'cachedPath'
    | 'resolvedVersion'
    | 'installedAt'
    | 'updatedAt'
  >,
): Plugin {
  return dbTxSync(db, (tx) => {
    const current = selectPluginRowById(tx, captured.id)
    if (current === null || !samePluginRow(current, captured)) throw stalePluginError(captured.id)
    const result = tx.update(plugins).set(set).where(fullPluginRowWhere(captured)).run()
    if (changesOf(result) !== 1) throw stalePluginError(captured.id)
    const published = selectPluginRowById(tx, captured.id)
    if (published === null) throw new Error('plugin disappeared during generation publish')
    return rowToPlugin(published)
  })
}

async function getPluginRow(db: DbClient, idOrName: string): Promise<PluginRow | null> {
  let rows = await db.select().from(plugins).where(eq(plugins.id, idOrName)).limit(1)
  if (rows.length === 0)
    rows = await db.select().from(plugins).where(eq(plugins.name, idOrName)).limit(1)
  return rows[0] ?? null
}

async function requirePluginRow(db: DbClient, id: string): Promise<PluginRow> {
  const row = await getPluginRow(db, id)
  if (row === null) throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  return row
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

function samePluginRow(a: PluginRow, b: PluginRow): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.spec === b.spec &&
    a.optionsJson === b.optionsJson &&
    a.description === b.description &&
    a.enabled === b.enabled &&
    a.sourceKind === b.sourceKind &&
    a.cachedPath === b.cachedPath &&
    a.resolvedVersion === b.resolvedVersion &&
    a.installedAt === b.installedAt &&
    a.ownerUserId === b.ownerUserId &&
    a.visibility === b.visibility &&
    a.aclRevision === b.aclRevision &&
    a.schemaVersion === b.schemaVersion &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  )
}

function changesOf(result: unknown): number {
  return (result as { changes?: number }).changes ?? 0
}

function stalePluginError(id: string): ConflictError {
  return new ConflictError(
    'resource-operation-stale',
    `plugin '${id}' changed while the operation was running; reload and retry`,
  )
}

function monotonicNow(previous: number): number {
  return Math.max(Date.now(), previous + 1)
}

export function rowToPlugin(row: PluginRow): Plugin {
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
