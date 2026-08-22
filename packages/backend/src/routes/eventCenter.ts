import type { Hono } from 'hono'
import { z } from 'zod'

import { actorOf } from '@/auth/actor'
import type { EventCenterModule } from '@/modules/event-center/composition'
import { registerRoute } from '@/routes/registry'
import { ForbiddenError } from '@/util/errors'
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
    kind: z.enum(['employee-case', 'employee-invocation', 'automation', 'system']),
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
    routingFacts: z.record(z.string(), z.unknown()).nullable().optional(),
    triggerParameters: z.record(z.string(), z.string()).nullable().optional(),
  })
  .strict()

function pageNumber(value: string | undefined, fallback: number, maximum?: number): number {
  const parsed = Math.trunc(Number(value))
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback
  return maximum === undefined ? parsed : Math.min(maximum, parsed)
}

function optionalQuery(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

export function mountEventCenterRoutes(app: Hono, module: EventCenterModule): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/catalog',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List localized event types and observation sources',
    },
    () => jsonDocumentResponse(module.queries.catalog.catalogJson()),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/deliveries',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List independent per-subscription event delivery state',
    },
    (c) => c.json({ items: module.queries.operations.deliveryStatuses() }),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/deliveries/page',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List one bounded page of independent event deliveries',
    },
    (c) => {
      const state = z
        .enum(['pending', 'claimed', 'accepted', 'dead-letter'])
        .nullable()
        .catch(null)
        .parse(c.req.query('state'))
      return c.json(
        module.queries.operations.deliveryStatusPage({
          page: pageNumber(c.req.query('page'), 1),
          limit: pageNumber(c.req.query('limit'), 50, 200),
          state,
          subscriberRef: optionalQuery(c.req.query('subscriberRef')),
        }),
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/events/page',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List one bounded page of immutable source events',
    },
    (c) =>
      c.json(
        module.queries.operations.eventRecordPage({
          page: pageNumber(c.req.query('page'), 1),
          limit: pageNumber(c.req.query('limit'), 50, 200),
          sourceId: optionalQuery(c.req.query('sourceId')),
        }),
      ),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/subscriptions',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List durable event subscriptions',
    },
    (c) =>
      jsonDocumentResponse(
        module.queries.catalog.subscriptionsJson(c.req.query('subscriberRef') ?? null),
      ),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/subscriptions/page',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List one bounded page of durable event subscriptions',
    },
    (c) =>
      jsonDocumentResponse(
        module.queries.catalog.subscriptionPageJson({
          page: pageNumber(c.req.query('page'), 1),
          limit: pageNumber(c.req.query('limit'), 50, 200),
          subscriberRef: optionalQuery(c.req.query('subscriberRef')),
        }),
      ),
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/observers',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'Read on-demand observer activation health',
    },
    (c) => c.json({ items: module.queries.operations.observerHealth() }),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/subscriptions',
      permissions: ['event-sources:update'],
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
      permissions: ['event-sources:update'],
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
      permissions: ['event-sources:update'],
      tokenAccess: 'allow',
      summary: 'Ingest one idempotent event observation',
    },
    async (c) => {
      const body = observationBodySchema.parse(await safeJsonOrEmpty(c.req.raw))
      const { routingFacts, ...observation } = body
      return c.json(
        module.commands.observe({
          ...observation,
          ...(routingFacts === undefined
            ? {}
            : { routingFactsJson: routingFacts === null ? null : JSON.stringify(routingFacts) }),
        }),
        201,
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/response-rules',
      permissions: ['event-automation-rules:read'],
      tokenAccess: 'never',
      summary: 'List source-neutral event response rules',
    },
    (c) => c.json({ items: module.responseRules.queries.list() }),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/response-rules',
      permissions: ['event-automation-rules:create', 'tasks:execute'],
      tokenAccess: 'never',
      summary: 'Create a source-neutral event response rule',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        module.responseRules.commands.create(await safeJsonOrEmpty(c.req.raw), {
          userId: actor.user.id,
          canOverrideOwner: actor.permissions.has('event-automation-rules:override-owner'),
          canLaunchDigitalEmployee: actor.permissions.has('development-missions:launch'),
        }),
        201,
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/event-center/response-rules/:id',
      permissions: ['event-automation-rules:update'],
      tokenAccess: 'never',
      summary: 'Update a source-neutral event response rule',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        module.responseRules.commands.update(c.req.param('id'), await safeJsonOrEmpty(c.req.raw), {
          userId: actor.user.id,
          canOverrideOwner: actor.permissions.has('event-automation-rules:override-owner'),
          canLaunchDigitalEmployee: actor.permissions.has('development-missions:launch'),
        }),
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/event-center/response-rules/:id',
      permissions: ['event-automation-rules:delete'],
      tokenAccess: 'never',
      summary: 'Delete a source-neutral event response rule',
    },
    (c) => {
      const actor = actorOf(c)
      module.responseRules.commands.remove(c.req.param('id'), {
        userId: actor.user.id,
        canOverrideOwner: actor.permissions.has('event-automation-rules:override-owner'),
        canLaunchDigitalEmployee: actor.permissions.has('development-missions:launch'),
      })
      return c.json({ ok: true })
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/observers/run-due',
      permissions: ['event-sources:update'],
      tokenAccess: 'never',
      summary: 'Run one due short observer cycle',
    },
    async (c) => c.json({ state: await module.worker.runOneDueObserver() }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/sources',
      permissions: ['event-sources:read'],
      tokenAccess: 'allow',
      summary: 'List global custom event source definitions',
    },
    (c) => c.json({ items: module.customSources.queries.list() }),
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/sources',
      permissions: ['event-sources:create'],
      tokenAccess: 'never',
      summary: 'Create one custom polling event source draft',
    },
    async (c) => {
      const actor = actorOf(c)
      if (!actor.permissions.has('scripts:author')) {
        throw new ForbiddenError(
          'scripts-author-required',
          'authoring an event observer program requires scripts:author',
        )
      }
      return c.json(
        module.customSources.commands.create(await safeJsonOrEmpty(c.req.raw), actor.user.id),
        201,
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/event-center/sources/:id',
      permissions: ['event-sources:update'],
      tokenAccess: 'never',
      summary: 'Read one editable custom event source draft and its program',
    },
    (c) => {
      const actor = actorOf(c)
      if (!actor.permissions.has('scripts:author')) {
        throw new ForbiddenError(
          'scripts-author-required',
          'reading an event observer program requires scripts:author',
        )
      }
      return c.json(module.customSources.queries.get(c.req.param('id')))
    },
  )
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/event-center/sources/:id',
      permissions: ['event-sources:update'],
      tokenAccess: 'never',
      summary: 'Update one stable custom event source draft',
    },
    async (c) => {
      const actor = actorOf(c)
      if (!actor.permissions.has('scripts:author')) {
        throw new ForbiddenError(
          'scripts-author-required',
          'authoring an event observer program requires scripts:author',
        )
      }
      return c.json(
        module.customSources.commands.update(c.req.param('id'), await safeJsonOrEmpty(c.req.raw)),
      )
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/sources/:id/validate',
      permissions: ['event-sources:update'],
      tokenAccess: 'never',
      summary: 'Execute the real fixture for one custom event source draft',
    },
    async (c) => {
      const actor = actorOf(c)
      if (!actor.permissions.has('scripts:author')) {
        throw new ForbiddenError(
          'scripts-author-required',
          'executing an event observer fixture requires scripts:author',
        )
      }
      return c.json(await module.customSources.commands.validate(c.req.param('id')))
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/sources/:id/publish',
      permissions: ['event-sources:update'],
      tokenAccess: 'never',
      summary: 'Validate and publish one immutable custom event source revision',
    },
    async (c) => {
      const actor = actorOf(c)
      if (!actor.permissions.has('scripts:author')) {
        throw new ForbiddenError(
          'scripts-author-required',
          'publishing an event observer program requires scripts:author',
        )
      }
      return c.json(await module.customSources.commands.publish(c.req.param('id'), actor.user.id))
    },
  )
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/event-center/sources/:id/retire',
      permissions: ['event-sources:archive'],
      tokenAccess: 'never',
      summary: 'Retire a custom event source without deleting exact history',
    },
    (c) => {
      module.customSources.commands.retire(c.req.param('id'))
      return c.json({ ok: true })
    },
  )
}
