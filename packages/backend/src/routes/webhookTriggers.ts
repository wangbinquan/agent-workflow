// RFC-257 T8/T9 — 触发器管理面路由（薄壳）。RFC-284 T28：全部业务判定与
// db/schema 访问下沉 services/webhookTriggers.ts（权限语义/owner 制/保存期校验
// 的领域注释也在那里）；本文件只剩 registerRoute 元数据 + actor/param/query/body
// 抽取。方法级权限门在 registerRoute，行级
// owner∨`webhook-triggers:override-owner` 门在服务层。
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import {
  createWebhookTrigger,
  deleteWebhookTrigger,
  getWebhookTrigger,
  listWebhookTriggerFires,
  listWebhookTriggers,
  resetWebhookTriggerStream,
  updateWebhookTrigger,
} from '@/services/webhookTriggers'
import { safeJsonOrThrowInvalid } from '@/util/http'

export function mountWebhookTriggerRoutes(app: Hono, deps: AppDeps): void {
  const svcDeps = { db: deps.db, configPath: deps.configPath }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-triggers',
      permissions: ['webhook-triggers:read'],
      tokenAccess: 'allow',
      summary: 'List webhook triggers visible to the caller',
    },
    async (c) => c.json(await listWebhookTriggers(svcDeps)),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-triggers',
      permissions: ['webhook-triggers:create', 'tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Create a webhook trigger (arms event-driven launches)',
    },
    async (c) =>
      c.json(
        await createWebhookTrigger(svcDeps, actorOf(c), await safeJsonOrThrowInvalid(c.req.raw)),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-triggers/:id',
      permissions: ['webhook-triggers:read'],
      tokenAccess: 'allow',
      summary: 'Get one webhook trigger',
    },
    async (c) => c.json(await getWebhookTrigger(svcDeps, c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/webhook-triggers/:id',
      permissions: ['webhook-triggers:update'],
      tokenAccess: 'allow',
      summary: 'Update a webhook trigger (kind/endpoint immutable)',
    },
    async (c) =>
      c.json(
        await updateWebhookTrigger(
          svcDeps,
          actorOf(c),
          c.req.param('id'),
          await safeJsonOrThrowInvalid(c.req.raw),
        ),
      ),
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/webhook-triggers/:id',
      permissions: ['webhook-triggers:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a webhook trigger (fires/streams cascade)',
    },
    async (c) => {
      await deleteWebhookTrigger(svcDeps, actorOf(c), c.req.param('id'))
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-triggers/:id/fires',
      permissions: ['webhook-triggers:read'],
      tokenAccess: 'allow',
      summary: 'Fire history of one trigger (owner-facing troubleshooting)',
    },
    async (c) => {
      const limit = Math.min(200, Number(c.req.query('limit') ?? 50) || 50)
      return c.json(await listWebhookTriggerFires(svcDeps, c.req.param('id'), limit))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-triggers/:id/streams/reset',
      permissions: ['webhook-triggers:update'],
      tokenAccess: 'allow',
      summary: 'Reset the circuit counter of one stream (D22 manual reset)',
    },
    async (c) => {
      await resetWebhookTriggerStream(
        svcDeps,
        actorOf(c),
        c.req.param('id'),
        await safeJsonOrThrowInvalid(c.req.raw),
      )
      return c.json({ ok: true })
    },
  )
}
