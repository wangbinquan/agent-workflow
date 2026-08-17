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
import { createBulkEnableCommand } from '@/modules/code-capability/application/bulkEnableCommand'
import { createEnableCommand } from '@/modules/code-capability/application/enableCommand'
import { createLaunchRoundCommand } from '@/modules/code-capability/application/launchRoundCommand'
import { LaunchInputSchema } from '@/modules/code-capability/domain/launchInput'
import {
  CODE_CAPABILITIES,
  parseCodeCapabilityId,
} from '@/modules/code-capability/domain/stageContract'
import { lookupStageContract } from '@/modules/code-capability/domain/capabilityRegistry'
import { projectStageGraph } from '@/modules/code-capability/domain/stageGraph'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import { registerRoute } from '@/routes/registry'
import type { AppDeps } from '@/server'
import { ValidationError } from '@/util/errors'
import { safeJsonOrThrowInvalid } from '@/util/http'

const EnableBodySchema = z.object({
  capability: z.string().min(1),
  enabled: z.boolean(),
  templateId: z.string().nullable().optional(),
  triggerConfig: z.record(z.unknown()).optional(),
})

/**
 * RFC-309 — the launch body.
 *
 * `input` is the discriminated union from the domain, so a payload naming the
 * wrong starting point for its capability is rejected here rather than three
 * stages later with "target could not be resolved".
 */
const LaunchBodySchema = z.object({
  repoId: z.string().min(1),
  templateId: z.string().min(1),
  input: LaunchInputSchema,
})

const BulkBodySchema = z.object({
  // A list, not a selector expression: the design's bulk change is an explicit
  // write to each named cell, and a server-side selector would put the "which
  // repositories did this actually match" question back out of the author's
  // reach — the thing preview exists to answer.
  repoIds: z.array(z.string().min(1)).min(1),
  capability: z.string().min(1),
  enabled: z.boolean(),
  templateId: z.string().nullable().optional(),
  /** Defaults to a preview: the safe direction when a caller forgets the flag. */
  preview: z.boolean().optional(),
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
        ...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
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

      // T66 — how many rounds each item carries. The page asks for more when a
      // person opens ONE work item; the query caps it at the round window
      // either way, so this widens the answer without unbounding it.
      const roundsRaw = c.req.query('rounds')
      const roundLimit = roundsRaw === undefined ? undefined : Number(roundsRaw)
      if (roundLimit !== undefined && !Number.isFinite(roundLimit)) {
        throw new ValidationError('code-rounds-invalid', `'${String(roundsRaw)}' is not a number`)
      }

      return c.json(
        await projection.page({
          ...(endpointId !== undefined ? { codeHostEndpointId: endpointId } : {}),
          ...(projectId !== undefined ? { stableProjectId: projectId } : {}),
          ...(capability !== undefined ? { capability } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
          ...(roundLimit !== undefined ? { roundLimit } : {}),
        }),
      )
    },
  )

  // RFC-304 T63 — the same cell write, applied to many repositories at once.
  //
  // One endpoint with a `preview` flag rather than two: preview and apply take
  // exactly the same input and differ only in whether they write, and two
  // endpoints would let them drift so that the preview describes something the
  // apply does not do.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/matrix/bulk',
      permissions: ['repos:update'],
      tokenAccess: 'allow',
      summary: 'Preview or apply one capability change across many repositories',
    },
    async (c) => {
      const parsed = BulkBodySchema.safeParse(await safeJsonOrThrowInvalid(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError(
          'code-bulk-invalid',
          parsed.error.issues[0]?.message ?? 'invalid body',
        )
      }

      const result = await createBulkEnableCommand(deps.db).run({
        repoIds: parsed.data.repoIds,
        capability: parsed.data.capability,
        enabled: parsed.data.enabled,
        actorUserId: actorOf(c).user.id,
        preview: parsed.data.preview ?? true,
        ...(parsed.data.templateId !== undefined ? { templateId: parsed.data.templateId } : {}),
      })

      if (!result.ok) {
        // Spelled out rather than interpolated, so both codes are greppable and
        // the route-error guard can see them.
        throw new ValidationError(
          result.code === 'unknown-capability' ? 'code-unknown-capability' : 'code-too-many-repos',
          result.message,
        )
      }
      return c.json(result)
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
      path: '/api/code/capabilities/:capability/graph',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: "One capability's stage sequence as a DAG, for rendering the flow",
    },
    // RFC-307. A pure projection of the platform contract: no database, no
    // repository, no round. That is deliberate and is the whole point of the
    // endpoint — the user's complaint was that they could not see what a
    // capability does BEFORE deciding whether to enable it anywhere, and an
    // endpoint that needed a configured repository would answer the wrong
    // question.
    async (c) => {
      const capability = parseCodeCapabilityId(c.req.param('capability'))
      if (capability === undefined) {
        return c.json({ error: 'unknown-capability' }, 404)
      }
      const contract = lookupStageContract(capability)
      if (contract === undefined) {
        // `mr-monitor` is a real capability with no stage sequence — it is the
        // monitor's main loop. 404 would read as "you typed the name wrong",
        // so the absence is stated instead, and the UI says so in words rather
        // than drawing an empty canvas.
        return c.json({ capability, reason: 'no-stage-contract' as const }, 200)
      }
      // Spelled out rather than spread: the projection also carries `version`,
      // and shipping both it and `stageContractVer` would put two names on one
      // number for readers to reconcile.
      const graph = projectStageGraph(contract, lookupStageContract)
      return c.json({
        capability,
        stageContractVer: graph.version,
        nodes: graph.nodes,
        edges: graph.edges,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code/rounds',
      permissions: ['code-rounds:launch'],
      tokenAccess: 'allow',
      summary: 'Start a capability round from a template (RFC-309)',
    },
    // RFC-309 — the entrance RFC-304 promised and did not ship. Until this
    // route existed the only way to start any round was a real webhook
    // delivery, so "use this template" had no answer inside the platform.
    async (c) => {
      const parsed = LaunchBodySchema.safeParse(await safeJsonOrThrowInvalid(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError(
          'code-launch-invalid',
          parsed.error.issues[0]?.message ?? 'invalid body',
        )
      }
      const result = await createLaunchRoundCommand(deps.db).run({
        repoId: parsed.data.repoId,
        templateId: parsed.data.templateId,
        input: parsed.data.input,
        actor: actorOf(c),
      })
      if (!result.ok) {
        // Spelled out rather than interpolated: `code-${result.code}` is
        // ungreppable, and the guard that requires every route error code to be
        // named by a test cannot see it either.
        throw new ValidationError(
          result.code === 'repo-unresolvable'
            ? 'code-launch-repo-unresolvable'
            : result.code === 'template-not-visible'
              ? 'code-launch-template-not-found'
              : result.code === 'template-capability-mismatch'
                ? 'code-launch-capability-mismatch'
                : result.code === 'template-incomplete'
                  ? 'code-launch-template-incomplete'
                  : 'code-launch-agent-not-visible',
          result.message,
        )
      }
      // The receipt (RFC-304 AC-34): a human instruction must come back with
      // something to follow, immediately.
      return c.json(
        { workItemId: result.workItemId, roundId: result.roundId, roundSeq: result.roundSeq },
        201,
      )
    },
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
