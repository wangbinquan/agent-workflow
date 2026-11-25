// Workgroup HTTP routes (RFC-164 PR-1).
// GET    /api/workgroups                — list (ACL-filtered)
// GET    /api/workgroups/:id            — one (invisible → 404, D1)
// POST   /api/workgroups                — create (creator becomes owner)
// POST   /api/workgroups/:id/copy       — exact-revision private copy
// PUT    /api/workgroups/:id            — RFC-225 version-fenced full document save
// DELETE /api/workgroups/:id            — RFC-225 version-fenced delete
// POST   /api/workgroups/:id/rename     — fenced compatibility adapter
// GET/PUT /api/workgroups/:id/acl       — RFC-099 ACL management
//
// RFC-099 D15 / RFC-223: creating/updating checks that NEW agent-member ids are
// usable by the editor, enforced inside the workgroup write participant against the
// exact ids persisted.

import {
  CopyWorkgroupRequestSchema,
  CreateWorkgroupSchema,
  RenameWorkgroupSchema,
  UpdateWorkgroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { WorkgroupOperationDescriptors } from '../../application/workgroups/operationContracts'
import type { WorkgroupOperationContext } from '@/modules/resource-catalog/public/participants'
import type { WorkgroupQueries } from '@/modules/resource-catalog/public/queries'
import type { AgentResourceIntegrityQueries } from '../../application/agents/queryContracts'
import type { WorkgroupCatalogDetail } from '@/modules/resource-catalog/public/types'
import type {
  CopyWorkgroupCatalogInput,
  CreateWorkgroupCatalogInput,
  DeleteWorkgroupCatalogInput,
  DeleteWorkgroupCatalogReceipt,
  RenameWorkgroupCatalogInput,
  UpdateWorkgroupCatalogInput,
  UpdateWorkgroupCatalogReceipt,
} from '../../application/workgroups/operationContracts'
import { registerRoute } from '@/routes/registry'
import { registerOperationRoute } from '@/routes/operationRoute'
import { captureDeleteSnapshot } from '@/platform/http/deleteSnapshot'
import { NotFoundError, ValidationError } from '@/platform/errors/domainErrors'
import { safeJsonOrEmpty } from '@/platform/http/requestParsing'

export interface WorkgroupRouteDependencies {
  readonly queries: WorkgroupQueries
  readonly operations: WorkgroupOperationDescriptors
  readonly resourceIntegrityQueries: AgentResourceIntegrityQueries
  readonly authorityFor: (actor: Actor) => WorkgroupOperationContext
  // RFC-589: the workgroup launch (`POST /api/workgroups/:id/tasks`) is task-execution's binding
  // (`mountWorkgroupTaskLaunchRoutes`), mounted right after this one in the same step.
}

export function mountWorkgroupRoutes(app: Hono, module: WorkgroupRouteDependencies): void {
  const { queries, operations } = module

  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkgroup(actor: Actor, id: string): Promise<WorkgroupCatalogDetail> {
    const group = await queries.get(module.authorityFor(actor), { id })
    if (group === null) {
      throw new NotFoundError('workgroup-not-found', 'workgroup not found')
    }
    return group
  }

  registerOperationRoute(app, {
    descriptor: operations.list,
    method: 'GET',
    path: '/api/workgroups',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, list) => c.json(list),
  })

  registerOperationRoute(app, {
    descriptor: operations.get,
    method: 'GET',
    path: '/api/workgroups/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, group) => {
      if (group === null) throw new NotFoundError('workgroup-not-found', 'workgroup not found')
      return c.json(group)
    },
  })

  // RFC-228: advisory status for the editor/wizard. The POST launch service
  // always recomputes this; this endpoint only prevents a known-bad click and
  // deliberately omits referenced ids/names from implicit ACL closures.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/workgroups/:id/resource-status',
      permissions: ['workgroups:read'],
      tokenAccess: 'allow',
      summary: 'Advisory referenced-resource status for a workgroup',
    },
    async (c) => {
      const group = await loadVisibleWorkgroup(actorOf(c), c.req.param('id'))
      const memberAgentIds = group.members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      )
      const result = await module.resourceIntegrityQueries.closureStatus(
        module.authorityFor(actorOf(c)),
        { rootAgentIds: memberAgentIds },
      )
      return c.json(result)
    },
  )

  registerOperationRoute(app, {
    descriptor: operations.create,
    method: 'POST',
    path: '/api/workgroups',
    tokenAccess: 'allow',
    decode: async (c) => {
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = CreateWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
          issues: parsed.error.issues,
        })
      }
      return parsed.data satisfies CreateWorkgroupCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, created) => c.json(created, 201),
  })

  registerOperationRoute(app, {
    descriptor: operations.copy,
    method: 'POST',
    path: '/api/workgroups/:id/copy',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = CopyWorkgroupRequestSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('workgroup-copy-invalid', 'invalid workgroup copy payload', {
          issues: parsed.error.issues,
        })
      }
      return { id: c.req.param('id'), copy: parsed.data } satisfies CopyWorkgroupCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, copied) => c.json(copied, 201),
  })

  registerOperationRoute(app, {
    descriptor: operations.update,
    method: 'PUT',
    path: '/api/workgroups/:id',
    tokenAccess: 'allow',
    decode: async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = UpdateWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
          issues: parsed.error.issues,
        })
      }
      return { id, update: parsed.data } satisfies UpdateWorkgroupCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, updated: UpdateWorkgroupCatalogReceipt) => c.json(updated),
  })

  registerOperationRoute(app, {
    descriptor: operations.delete,
    method: 'DELETE',
    path: '/api/workgroups/:id',
    tokenAccess: 'allow',
    decode: async (c) =>
      ({
        id: c.req.param('id'),
        deletion: {
          kind: 'json-body',
          body: await c.req.raw.text().catch(() => ''),
        },
      }) satisfies DeleteWorkgroupCatalogInput,
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, receipt: DeleteWorkgroupCatalogReceipt) => {
      captureDeleteSnapshot(c, actorOf(c), receipt.deleted)
      return c.body(null, 204)
    },
  })

  registerOperationRoute(app, {
    descriptor: operations.rename,
    method: 'POST',
    path: '/api/workgroups/:id/rename',
    tokenAccess: 'allow',
    decode: async (c) => {
      const id = c.req.param('id')
      const body = await safeJsonOrEmpty(c.req.raw)
      const parsed = RenameWorkgroupSchema.safeParse(body)
      if (!parsed.success) {
        throw new ValidationError('workgroup-rename-invalid', 'invalid rename payload', {
          issues: parsed.error.issues,
        })
      }
      return { id, rename: parsed.data } satisfies RenameWorkgroupCatalogInput
    },
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, renamed) => c.json(renamed),
  })

  // RFC-099 / RFC-223 — GET/PUT /api/workgroups/:id/acl
  registerOperationRoute(app, {
    descriptor: operations.getAcl,
    method: 'GET',
    path: '/api/workgroups/:id/acl',
    tokenAccess: 'allow',
    decode: (c) => ({ id: c.req.param('id') }),
    context: (c) => module.authorityFor(actorOf(c)),
    encode: (c, acl) => c.json(acl),
  })

  registerOperationRoute(app, {
    descriptor: operations.updateAcl,
    method: 'PUT',
    path: '/api/workgroups/:id/acl',
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
