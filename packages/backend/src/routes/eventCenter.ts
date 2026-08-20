import type { Hono } from 'hono'
import { z } from 'zod'

import type { EventCenterModule } from '@/modules/event-center/composition'
import { registerRoute } from '@/routes/registry'
import { safeJsonOrEmpty } from '@/util/http'
import { jsonDocumentResponse } from '@/util/jsonDocument'

const exactRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()
const subjectSchema = z
  .object({ typeId: z.string().min(1), subjectRef: z.string().min(1) })
  .strict()
const subscriberSchema = z
  .object({
    kind: z.enum(['employee-case', 'employee-invocation', 'system']),
    subscriberRef: z.string().min(1),
  })
  .strict()
const subscriptionBodySchema = z
  .object({ eventTypeRef: exactRefSchema, subject: subjectSchema, subscriber: subscriberSchema })
  .strict()
const observationBodySchema = z
  .object({
    sourceRef: exactRefSchema,
    eventTypeRef: exactRefSchema,
    subject: subjectSchema,
    occurredAt: z.number().int().nonnegative(),
    dedupeKey: z.string().min(1),
    summary: z.string().min(1),
    payloadArtifactRef: z.string().min(1).nullable(),
  })
  .strict()

export function mountEventCenterRoutes(app: Hono, module: EventCenterModule): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/catalog',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List localized event types and observation sources',
    },
    () => jsonDocumentResponse(module.queries.catalogJson()),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/subscriptions',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'List durable event subscriptions',
    },
    (c) =>
      jsonDocumentResponse(module.queries.subscriptionsJson(c.req.query('subscriberRef') ?? null)),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/observers',
      permissions: ['digital-employees:read'],
      tokenAccess: 'allow',
      summary: 'Read on-demand observer activation health',
    },
    (c) => c.json({ items: module.queries.observerHealth() }),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/subscriptions',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Create one exact event subscription',
    },
    async (c) =>
      c.json(
        module.participant.subscribe(
          subscriptionBodySchema.parse(await safeJsonOrEmpty(c.req.raw)),
        ),
        201,
      ),
  )
  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/event-center/subscriptions/:id',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Cancel a durable event subscription',
    },
    (c) => c.json(module.participant.unsubscribe(c.req.param('id'))),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/observations',
      permissions: ['digital-employees:update'],
      tokenAccess: 'allow',
      summary: 'Ingest one idempotent event observation',
    },
    async (c) =>
      c.json(
        module.commands.observe(observationBodySchema.parse(await safeJsonOrEmpty(c.req.raw))),
        201,
      ),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/observers/run-due',
      permissions: ['digital-employees:update'],
      tokenAccess: 'never',
      summary: 'Run one due short observer cycle',
    },
    async (c) => c.json({ state: await module.worker.runOneDueObserver() }),
  )
}
