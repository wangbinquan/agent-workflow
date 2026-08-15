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
  createCodeWorkItemProjectionQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createEnableCommand } from '@/modules/code-capability/application/enableCommand'
import { resolveCodeHostEndpointId } from '@/modules/code-capability/composition/mrReviewEnvironment'
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
      const endpoint = await resolveCodeHostEndpointId(deps.db, 'gitlab')
      if (!endpoint.ok) {
        // Not a 500: the platform is working, this deployment simply has no
        // endpoint yet, and the message says which one to configure.
        throw new ValidationError('code-endpoint-unresolved', endpoint.message)
      }

      const command = createEnableCommand({ db: deps.db, endpointId: endpoint.id })
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
}
