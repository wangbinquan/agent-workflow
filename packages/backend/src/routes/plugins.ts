// Plugin HTTP routes (RFC-031 / RFC-201 exact-operation revision).

import {
  CreatePluginSchema,
  DeletePluginSchema,
  PluginOperationRequestSchema,
  RenamePluginRequestSchema,
  UpdatePluginRequestSchema,
  type ResourceAcl,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import type {
  PluginCommands,
  PluginUpdateCommands,
} from '@/modules/resource-catalog/public/commands'
import type {
  PluginAclIdentityParticipant,
  PluginOperationContext,
} from '@/modules/resource-catalog/public/participants'
import type { PluginQueries } from '@/modules/resource-catalog/public/queries'
import type { PluginCatalogResource } from '@/modules/resource-catalog/public/types'
import { registerRoute } from '@/routes/registry'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { serializePluginFor } from '@/services/tokenRedaction'
import { pluginOperationCoordinator } from '@/services/resourceOperationCoordinator'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'
import { safeJsonOrEmpty } from '@/util/http'

export interface PluginRouteDependencies {
  readonly commands: PluginCommands
  readonly updateCommands: PluginUpdateCommands
  readonly queries: PluginQueries
  readonly aclIdentity: PluginAclIdentityParticipant
  readonly authorityFor: (actor: Actor) => PluginOperationContext
}

export function mountPluginRoutes(app: Hono, deps: AppDeps, module: PluginRouteDependencies): void {
  const { commands, updateCommands, queries, aclIdentity } = module

  async function loadVisiblePlugin(actor: Actor, id: string): Promise<PluginCatalogResource> {
    const plugin = await queries.get(module.authorityFor(actor), { id })
    if (plugin === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
    }
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
      const listActor = actorOf(c)
      const visible = await queries.list(module.authorityFor(listActor))
      return c.json(visible.map((plugin) => serializePluginFor(plugin, listActor.source)))
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
        serializePluginFor(await loadVisiblePlugin(actor, c.req.param('id')), actor.source),
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
      const parsed = CreatePluginSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-invalid', 'invalid plugin payload', {
          issues: parsed.error.issues,
        })
      }
      try {
        const actor = actorOf(c)
        const created = await commands.create(module.authorityFor(actor), parsed.data)
        return c.json(serializePluginFor(created, actor.source), 201)
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
      const parsed = UpdatePluginRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-invalid', 'invalid plugin patch', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      try {
        const updated = await commands.update(module.authorityFor(actor), {
          id: initial.id,
          update: parsed.data,
        })
        return c.json(serializePluginFor(updated, actor.source))
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
      const receipt = await commands.delete(module.authorityFor(actor), {
        id: initial.id,
        deletion: parsed.data,
      })
      captureDeleteSnapshot(c, actor, receipt.deleted)
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
      const parsed = RenamePluginRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      const renamed = await commands.rename(module.authorityFor(actor), {
        id: initial.id,
        rename: parsed.data,
      })
      return c.json(serializePluginFor(renamed, actor.source))
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
      const parsed = PluginOperationRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-operation-invalid', 'expectedConfigHash is required', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      try {
        const receipt = await updateCommands.checkUpdate(module.authorityFor(actor), {
          id: initial.id,
          operation: parsed.data,
        })
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
      const parsed = PluginOperationRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-operation-invalid', 'expectedConfigHash is required', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      try {
        const receipt = await updateCommands.upgrade(module.authorityFor(actor), {
          id: initial.id,
          operation: parsed.data,
        })
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
    load: (_db, id) => aclIdentity.load(id),
    coordinator: {
      runExclusive: (resourceId: string, task: () => Promise<ResourceAcl>) =>
        pluginOperationCoordinator.runExclusive(resourceId, task),
      loadById: (_db, resourceId) => aclIdentity.load(resourceId),
      nextUpdatedAt: (row) => aclIdentity.nextUpdatedAt(row.id),
    },
  })
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
