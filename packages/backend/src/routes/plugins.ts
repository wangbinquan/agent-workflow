// Plugin HTTP routes (RFC-031 / RFC-201 exact-operation revision).

import {
  CreatePluginSchema,
  PluginOperationRequestSchema,
  RenamePluginSchema,
  UpdatePluginSchema,
  type Plugin,
  type PluginUpdateCheck,
  type PluginUpgradeResult,
  type ResourceAcl,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  createPlugin,
  deletePlugin,
  getPlugin,
  getPluginById,
  listPlugins,
  reinstallPlugin,
  renamePlugin,
  updatePlugin,
} from '@/services/plugin'
import {
  checkForUpdate,
  NpmUnavailableError,
  PluginFileNotFoundError,
  PluginInstallFailedError,
  PluginInstallTimeoutError,
} from '@/services/pluginInstaller'
import {
  pluginOperationConfigHashOf,
  withPluginOperationConfigHash,
} from '@/services/pluginOperationRevision'
import { pluginOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountPluginRoutes(app: Hono, deps: AppDeps): void {
  async function loadVisiblePlugin(actor: Actor, idOrName: string): Promise<Plugin> {
    const plugin = await getPlugin(deps.db, idOrName)
    if (plugin === null || !(await canViewResource(deps.db, actor, 'plugin', plugin))) {
      throw new NotFoundError('plugin-not-found', `plugin '${idOrName}' not found`)
    }
    return plugin
  }

  async function loadFreshOwned(actor: Actor, stableId: string): Promise<Plugin> {
    const plugin = await getPluginById(deps.db, stableId)
    if (plugin === null || !(await canViewResource(deps.db, actor, 'plugin', plugin))) {
      throw new NotFoundError('plugin-not-found', `plugin '${stableId}' not found`)
    }
    await requireResourceOwner(deps.db, actor, 'plugin', plugin)
    return plugin
  }

  app.get('/api/plugins', async (c) => {
    const visible = await filterVisibleRows(
      deps.db,
      actorOf(c),
      'plugin',
      await listPlugins(deps.db),
    )
    return c.json(visible.map(withPluginOperationConfigHash))
  })

  app.get('/api/plugins/:id', async (c) => {
    return c.json(
      withPluginOperationConfigHash(await loadVisiblePlugin(actorOf(c), c.req.param('id'))),
    )
  })

  app.post('/api/plugins', async (c) => {
    const parsed = CreatePluginSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('plugin-invalid', 'invalid plugin payload', {
        issues: parsed.error.issues,
      })
    }
    try {
      const created = await createPlugin(
        deps.db,
        parsed.data,
        {},
        { ownerUserId: actorOf(c).user.id },
      )
      return c.json(withPluginOperationConfigHash(created), 201)
    } catch (error) {
      throw wrapInstallErrors(error)
    }
  })

  app.put('/api/plugins/:id', async (c) => {
    const parsed = UpdatePluginSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('plugin-invalid', 'invalid plugin patch', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const initial = await loadVisiblePlugin(actor, c.req.param('id'))
    try {
      const updated = await pluginOperationCoordinator.runExclusive(initial.id, async () => {
        await loadFreshOwned(actor, initial.id)
        return updatePlugin(deps.db, initial.id, parsed.data)
      })
      return c.json(withPluginOperationConfigHash(updated))
    } catch (error) {
      throw wrapInstallErrors(error)
    }
  })

  app.delete('/api/plugins/:id', async (c) => {
    const actor = actorOf(c)
    const initial = await loadVisiblePlugin(actor, c.req.param('id'))
    await pluginOperationCoordinator.runExclusive(initial.id, async () => {
      await loadFreshOwned(actor, initial.id)
      await deletePlugin(deps.db, initial.id, actor)
    })
    return c.body(null, 204)
  })

  app.post('/api/plugins/:id/rename', async (c) => {
    const parsed = RenamePluginSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('plugin-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const initial = await loadVisiblePlugin(actor, c.req.param('id'))
    const renamed = await pluginOperationCoordinator.runExclusive(initial.id, async () => {
      await loadFreshOwned(actor, initial.id)
      return renamePlugin(deps.db, initial.id, parsed.data)
    })
    return c.json(withPluginOperationConfigHash(renamed))
  })

  app.post('/api/plugins/:id/check-update', async (c) => {
    const parsed = PluginOperationRequestSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('plugin-operation-invalid', 'expectedConfigHash is required', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const initial = await loadVisiblePlugin(actor, c.req.param('id'))
    await requireResourceOwner(deps.db, actor, 'plugin', initial)
    assertOperationSupported(initial)

    try {
      const receipt = await pluginOperationCoordinator.runDeduplicatedOperation<PluginUpdateCheck>(
        initial.id,
        parsed.data.expectedConfigHash,
        async () => {
          const captured = await pluginOperationCoordinator.runExclusive(initial.id, async () => {
            const fresh = await loadFreshOwned(actor, initial.id)
            assertExpectedHash(fresh, parsed.data.expectedConfigHash)
            assertOperationSupported(fresh)
            return fresh
          })
          const result = await checkForUpdate(captured.id, captured.spec, captured.cachedPath)
          return pluginOperationCoordinator.runExclusive(captured.id, async () => {
            const current = await loadFreshOwned(actor, captured.id)
            assertExpectedHash(current, parsed.data.expectedConfigHash)
            return {
              available: result.available,
              current: captured.resolvedVersion,
              latest: result.latest,
              identityStatus: result.identityStatus,
              configHashUsed: parsed.data.expectedConfigHash,
            }
          })
        },
      )
      return c.json(receipt)
    } catch (error) {
      throw wrapInstallErrors(error)
    }
  })

  app.post('/api/plugins/:id/upgrade', async (c) => {
    const parsed = PluginOperationRequestSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('plugin-operation-invalid', 'expectedConfigHash is required', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const initial = await loadVisiblePlugin(actor, c.req.param('id'))
    try {
      const receipt = await pluginOperationCoordinator.runExclusive<PluginUpgradeResult>(
        initial.id,
        async () => {
          const captured = await loadFreshOwned(actor, initial.id)
          assertExpectedHash(captured, parsed.data.expectedConfigHash)
          assertOperationSupported(captured)

          // Upgrade authorization never trusts a frontend cache. A legacy
          // generation with unknown identity is allowed to reinstall once to
          // establish a manifest baseline; a known no-change stays a no-op.
          const check = await checkForUpdate(captured.id, captured.spec, captured.cachedPath)
          const updated =
            check.identityStatus === 'known' && !check.available
              ? captured
              : await reinstallPlugin(deps.db, captured.id)
          return {
            configHashUsed: parsed.data.expectedConfigHash,
            resource: withPluginOperationConfigHash(updated),
          }
        },
      )
      return c.json(receipt)
    } catch (error) {
      throw wrapInstallErrors(error)
    }
  })

  mountAclEndpoints(app, deps, {
    type: 'plugin',
    base: '/api/plugins',
    param: 'id',
    load: (db, idOrName) => getPlugin(db, idOrName),
    coordinator: {
      runExclusive: (resourceId: string, task: () => Promise<ResourceAcl>) =>
        pluginOperationCoordinator.runExclusive(resourceId, task),
      loadById: (db, resourceId) => getPluginById(db, resourceId),
    },
  })
}

function assertExpectedHash(plugin: Plugin, expected: string): void {
  if (pluginOperationConfigHashOf(plugin) !== expected) {
    throw new ConflictError(
      'resource-operation-stale',
      'plugin changed since this operation was prepared; reload and retry',
    )
  }
}

function assertOperationSupported(plugin: Plugin): void {
  if (plugin.sourceKind === 'file') {
    throw new ValidationError(
      'plugin-operation-unsupported',
      'file source is externally managed and does not support Check or Upgrade',
    )
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function wrapInstallErrors(error: unknown): Error {
  if (error instanceof PluginInstallFailedError) {
    return new ValidationError('plugin-install-failed', error.message, {
      stderr: error.stderr,
      exitCode: error.exitCode,
    })
  }
  if (error instanceof PluginInstallTimeoutError) {
    return new ValidationError('plugin-install-timeout', error.message, {
      timeoutMs: error.timeoutMs,
    })
  }
  if (error instanceof NpmUnavailableError) {
    return new ValidationError('npm-unavailable', error.message, {})
  }
  if (error instanceof PluginFileNotFoundError) {
    return new ValidationError('plugin-file-not-found', error.message, { spec: error.spec })
  }
  return error instanceof Error ? error : new Error(String(error))
}
