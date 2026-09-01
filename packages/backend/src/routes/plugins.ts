// Plugin HTTP routes (RFC-031 / RFC-201 exact-operation revision).

import {
  CreatePluginSchema,
  DeletePluginSchema,
  PluginOperationRequestSchema,
  RenamePluginRequestSchema,
  UpdatePluginRequestSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { PluginOperationDescriptors } from '@/modules/resource-catalog/public/operations'
import type { PluginOperationContext } from '@/modules/resource-catalog/public/participants'
import type { PluginQueries } from '@/modules/resource-catalog/public/queries'
import type {
  CheckPluginUpdateCatalogInput,
  CheckPluginUpdateCatalogReceipt,
  CreatePluginCatalogInput,
  DeletePluginCatalogInput,
  DeletePluginCatalogReceipt,
  PluginCatalogResource,
  RenamePluginCatalogInput,
  UpdatePluginCatalogInput,
  UpgradePluginCatalogInput,
  UpgradePluginCatalogReceipt,
} from '@/modules/resource-catalog/public/types'
import { registerOperationRoute } from '@/routes/operationRoute'
import { captureDeleteSnapshot } from '@/services/tokenAudit'
import { serializePluginFor } from '@/services/tokenRedaction'
import { assertDeleteConfirm, readDeleteBody } from '@/services/deleteConfirm'
import { NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export interface PluginRouteDependencies {
  readonly queries: PluginQueries
  readonly operations: PluginOperationDescriptors
  readonly authorityFor: (actor: Actor) => PluginOperationContext
}

export function mountPluginRoutes(app: Hono, module: PluginRouteDependencies): void {
  const { queries, operations } = module

  async function loadVisiblePlugin(actor: Actor, id: string): Promise<PluginCatalogResource> {
    const plugin = await queries.get(module.authorityFor(actor), { id })
    if (plugin === null) {
      throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
    }
    return plugin
  }

  registerOperationRoute(app, {
    descriptor: operations.list,
    method: 'GET',
    path: '/api/plugins',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, visible) => {
      const listActor = actorOf(c)
      return c.json(visible.map((plugin) => serializePluginFor(plugin, listActor.source)))
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.get,
    method: 'GET',
    path: '/api/plugins/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, plugin) => {
      const actor = actorOf(c)
      if (plugin === null)
        throw new NotFoundError('plugin-not-found', `plugin '${c.req.param('id')}' not found`)
      return c.json(serializePluginFor(plugin, actor.source))
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.create,
    method: 'POST',
    path: '/api/plugins',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = CreatePluginSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-invalid', 'invalid plugin payload', {
          issues: parsed.error.issues,
        })
      }
      return parsed.data satisfies CreatePluginCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, created) => c.json(serializePluginFor(created, actorOf(c).source), 201),
    mapError: (error) => {
      throw wrapInstallErrors(error)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.update,
    method: 'PUT',
    path: '/api/plugins/:id',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = UpdatePluginRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-invalid', 'invalid plugin patch', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      return { id: initial.id, update: parsed.data } satisfies UpdatePluginCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, updated) => c.json(serializePluginFor(updated, actorOf(c).source)),
    mapError: (error) => {
      throw wrapInstallErrors(error)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.delete,
    method: 'DELETE',
    path: '/api/plugins/:id',
    tokenAccess: 'allow',
    decode: async (c) => {
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
      return {
        id: initial.id,
        deletion: parsed.data,
      } satisfies DeletePluginCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt: DeletePluginCatalogReceipt) => {
      captureDeleteSnapshot(c, actorOf(c), receipt.deleted)
      return c.body(null, 204)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.rename,
    method: 'POST',
    path: '/api/plugins/:id/rename',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = RenamePluginRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      return {
        id: initial.id,
        rename: parsed.data,
      } satisfies RenamePluginCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, renamed) => c.json(serializePluginFor(renamed, actorOf(c).source)),
  })

  registerOperationRoute(app, {
    descriptor: operations.checkUpdate,
    method: 'POST',
    path: '/api/plugins/:id/check-update',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = PluginOperationRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-operation-invalid', 'expectedConfigHash is required', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      return {
        id: initial.id,
        operation: parsed.data,
      } satisfies CheckPluginUpdateCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt: CheckPluginUpdateCatalogReceipt) => c.json(receipt),
    mapError: (error) => {
      throw wrapInstallErrors(error)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.upgrade,
    method: 'POST',
    path: '/api/plugins/:id/upgrade',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = PluginOperationRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('plugin-operation-invalid', 'expectedConfigHash is required', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const initial = await loadVisiblePlugin(actor, c.req.param('id'))
      return { id: initial.id, operation: parsed.data } satisfies UpgradePluginCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt: UpgradePluginCatalogReceipt) => c.json(receipt),
    mapError: (error) => {
      throw wrapInstallErrors(error)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.getAcl,
    method: 'GET',
    path: '/api/plugins/:id/acl',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })

  registerOperationRoute(app, {
    descriptor: operations.updateAcl,
    method: 'PUT',
    path: '/api/plugins/:id/acl',
    tokenAccess: 'never',
    decode: async (c) => ({
      id: c.req.param('id'),
      submission: {
        kind: 'json-body',
        body: JSON.stringify(await safeJsonOrEmpty(c.req.raw)) ?? '{}',
      },
    }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
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
