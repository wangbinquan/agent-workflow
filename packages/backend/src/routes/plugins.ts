// Plugin HTTP routes (RFC-031).
// GET    /api/plugins                        — list
// GET    /api/plugins/:id                    — one (accepts id OR name)
// POST   /api/plugins                        — create (synchronously installs spec)
// PUT    /api/plugins/:id                    — update (re-installs if spec changes)
// DELETE /api/plugins/:id                    — delete (refuses if referenced; cleans cache dir)
// POST   /api/plugins/:id/rename             — rename (cascades into agents.plugins arrays)
// POST   /api/plugins/:id/check-update       — probe registry for newer version (does NOT mutate cache)
// POST   /api/plugins/:id/upgrade            — re-install current spec, overwriting cache
//
// Error mapping (via DomainError middleware):
//   ConflictError            → 409  (plugin-name-in-use / plugin-still-referenced)
//   ValidationError          → 422  (zod / options-invalid / plugin-install-failed)
//   NotFoundError            → 404
//   PluginInstallFailedError → 422  (mapped via wrapInstallErrors)
//   PluginInstallTimeoutError→ 422
//   NpmUnavailableError      → 422

import { CreatePluginSchema, RenamePluginSchema, UpdatePluginSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  createPlugin,
  deletePlugin,
  getPlugin,
  listPlugins,
  reinstallPlugin,
  renamePlugin,
  updatePlugin,
} from '@/services/plugin'
import {
  checkForUpdate,
  installPlugin,
  NpmUnavailableError,
  PluginFileNotFoundError,
  PluginInstallFailedError,
  PluginInstallTimeoutError,
} from '@/services/pluginInstaller'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountPluginRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/plugins', async (c) => {
    const list = await listPlugins(deps.db)
    return c.json(list)
  })

  app.get('/api/plugins/:id', async (c) => {
    const idOrName = c.req.param('id')
    const plugin = await getPlugin(deps.db, idOrName)
    if (plugin === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    return c.json(plugin)
  })

  app.post('/api/plugins', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreatePluginSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('plugin-invalid', 'invalid plugin payload', {
        issues: parsed.error.issues,
      })
    }
    try {
      const created = await createPlugin(deps.db, parsed.data)
      return c.json(created, 201)
    } catch (err) {
      throw wrapInstallErrors(err)
    }
  })

  app.put('/api/plugins/:id', async (c) => {
    const idOrName = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = UpdatePluginSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('plugin-invalid', 'invalid plugin patch', {
        issues: parsed.error.issues,
      })
    }
    const existing = await getPlugin(deps.db, idOrName)
    if (existing === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    try {
      const updated = await updatePlugin(deps.db, existing.id, parsed.data)
      return c.json(updated)
    } catch (err) {
      throw wrapInstallErrors(err)
    }
  })

  app.delete('/api/plugins/:id', async (c) => {
    const idOrName = c.req.param('id')
    const existing = await getPlugin(deps.db, idOrName)
    if (existing === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    await deletePlugin(deps.db, existing.id)
    return c.body(null, 204)
  })

  app.post('/api/plugins/:id/rename', async (c) => {
    const idOrName = c.req.param('id')
    const body = await safeJson(c.req.raw)
    const parsed = RenamePluginSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('plugin-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const existing = await getPlugin(deps.db, idOrName)
    if (existing === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    const renamed = await renamePlugin(deps.db, existing.id, parsed.data)
    return c.json(renamed)
  })

  // Probe for a newer version without touching the live cache. Returns
  // { available, current, latest } where `available` is true iff `latest`
  // differs from `current`.
  app.post('/api/plugins/:id/check-update', async (c) => {
    const idOrName = c.req.param('id')
    const existing = await getPlugin(deps.db, idOrName)
    if (existing === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    try {
      const { available, latest } = await checkForUpdate(
        existing.id,
        existing.spec,
        existing.resolvedVersion,
      )
      return c.json({ available, current: existing.resolvedVersion, latest })
    } catch (err) {
      throw wrapInstallErrors(err)
    }
  })

  // Re-install current spec into the live cache. Mutates resolvedVersion +
  // installedAt + cachedPath; never bumps the spec or options.
  app.post('/api/plugins/:id/upgrade', async (c) => {
    const idOrName = c.req.param('id')
    const existing = await getPlugin(deps.db, idOrName)
    if (existing === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    try {
      const updated = await reinstallPlugin(deps.db, existing.id)
      return c.json(updated)
    } catch (err) {
      throw wrapInstallErrors(err)
    }
  })
  // void unused imports — kept so wrapInstallErrors stays self-contained.
  void installPlugin
  void deps
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

/** Map installer-specific error subclasses to user-facing ValidationError 422s. */
function wrapInstallErrors(err: unknown): Error {
  if (err instanceof PluginInstallFailedError) {
    return new ValidationError('plugin-install-failed', err.message, {
      stderr: err.stderr,
      exitCode: err.exitCode,
    })
  }
  if (err instanceof PluginInstallTimeoutError) {
    return new ValidationError('plugin-install-timeout', err.message, {
      timeoutMs: err.timeoutMs,
    })
  }
  if (err instanceof NpmUnavailableError) {
    return new ValidationError('npm-unavailable', err.message, {})
  }
  if (err instanceof PluginFileNotFoundError) {
    return new ValidationError('plugin-file-not-found', err.message, { spec: err.spec })
  }
  return err instanceof Error ? err : new Error(String(err))
}
