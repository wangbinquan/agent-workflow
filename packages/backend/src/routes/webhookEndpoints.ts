// RFC-257 T7 — webhook 端点管理面路由（薄壳）。RFC-284 T28：全部业务判定、
// secret 密封与 db/schema 访问下沉 services/webhookEndpoints.ts（读写分层 /
// D19 / secret 三形态的领域注释也在那里）；本文件只剩 registerRoute 元数据 +
// actor/param/body 抽取，以及「无密封器则不开管理面」的挂载期跳过。
import type { Hono } from 'hono'

import { actorOf } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import {
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  getWebhookEndpoint,
  listWebhookEndpoints,
  rotateWebhookEndpointSecret,
  rotateWebhookEndpointUrlToken,
  updateWebhookEndpoint,
} from '@/services/webhookEndpoints'
import { safeJsonOrThrowInvalid } from '@/util/http'
import type { WebhookEndpointServiceDeps } from '@/services/webhookEndpoints'

export function mountWebhookEndpointRoutes(
  app: Hono,
  deps: { readonly webhookEndpointService: WebhookEndpointServiceDeps },
): void {
  const svcDeps = deps.webhookEndpointService

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-endpoints',
      // RFC-260：读面全员（矩阵点）；URL 明文由服务层按 viewer 分层——PAT
      // 可读掩码后的元数据（tokenAccess allow），明文只走持有管理权限的 session。
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'List webhook ingress endpoints (RFC-257/260)',
    },
    async (c) => c.json(await listWebhookEndpoints(svcDeps, actorOf(c))),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-endpoints',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Create a webhook ingress endpoint (returns the secret ONCE)',
    },
    async (c) =>
      c.json(
        await createWebhookEndpoint(svcDeps, actorOf(c), await safeJsonOrThrowInvalid(c.req.raw)),
        201,
      ),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/webhook-endpoints/:id',
      permissions: ['webhook-endpoints:read'],
      tokenAccess: 'allow',
      summary: 'Get one webhook ingress endpoint',
    },
    async (c) => c.json(await getWebhookEndpoint(svcDeps, actorOf(c), c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/webhook-endpoints/:id',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Update endpoint name/enabled/clone protocol (provider immutable)',
    },
    async (c) =>
      c.json(
        await updateWebhookEndpoint(
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
      path: '/api/webhook-endpoints/:id',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Delete an endpoint (restricted while triggers reference it)',
    },
    async (c) => {
      await deleteWebhookEndpoint(svcDeps, c.req.param('id'))
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-endpoints/:id/rotate-secret',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Rotate the verification secret (returns the new secret ONCE)',
    },
    async (c) => c.json(await rotateWebhookEndpointSecret(svcDeps, actorOf(c), c.req.param('id'))),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/webhook-endpoints/:id/rotate-url-token',
      permissions: ['webhook-endpoints:manage'],
      tokenAccess: 'never',
      summary: 'Rotate the URL token (GitLab must be re-pointed at the new URL)',
    },
    async (c) =>
      c.json(await rotateWebhookEndpointUrlToken(svcDeps, actorOf(c), c.req.param('id'))),
  )
}
