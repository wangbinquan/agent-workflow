// RFC-304 T31b — the HTTP face of `/code`.
//
// Three endpoints, which is the whole minimal surface PR-5's page needs: read
// the repository × capability matrix, flip one cell, and watch what the
// platform has been doing.
//
// ## Why `repos:*` rather than a new `code:*` permission
//
// Enabling a capability for a repository IS repository configuration, and the
// permission catalogue is a closed set whose additions ripple through role
// presets, i18n and the guards that check them. A new point would be justified
// when `/code` grows its own resources (frameworks and bindings, which the
// design already scopes to `scripts:author` and group leads); until then,
// inventing one would mean every existing role needs re-granting to keep doing
// what it can already do.
//
// The DEPARTMENT-layer surfaces are deliberately absent here. A framework
// carries scripts that run as the daemon, and the design puts its write
// permission behind `scripts:author` — so it does not get an endpoint in the
// same file as a switch a repository owner may flip.

import type { Hono } from 'hono'
import { z } from 'zod'
import { actorOf } from '@/auth/actor'
import {
  createCodeMatrixQuery,
  createCodeDeliveryChainQuery,
  createCodeRoundAttemptsQuery,
  createCodeWorkItemProjectionQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import { createEnableCommand } from '@/modules/code-capability/application/enableCommand'
import { CODE_CAPABILITIES } from '@/modules/code-capability/domain/stageContract'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import { registerRoute } from '@/routes/registry'
import type { AppDeps } from '@/server'
import { ValidationError } from '@/util/errors'
import { safeJsonOrThrowInvalid } from '@/util/http'

const EnableBodySchema = z.object({
  capability: z.string().min(1),
  enabled: z.boolean(),
  bindingId: z.string().nullable().optional(),
  triggerConfig: z.record(z.unknown()).optional(),
})

export function mountCodeRoutes(app: Hono, deps: AppDeps): void {
  const matrix = createCodeMatrixQuery(deps.db)
  const projection = createCodeWorkItemProjectionQuery(deps.db)
  const attempts = createCodeRoundAttemptsQuery(deps.db)
  const deliveries = createCodeDeliveryChainQuery(deps.db)
  const metrics = createCodeMetricsQuery(deps.db)

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/matrix/:repoId',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Capability matrix for one repository, with readiness and its repairs',
    },
    async (c) => c.json({ rows: await matrix.forRepo(c.req.param('repoId')) }),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/code/matrix/:repoId',
      permissions: ['repos:update'],
      tokenAccess: 'allow',
      summary: 'Enable or disable one capability for a repository',
    },
    async (c) => {
      const parsed = EnableBodySchema.safeParse(await safeJsonOrThrowInvalid(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError(
          'code-enable-invalid',
          parsed.error.issues[0]?.message ?? 'invalid body',
        )
      }

      // The endpoint a repository's events arrive on. Resolved here rather than
      // taken from the request: it is a component of the work item's identity,
      // and letting a caller name it would let two requests key the same
      // repository's cells to different endpoints.
      // Which code host this repository belongs to, and the endpoint its cells
      // are keyed to. Resolved in the module: `no-routes-to-db` forbids a route
      // reaching the schema, and this is identity work rather than parsing.
      //
      // It used to be hardcoded `'gitlab'`, so a GitHub repository could never
      // have a capability enabled — the failure even named a provider the
      // operator had not configured.
      const endpoint = await resolveRepoEndpoint(deps.db, c.req.param('repoId'))
      if (!endpoint.ok) throw new ValidationError('code-endpoint-unresolved', endpoint.message)

      const command = createEnableCommand({
        db: deps.db,
        endpointId: endpoint.endpointId,
        provider: endpoint.provider,
      })
      const result = await command.enable({
        repoId: c.req.param('repoId'),
        capability: parsed.data.capability,
        enabled: parsed.data.enabled,
        actorUserId: actorOf(c).user.id,
        ...(parsed.data.bindingId !== undefined ? { bindingId: parsed.data.bindingId } : {}),
        ...(parsed.data.triggerConfig !== undefined
          ? { triggerConfig: parsed.data.triggerConfig }
          : {}),
      })

      if (!result.ok) {
        // Spelled out rather than interpolated. `code-${result.code}` is
        // ungreppable: nobody can find where `code-unknown-binding` comes from,
        // and the guard that requires every route error code to be named by a
        // test cannot see it either — so it would ship untested by default.
        throw new ValidationError(
          result.code === 'unknown-capability'
            ? 'code-unknown-capability'
            : result.code === 'unknown-binding'
              ? 'code-unknown-binding'
              : 'code-forbidden',
          result.message,
        )
      }
      return c.json({ row: result.row })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/work-items',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Work items with their recent rounds and stages (cursor-paged)',
    },
    async (c) => {
      const limitRaw = c.req.query('limit')
      const limit = limitRaw === undefined ? undefined : Number(limitRaw)
      if (limit !== undefined && !Number.isFinite(limit)) {
        throw new ValidationError('code-limit-invalid', `'${String(limitRaw)}' is not a number`)
      }
      // Read once into locals and narrow by checking, rather than asserting.
      // `as string` on a `string | undefined` is the exact shape RFC-054 W1-7
      // bans in route handlers: it compiles away the one case the handler is
      // supposed to decide about.
      const endpointId = c.req.query('endpointId')
      const projectId = c.req.query('projectId')
      const capability = c.req.query('capability')
      const cursor = c.req.query('cursor')

      return c.json(
        await projection.page({
          ...(endpointId !== undefined ? { codeHostEndpointId: endpointId } : {}),
          ...(projectId !== undefined ? { stableProjectId: projectId } : {}),
          ...(capability !== undefined ? { capability } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      )
    },
  )

  // RFC-304 T61 — the delivery chain, readable at last.
  //
  // The table has been written since T61 and nothing read it: an administrator
  // asking "why did review stop on this repository?" had `readiness = ready`
  // (the config is complete, which is not "anything ran") and a last-trigger
  // time, which does not separate "the webhook was never sent" from "it arrived
  // and routing dropped it" from "it is queued behind a merge-request lease".
  // Those three have different fixes, so the answer was a guess.
  //
  // One endpoint with three filters rather than three endpoints: they are three
  // questions about one table, and an operator moves between them while looking
  // at the same incident.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/deliveries',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Webhook deliveries and what became of them (troubleshooting chain)',
    },
    async (c) => {
      const limitRaw = c.req.query('limit')
      const limit = limitRaw === undefined ? undefined : Number(limitRaw)
      if (limit !== undefined && !Number.isFinite(limit)) {
        throw new ValidationError('code-limit-invalid', `'${String(limitRaw)}' is not a number`)
      }
      const correlationId = c.req.query('correlationId')
      const projectId = c.req.query('projectId')
      const failedOnly = c.req.query('failedOnly') === 'true'

      // Most specific first: a correlation id names ONE incident, and an
      // operator who has it does not want it filtered by anything else.
      if (correlationId !== undefined && correlationId !== '') {
        return c.json({ deliveries: await deliveries.forCorrelation(correlationId) })
      }
      if (failedOnly) {
        return c.json({
          deliveries: await deliveries.failures({
            ...(projectId === undefined ? {} : { stableProjectId: projectId }),
            ...(limit === undefined ? {} : { limit }),
          }),
        })
      }
      if (projectId === undefined || projectId === '') {
        // Refused rather than answered with everything: the unfiltered table is
        // every delivery on the instance, which is not a troubleshooting view.
        throw new ValidationError(
          'code-delivery-filter-required',
          'name a projectId, a correlationId, or ask for failedOnly — the whole table is not an answer',
        )
      }
      return c.json({
        deliveries: await deliveries.forProject({
          stableProjectId: projectId,
          ...(limit === undefined ? {} : { limit }),
        }),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/rounds/:roundId/attempts',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: "One round's AI calls, with each envelope verdict and retry index",
    },
    // Its own endpoint rather than a field on the work-item page: attempts are
    // the widest rows in the model, and most rounds are never expanded. Folding
    // them into the list makes every visit pay for a level almost nobody opens.
    async (c) => c.json({ attempts: await attempts.forRound(c.req.param('roundId')) }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/capabilities',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'The capability catalog:每条能力及其 agent 槽位（供配置界面派生）',
    },
    // Derived from the registry, never a hand-written list. The configuration
    // UI needs to know which capabilities exist and which agent slots each one
    // asks a binding to fill; hard-coding that in the frontend is exactly the
    // drift that left `issue_labeled` rendering as a raw i18n key — a registry
    // grew and its second reader did not.
    async (c) =>
      c.json({
        items: CODE_CAPABILITIES.map((capability) => ({
          capability,
          agentSlots: [
            ...new Set(
              (lookupStageContract(capability)?.stages ?? []).flatMap((stage) =>
                stage.kind === 'ai' ? [stage.agentSlot] : [],
              ),
            ),
          ],
        })),
      }),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code/metrics',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'Adoption buckets and round outcomes per capability, over a window',
    },
    async (c) => {
      const windowRaw = c.req.query('windowMs')
      const windowMs = windowRaw === undefined ? undefined : Number(windowRaw)
      if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs <= 0)) {
        throw new ValidationError(
          'code-window-invalid',
          `'${String(windowRaw)}' is not a positive number of milliseconds`,
        )
      }
      return c.json(await metrics.summary(windowMs === undefined ? {} : { windowMs }))
    },
  )
}
