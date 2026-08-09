// Plugin HTTP routes (RFC-031 / RFC-201 exact-operation revision).

import {
  CreatePluginSchema,
  DeletePluginSchema,
  PluginOperationRequestSchema,
  RenamePluginRequestSchema,
  UpdatePluginRequestSchema,
  type Plugin,
  type PluginUpdateCheck,
  type PluginUpgradeResult,
  type ResourceAcl,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { serializePluginFor } from '@/services/tokenRedaction'
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
import { checkForUpdate } from '@/services/pluginInstaller'
import {
  pluginOperationConfigHashOf,
  withPluginOperationConfigHash,
} from '@/services/pluginOperationRevision'
import { pluginOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountPluginRoutes(app: Hono, deps: AppDeps): void {
  async function loadVisiblePlugin(actor: Actor, id: string): Promise<Plugin> {
    const plugin = await getPlugin(deps.db, id)
    if (plugin === null || !(await canViewResource(deps.db, actor, 'plugin', plugin))) {
      throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
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

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/plugins',
      permissions: ['plugins:read'],
      tokenAccess: 'allow',
      summary: 'List plugins visible to the caller',
    },
    async (c) => {
      const visible = await filterVisibleRows(
        deps.db,
        actorOf(c),
        'plugin',
        await listPlugins(deps.db),
      )
      const listActor = actorOf(c)
      return c.json(
        visible.map((r) => serializePluginFor(withPluginOperationConfigHash(r), listActor.source)),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/plugins/:id',
      permissions: ['plugins:read'],
      tokenAccess: 'allow',
      summary: 'Get one plugin',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        serializePluginFor(
          withPluginOperationConfigHash(await loadVisiblePlugin(actor, c.req.param('id'))),
          actor.source,
        ),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/plugins',
      permissions: ['plugins:create'],
      tokenAccess: 'allow',
      summary: 'Install a plugin',
    },
    async (c) => {
      const parsed = CreatePluginSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-invalid', 'invalid plugin payload', {
          issues: parsed.error.issues,
        })
      }
      try {
        const actor = actorOf(c)
        const created = await createPlugin(
          deps.db,
          parsed.data,
          {},
          { ownerUserId: actor.user.id, actor },
        )
        return c.json(serializePluginFor(withPluginOperationConfigHash(created), actor.source), 201)
      } catch (error) {
        throw wrapInstallErrors(error)
      }
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/plugins/:id',
      permissions: ['plugins:update'],
      tokenAccess: 'allow',
      summary: 'Replace a plugin',
    },
    async (c) => {
      const parsed = UpdatePluginRequestSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-invalid', 'invalid plugin patch', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      try {
        const updated = await pluginOperationCoordinator.runExclusive(initial.id, async () => {
          const fresh = await loadFreshOwned(actor, initial.id)
          assertExpectedHash(fresh, parsed.data.expectedConfigHash)
          const { expectedConfigHash: _expectedConfigHash, ...patch } = parsed.data
          return updatePlugin(deps.db, initial.id, patch)
        })
        return c.json(serializePluginFor(withPluginOperationConfigHash(updated), actorOf(c).source))
      } catch (error) {
        throw wrapInstallErrors(error)
      }
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/plugins/:id',
      permissions: ['plugins:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a plugin',
    },
    async (c) => {
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      const deleteBody = await readDeleteBody(c)
      assertDeleteConfirm(deleteBody, initial.name, 'plugin')
      const parsed = DeletePluginSchema.safeParse(deleteBody)
      if (!parsed.success) {
        throw new ValidationError('plugin-delete-invalid', 'invalid plugin delete payload', {
          issues: parsed.error.issues,
        })
      }
      await pluginOperationCoordinator.runExclusive(initial.id, async () => {
        const fresh = await loadFreshOwned(actor, initial.id)
        assertExpectedHash(fresh, parsed.data.expectedConfigHash)
        // RFC-222 (D5, N-6): confirm against the fresh name in the exclusive section.
        assertDeleteConfirm(parsed.data, fresh.name, 'plugin')
        captureDeleteSnapshot(c, actor, initial)
        await deletePlugin(deps.db, initial.id, actor)
      })
      return c.body(null, 204)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/plugins/:id/rename',
      permissions: ['plugins:update'],
      tokenAccess: 'allow',
      summary: 'Rename a plugin',
    },
    async (c) => {
      const parsed = RenamePluginRequestSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      const renamed = await pluginOperationCoordinator.runExclusive(initial.id, async () => {
        const fresh = await loadFreshOwned(actor, initial.id)
        assertExpectedHash(fresh, parsed.data.expectedConfigHash)
        const { expectedConfigHash: _expectedConfigHash, ...rename } = parsed.data
        return renamePlugin(deps.db, initial.id, rename)
      })
      return c.json(serializePluginFor(withPluginOperationConfigHash(renamed), actorOf(c).source))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/plugins/:id/check-update',
      permissions: ['plugins:execute'],
      tokenAccess: 'allow',
      summary: 'Check upstream for a newer version',
    },
    async (c) => {
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
        const receipt =
          await pluginOperationCoordinator.runDeduplicatedOperation<PluginUpdateCheck>(
            initial.id,
            parsed.data.expectedConfigHash,
            async () => {
              const captured = await pluginOperationCoordinator.runExclusive(
                initial.id,
                async () => {
                  const fresh = await loadFreshOwned(actor, initial.id)
                  assertExpectedHash(fresh, parsed.data.expectedConfigHash)
                  assertOperationSupported(fresh)
                  return fresh
                },
              )
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
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/plugins/:id/upgrade',
      permissions: ['plugins:update'],
      tokenAccess: 'allow',
      summary: 'Upgrade a plugin to a newer version',
    },
    async (c) => {
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
    },
  )

  mountAclEndpoints(app, deps, {
    type: 'plugin',
    base: '/api/plugins',
    param: 'id',
    load: (db, id) => getPluginById(db, id),
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

/**
 * 安装失败的四个类**自己**就是 `ValidationError`（见 `pluginInstaller.ts` 的注释：
 * 翻译层留在路由里，就注定漏掉后来的入口——意图提交与配置包导入两条同样会装插件的
 * 路径当初就都掉进了 500）。所以这里不再逐类重建，只保留「非 Error 抛出物归一」这
 * 一点点残余职责。
 */
function wrapInstallErrors(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
