// Plugin service — CRUD on the plugins table (RFC-031).
//
// Mirrors services/mcp.ts: DB is the source of truth, JSON config is
// (un)marshaled at this boundary, name uniqueness enforced both by the column
// index and by an explicit pre-insert lookup so we can return a friendly
// ConflictError instead of a SQL exception.
//
// Distinguishing concerns from MCP:
//   - Each plugin row has a *backing install* on disk under
//     `~/.agent-workflow/plugins/{id}/`. createPlugin / updatePlugin call the
//     installer **before** persisting the row; if install fails we throw and
//     leave the table untouched. deletePlugin always tries to clean the dir
//     after the row is gone (best-effort; ignored on missing path).
//   - The spec column stores the user-typed string; the cached path + version
//     produced by the installer are persisted alongside so the runner injects
//     a stable file:// path at spawn time without re-resolving.
//
// Reference check `findAgentsReferencingPlugin` powers the still-referenced
// guard on delete / rename so the platform never silently breaks an agent's
// `plugins: [...]` list — same pattern as RFC-022 / RFC-028.

import type { Plugin, RenamePlugin, UpdatePlugin } from '@agent-workflow/shared'
import {
  CreatePluginSchema,
  PluginOptionsSchema,
  PluginSchema,
} from '@agent-workflow/shared'
import type { z } from 'zod'

/**
 * Input shape for createPlugin: matches the *pre-default* zod input so callers
 * can omit optional fields (options / description / enabled) and let the schema
 * fill them in at parse time. Using the post-default output type would force
 * every test + route caller to pass defaults explicitly.
 */
type CreatePluginInput = z.input<typeof CreatePluginSchema>
import { eq, like } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { agents, plugins } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { cleanupPluginDir, installPlugin } from './pluginInstaller'

type PluginRow = typeof plugins.$inferSelect

export interface PluginServiceDeps {
  /** Test override for the installer dir (`~/.agent-workflow/plugins/` in prod). */
  pluginsDir?: string
  /** Test override for the npm binary path (e.g. fake-npm.sh). */
  npmBin?: string
  /** Install timeout override; passed through to the installer. */
  installTimeoutMs?: number
}

export async function listPlugins(db: DbClient): Promise<Plugin[]> {
  const rows = await db.select().from(plugins)
  return rows.map(rowToPlugin)
}

export async function getPlugin(db: DbClient, idOrName: string): Promise<Plugin | null> {
  // Try id first, then name. We keep both lookup paths so the HTTP layer
  // can serve `/api/plugins/{id|name}` symmetrically.
  let rows = await db.select().from(plugins).where(eq(plugins.id, idOrName)).limit(1)
  if (rows.length === 0) {
    rows = await db.select().from(plugins).where(eq(plugins.name, idOrName)).limit(1)
  }
  const row = rows[0]
  return row ? rowToPlugin(row) : null
}

export async function createPlugin(
  db: DbClient,
  input: CreatePluginInput,
  deps: PluginServiceDeps = {},
): Promise<Plugin> {
  if ((await getPlugin(db, input.name)) !== null) {
    throw new ConflictError('plugin-name-in-use', `plugin '${input.name}' already exists`)
  }
  // Defensive options re-validation (route already enforces it).
  PluginOptionsSchema.parse(input.options ?? {})

  const id = ulid()
  // Install BEFORE the row exists — failure means we never persist a record
  // pointing at a missing entry.
  const install = await installPlugin(id, input.spec, {
    pluginsDir: deps.pluginsDir,
    npmBin: deps.npmBin,
    timeoutMs: deps.installTimeoutMs,
  })

  const now = Date.now()
  await db.insert(plugins).values({
    id,
    name: input.name,
    spec: input.spec,
    optionsJson: JSON.stringify(input.options ?? {}),
    description: input.description ?? '',
    enabled: input.enabled ?? true,
    sourceKind: install.sourceKind,
    cachedPath: install.cachedPath,
    resolvedVersion: install.resolvedVersion,
    installedAt: now,
    createdAt: now,
    updatedAt: now,
  })

  const created = await getPlugin(db, id)
  if (created === null) {
    // Defensive: row gone immediately after insert means the install just
    // succeeded for nothing. Try to clean the dir so we don't leak.
    await cleanupPluginDir(id, { pluginsDir: deps.pluginsDir }).catch(() => undefined)
    throw new Error('plugin disappeared right after insert')
  }
  return created
}

export async function updatePlugin(
  db: DbClient,
  id: string,
  patch: UpdatePlugin,
  deps: PluginServiceDeps = {},
): Promise<Plugin> {
  const existing = await getPlugin(db, id)
  if (existing === null) {
    throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  }
  const set: Partial<typeof plugins.$inferInsert> = { updatedAt: Date.now() }
  let reinstalled = false

  // Spec changes trigger a fresh install on top of the same plugin dir; the
  // in-flight Map inside the installer keeps concurrent spec-edit calls from
  // racing. We persist the new cachedPath / version atomically with the spec.
  if (patch.spec !== undefined && patch.spec !== existing.spec) {
    const install = await installPlugin(existing.id, patch.spec, {
      pluginsDir: deps.pluginsDir,
      npmBin: deps.npmBin,
      timeoutMs: deps.installTimeoutMs,
    })
    set.spec = patch.spec
    set.sourceKind = install.sourceKind
    set.cachedPath = install.cachedPath
    set.resolvedVersion = install.resolvedVersion
    set.installedAt = Date.now()
    reinstalled = true
  }
  if (patch.options !== undefined) {
    PluginOptionsSchema.parse(patch.options)
    set.optionsJson = JSON.stringify(patch.options)
  }
  if (patch.description !== undefined) set.description = patch.description
  if (patch.enabled !== undefined) set.enabled = patch.enabled

  await db.update(plugins).set(set).where(eq(plugins.id, existing.id))
  const updated = await getPlugin(db, existing.id)
  if (updated === null) throw new Error('plugin disappeared after update')
  // reinstalled flag is informational; reserved for future event tap.
  void reinstalled
  return updated
}

