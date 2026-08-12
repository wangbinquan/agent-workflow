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
import { and, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { agents, plugins } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import {
  cleanupInstallGeneration,
  garbageCollectPluginGenerations,
  installPlugin,
  type InstallResult,
} from './pluginInstaller'
import { pluginOperationCoordinator } from './resourceOperationCoordinator'
import { assertInitialResourceOwner, discloseRefs, initialPrivateResourceAcl } from './resourceAcl'
import {
  findAgentsReferencingIdInJsonColumn,
  findAgentsReferencingIdInJsonColumnInTx,
  type ReferencingAgentRow,
} from './resourceRefs'
import type { Actor } from '@/auth/actor'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from './ownerScopedName'
import { monotonicNow } from '@/util/time'

type PluginRow = typeof plugins.$inferSelect
type CreatePluginInput = z.input<typeof CreatePluginSchema>

export interface PluginServiceDeps {
  pluginsDir?: string
  npmBin?: string
  installTimeoutMs?: number
  /** Deterministic interleaving hook; production callers leave this absent. */
  beforePublish?: (captured: Plugin, prepared: InstallResult) => Promise<void>
  /** Deterministic delete check→transaction interleaving hook for race tests. */
  beforeDeleteTx?: (captured: Plugin) => Promise<void>
}

const installOpts = (deps: PluginServiceDeps) => ({
  pluginsDir: deps.pluginsDir,
  npmBin: deps.npmBin,
  timeoutMs: deps.installTimeoutMs,
})

export async function listPlugins(db: DbClient): Promise<Plugin[]> {
  return (await db.select().from(plugins)).map(rowToPlugin)
}

/** Public loads are stable-id-only. Names remain mutable display labels. */
export async function getPlugin(db: DbClient, id: string): Promise<Plugin | null> {
  return getPluginById(db, id)
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
  aclOpts?: { ownerUserId?: string; actor?: Actor | null },
): Promise<Plugin> {
  const parsed = CreatePluginSchema.parse(input)
  PluginOptionsSchema.parse(parsed.options)
  const id = ulid()
  const ownerUserId = aclOpts?.ownerUserId ?? null
  assertInitialResourceOwner(aclOpts?.actor, ownerUserId)
  const initialAcl = initialPrivateResourceAcl(ownerUserId)
  return pluginOperationCoordinator.runExclusive(id, async () => {
    const occupied = await db
      .select({ id: plugins.id })
      .from(plugins)
      .where(ownerScopedNameWhere(plugins.ownerUserId, plugins.name, ownerUserId, parsed.name))
      .limit(1)
    if (occupied.length > 0) {
      throw new ConflictError('plugin-name-in-use', `plugin '${parsed.name}' already exists`)
    }
    const prepared = await installPlugin(id, parsed.spec, installOpts(deps))
    try {
      return dbTxSync(db, (tx) =>
        commitPluginCreateInTx(tx, {
          id,
          parsed,
          initialAcl,
          install: prepared,
          now: Date.now(),
        }),
      )
    } catch (error) {
      await cleanupInstallGeneration(prepared)
      if (isOwnerNameUniqueViolation(error, 'plugins', 'plugins_owner_name_unique')) {
        throw new ConflictError('plugin-name-in-use', `plugin '${parsed.name}' already exists`)
      }
      throw error
    }
  })
}

/** RFC-234 (T6) — the plugin create insert core. The npm/git install runs
 *  BEFORE this (installPlugin — the intent pipeline's preinstall phase records
 *  the generation in its journal first); a failed transaction is compensated
 *  with cleanupInstallGeneration by the caller. */
export interface PreparedPluginCreate {
  id: string
  parsed: {
    name: string
    spec: string
    options: Record<string, unknown>
    description: string
    enabled: boolean
  }
  initialAcl: ReturnType<typeof initialPrivateResourceAcl>
  install: InstallResult
  now: number
}

export function commitPluginCreateInTx(tx: DbTxSync, p: PreparedPluginCreate): Plugin {
  tx.insert(plugins)
    .values({
      id: p.id,
      name: p.parsed.name,
      spec: p.parsed.spec,
      optionsJson: JSON.stringify(p.parsed.options),
      description: p.parsed.description,
      enabled: p.parsed.enabled,
      sourceKind: p.install.sourceKind,
      cachedPath: p.install.cachedPath,
      resolvedVersion: p.install.resolvedVersion,
      installedAt: p.now,
      // RFC-231: every user-created resource starts private with ACL rev 0.
      ...p.initialAcl,
      createdAt: p.now,
      updatedAt: p.now,
    })
    .run()
  const created = selectPluginRowById(tx, p.id)
  if (created === null) throw new Error('plugin disappeared during create publication')
  return rowToPlugin(created)
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
  deps: PluginServiceDeps = {},
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
  await deps.beforeDeleteTx?.(existing)

  // Re-run the reverse-reference guard in the exact transaction that removes
  // the target. A canonical-id agent reference that lands after the
  // preliminary async check therefore blocks the DELETE instead of becoming a
  // dangling reference.
  const finalDependents = dbTxSync(db, (tx) => {
    const current = selectPluginRowById(tx, captured.id)
    if (current === null || !samePluginRow(current, captured)) throw stalePluginError(captured.id)
    const refs = findAgentsReferencingPluginInTx(tx, existing.id)
    if (refs.length > 0) return refs
    const result = tx.delete(plugins).where(fullPluginRowWhere(captured)).run()
    if (changesOf(result) !== 1) throw stalePluginError(existing.id)
    return [] as ReferencingAgentRow[]
  })
  if (finalDependents.length > 0) {
    throw new ConflictError(
      'plugin-still-referenced',
      `plugin '${existing.name}' is referenced by ${finalDependents.length} agent(s)`,
      await discloseRefs(db, actor, 'agent', finalDependents),
    )
  }
  // Do not collect inline. Even an aged generation may still be imported by a
  // running child whose Plugin row has just been deleted. The boot/hourly GC
  // adds the coarse "no non-terminal node run" proof before collecting.
}

export async function renamePlugin(db: DbClient, id: string, input: RenamePlugin): Promise<Plugin> {
  const captured = await requirePluginRow(db, id)
  const existing = rowToPlugin(captured)
  if (input.newName === existing.name) return existing
  const occupied = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(
      ownerScopedNameWhere(plugins.ownerUserId, plugins.name, captured.ownerUserId, input.newName, {
        column: plugins.id,
        id: captured.id,
      }),
    )
    .limit(1)
  if (occupied.length > 0) {
    throw new ConflictError(
      'plugin-name-in-use',
      `plugin '${input.newName}' already exists; pick a different name`,
    )
  }
  const updatedAt = monotonicNow(existing.updatedAt)
  // RFC-223 (PR-1 / D7): agents.plugins stores the plugin ID, stable across a
  // rename — no cascade. Just rename the row (the old agents.plugins name-rewrite
  // loop is removed).
  try {
    dbTxSync(db, (tx) => {
      const result = tx
        .update(plugins)
        .set({ name: input.newName, updatedAt })
        .where(fullPluginRowWhere(captured))
        .run()
      if (changesOf(result) !== 1) throw stalePluginError(existing.id)
    })
  } catch (error) {
    if (isOwnerNameUniqueViolation(error, 'plugins', 'plugins_owner_name_unique')) {
      throw new ConflictError(
        'plugin-name-in-use',
        `plugin '${input.newName}' already exists; pick a different name`,
      )
    }
    throw error
  }
  const renamed = await getPluginById(db, existing.id)
  if (renamed === null) throw new Error('plugin disappeared after rename')
  return renamed
}

// RFC-284 T9：两段式扫描收编 resourceRefs 泛型——本域只留 matcher。
// RFC-223 (PR-1): agents.plugins stores ids, so the lookup key is the plugin id.
export type { ReferencingAgentRow } from './resourceRefs'

const pluginRefArgs = (pluginId: string) => ({
  column: agents.plugins,
  id: pluginId,
  matches: (parsed: unknown, id: string) => Array.isArray(parsed) && parsed.includes(id),
})

export async function findAgentsReferencingPlugin(
  db: DbClient,
  pluginId: string,
): Promise<ReferencingAgentRow[]> {
  return findAgentsReferencingIdInJsonColumn(db, pluginRefArgs(pluginId))
}

function findAgentsReferencingPluginInTx(tx: DbTxSync, pluginId: string): ReferencingAgentRow[] {
  return findAgentsReferencingIdInJsonColumnInTx(tx, pluginRefArgs(pluginId))
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

export type PluginPublishSet = Pick<
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
>

/** RFC-234 (T6) — the update publish core: full-captured-row identity fence
 *  (any concurrent change → resource-operation-stale), then atomic set. */
export function commitPluginPublishInTx(
  tx: DbTxSync,
  captured: PluginRow,
  set: PluginPublishSet,
): Plugin {
  const current = selectPluginRowById(tx, captured.id)
  if (current === null || !samePluginRow(current, captured)) throw stalePluginError(captured.id)
  const result = tx.update(plugins).set(set).where(fullPluginRowWhere(captured)).run()
  if (changesOf(result) !== 1) throw stalePluginError(captured.id)
  const published = selectPluginRowById(tx, captured.id)
  if (published === null) throw new Error('plugin disappeared during generation publish')
  return rowToPlugin(published)
}

function publishPluginUpdate(db: DbClient, captured: PluginRow, set: PluginPublishSet): Plugin {
  return dbTxSync(db, (tx) => commitPluginPublishInTx(tx, captured, set))
}

async function requirePluginRow(db: DbClient, id: string): Promise<PluginRow> {
  const row = await db.select().from(plugins).where(eq(plugins.id, id)).limit(1)
  if (row[0] === undefined) throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  return row[0]
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
  // RFC-285 B5：家族先行站点收编 staleConflictError（补 resource 字段）。
  return staleConflictError(
    'plugin',
    `plugin '${id}' changed while the operation was running; reload and retry`,
  )
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