export async function deletePlugin(
  db: DbClient,
  id: string,
  deps: PluginServiceDeps = {},
): Promise<void> {
  const existing = await getPlugin(db, id)
  if (existing === null) {
    throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  }
  const dependents = await findAgentsReferencingPlugin(db, existing.name)
  if (dependents.length > 0) {
    throw new ConflictError(
      'plugin-still-referenced',
      `plugin '${existing.name}' is referenced by ${dependents.length} agent(s)`,
      { referencedBy: dependents },
    )
  }
  await db.delete(plugins).where(eq(plugins.id, existing.id))
  // Re-confirm the row really left before touching disk — defensive against a
  // race where another writer re-created with the same id (impossible in
  // practice with ULID, but cheap to check).
  const stillThere = await getPlugin(db, existing.id)
  if (stillThere === null) {
    await cleanupPluginDir(existing.id, { pluginsDir: deps.pluginsDir }).catch(() => undefined)
  }
}

/**
 * Force a re-install of the plugin's current spec, overwriting the cache
 * directory contents and refreshing `cachedPath` / `resolvedVersion` /
 * `installedAt`. Used by the "upgrade" UI button when the user has confirmed
 * a newer version is available. Unlike `updatePlugin({ spec })`, this does
 * NOT short-circuit when the spec is unchanged.
 */
export async function reinstallPlugin(
  db: DbClient,
  id: string,
  deps: PluginServiceDeps = {},
): Promise<Plugin> {
  const existing = await getPlugin(db, id)
  if (existing === null) {
    throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  }
  const install = await installPlugin(existing.id, existing.spec, {
    pluginsDir: deps.pluginsDir,
    npmBin: deps.npmBin,
    timeoutMs: deps.installTimeoutMs,
  })
  const now = Date.now()
  await db
    .update(plugins)
    .set({
      sourceKind: install.sourceKind,
      cachedPath: install.cachedPath,
      resolvedVersion: install.resolvedVersion,
      installedAt: now,
      updatedAt: now,
    })
    .where(eq(plugins.id, existing.id))
  const updated = await getPlugin(db, existing.id)
  if (updated === null) throw new Error('plugin disappeared after reinstall')
  return updated
}

export async function renamePlugin(db: DbClient, id: string, input: RenamePlugin): Promise<Plugin> {
  const existing = await getPlugin(db, id)
  if (existing === null) {
    throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  }
  if (input.newName === existing.name) return existing
  if ((await getPlugin(db, input.newName)) !== null) {
    throw new ConflictError(
      'plugin-name-in-use',
      `plugin '${input.newName}' already exists; pick a different name`,
    )
  }
  // Rename + cascade update of agents.plugins arrays inside a single
  // transaction so we never end up with a renamed row plus stale agent refs.
  const dependents = await findAgentsReferencingPlugin(db, existing.name)
  await db.transaction(async (tx) => {
    await tx
      .update(plugins)
      .set({ name: input.newName, updatedAt: Date.now() })
      .where(eq(plugins.id, existing.id))

    for (const dep of dependents) {
      const row = await tx
        .select({ plugins: agents.plugins })
        .from(agents)
        .where(eq(agents.id, dep.id))
        .limit(1)
      const current = row[0]
      if (current === undefined) continue
      let arr: string[]
      try {
        const parsed = JSON.parse(current.plugins) as unknown
        arr = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
      } catch {
        arr = []
      }
      const next = arr.map((n) => (n === existing.name ? input.newName : n))
      await tx
        .update(agents)
        .set({ plugins: JSON.stringify(next), updatedAt: Date.now() })
        .where(eq(agents.id, dep.id))
    }
  })

  const renamed = await getPlugin(db, existing.id)
  if (renamed === null) throw new Error('plugin disappeared after rename')
  return renamed
}

/**
 * Returns the agents (id + name) whose `plugins` JSON column contains `name`.
 *
 * Two-stage matching: SQL `LIKE` pre-filter is coarse (substring match) so we
 * re-parse and exact-match with Array.includes. Without the exact match, name
 * 'dd' would falsely flag a row whose plugins is `["dd-trace"]`.
 */
export async function findAgentsReferencingPlugin(
  db: DbClient,
  name: string,
): Promise<Array<{ id: string; name: string }>> {
  const rows = await db
    .select({ id: agents.id, name: agents.name, plugins: agents.plugins })
    .from(agents)
    .where(like(agents.plugins, `%"${name}"%`))

  const out: Array<{ id: string; name: string }> = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.plugins) as unknown
      if (Array.isArray(parsed) && parsed.includes(name)) {
        out.push({ id: row.id, name: row.name })
      }
    } catch {
      // malformed column — agent.ts parser treats it as [] anyway
    }
  }
  return out
}

// --- internals ---

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
