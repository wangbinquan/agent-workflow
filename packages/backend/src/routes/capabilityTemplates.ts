// RFC-304 T57 — the HTTP face of the two capability template layers.
//
// `routes/code.ts` said the department surfaces were "deliberately absent here"
// because a framework carries scripts that run as the daemon, and predicted
// that a permission point "would be justified when /code grows its own
// resources". This is that moment, and the two layers get separate points for
// the reason the split exists: granting one must never grant the other.
//
// ## The rejection that has to happen HERE
//
// A binding payload naming `scripts` or `hooks` is refused with a message that
// names the layer. Zod's `.strict()` would also refuse it, but with
// "unrecognized key" — which tells an author their JSON is malformed when in
// fact their JSON is fine and their MENTAL MODEL is wrong. `domain/
// templateLayers.ts` has carried that message since PR-2 with no caller.

import type { Hono } from 'hono'
import {
  CapabilityBindingWriteSchema,
  CapabilityFrameworkWriteSchema,
  CapabilityTemplateCopySchema,
} from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { rejectFrameworkOnlyFields } from '@/modules/code-capability/domain/templateLayers'
import { registerRoute } from '@/routes/registry'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import {
  assertMayWriteFramework,
  copyBinding,
  copyFramework,
  createBinding,
  createFramework,
  deleteBinding,
  deleteFramework,
  getBindingRow,
  getFrameworkRow,
  listBindingRows,
  listFrameworkRows,
  serializeBinding,
  serializeFramework,
  updateBinding,
  updateFramework,
} from '@/services/capabilityTemplates'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import type { AppDeps } from '@/server'
import { NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export function mountCapabilityTemplateRoutes(app: Hono, deps: AppDeps): void {
  // ---- frameworks (department layer) -------------------------------------

  async function loadVisibleFramework(actor: Actor, id: string) {
    const row = await getFrameworkRow(deps.db, id)
    if (row === null || !(await canViewResource(deps.db, actor, 'capability_framework', row))) {
      // 404, not 403: an invisible resource must be indistinguishable from a
      // missing one, or the status code becomes an existence oracle.
      throw new NotFoundError('capability-framework-not-found', `framework '${id}' not found`)
    }
    return row
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-frameworks',
      permissions: ['capability-frameworks:read'],
      tokenAccess: 'allow',
      summary: 'List capability frameworks visible to the caller (scripts redacted)',
    },
    async (c) => {
      const actor = actorOf(c)
      const visible = await filterVisibleRows(
        deps.db,
        actor,
        'capability_framework',
        await listFrameworkRows(deps.db),
      )
      return c.json(visible.map((row) => serializeFramework(row, actor)))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-frameworks/:id',
      permissions: ['capability-frameworks:read'],
      tokenAccess: 'allow',
      summary: 'Get one capability framework (scripts redacted without scripts:author)',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(serializeFramework(await loadVisibleFramework(actor, c.req.param('id')), actor))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-frameworks',
      permissions: ['capability-frameworks:create'],
      // System-domain: a framework's scripts run as the daemon, so no token
      // carries this however its owner is granted.
      tokenAccess: 'never',
      summary: 'Create a capability framework',
    },
    async (c) => {
      const parsed = CapabilityFrameworkWriteSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('capability-framework-invalid', 'invalid framework payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const row = await createFramework(deps.db, parsed.data, actor)
      return c.json(serializeFramework(row, actor), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/capability-frameworks/:id',
      permissions: ['capability-frameworks:update'],
      tokenAccess: 'never',
      summary: 'Replace a capability framework',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisibleFramework(actor, c.req.param('id'))
      await requireResourceOwner(deps.db, actor, 'capability_framework', existing)
      // BOTH factors. The ACL check above is the resource half; this is the
      // `scripts:author` half, and either alone is a way around the other.
      assertMayWriteFramework(actor, true)

      const parsed = CapabilityFrameworkWriteSchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('capability-framework-invalid', 'invalid framework payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(
        serializeFramework(await updateFramework(deps.db, existing, parsed.data, actor), actor),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-frameworks/:id/copy',
      permissions: ['capability-frameworks:create'],
      tokenAccess: 'never',
      summary: 'Copy a capability framework into a private draft of your own',
    },
    async (c) => {
      const actor = actorOf(c)
      const source = await loadVisibleFramework(actor, c.req.param('id'))
      const parsed = CapabilityTemplateCopySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('capability-template-invalid', 'invalid copy payload', {
          issues: parsed.error.issues,
        })
      }
      const row = await copyFramework(deps.db, source, actor, parsed.data.name)
      return c.json(serializeFramework(row, actor), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/capability-frameworks/:id',
      permissions: ['capability-frameworks:delete'],
      tokenAccess: 'never',
      summary: 'Delete a capability framework',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisibleFramework(actor, c.req.param('id'))
      await requireResourceOwner(deps.db, actor, 'capability_framework', existing)
      assertMayWriteFramework(actor, true)
      await deleteFramework(deps.db, existing)
      return c.body(null, 204)
    },
  )

  mountAclEndpoints(app, deps, {
    type: 'capability_framework',
    base: '/api/capability-frameworks',
    param: 'id',
    load: async (db, key) => await getFrameworkRow(db, key),
  })

  // ---- bindings (group layer) --------------------------------------------

  async function loadVisibleBinding(actor: Actor, id: string) {
    const row = await getBindingRow(deps.db, id)
    if (row === null || !(await canViewResource(deps.db, actor, 'capability_binding', row))) {
      throw new NotFoundError('capability-binding-not-found', `binding '${id}' not found`)
    }
    return row
  }

  /**
   * Refuse a department-layer field before anything else looks at the payload.
   *
   * Ordered ahead of schema parsing on purpose: `.strict()` would reject the
   * same request with "unrecognized key", which tells an author their JSON is
   * malformed. It is not — their model of the two layers is, and that is what
   * the message has to say.
   */
  function assertGroupLayerOnly(raw: unknown): void {
    const rejections = rejectFrameworkOnlyFields(raw)
    const first = rejections[0]
    if (first !== undefined) {
      throw new ValidationError(first.code, first.message, {
        fields: rejections.map((r) => r.field),
      })
    }
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-bindings',
      permissions: ['capability-bindings:read'],
      tokenAccess: 'allow',
      summary: 'List capability bindings visible to the caller',
    },
    async (c) => {
      const visible = await filterVisibleRows(
        deps.db,
        actorOf(c),
        'capability_binding',
        await listBindingRows(deps.db),
      )
      return c.json(visible.map(serializeBinding))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-bindings/:id',
      permissions: ['capability-bindings:read'],
      tokenAccess: 'allow',
      summary: 'Get one capability binding',
    },
    async (c) => c.json(serializeBinding(await loadVisibleBinding(actorOf(c), c.req.param('id')))),
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-bindings',
      permissions: ['capability-bindings:create'],
      tokenAccess: 'allow',
      summary: 'Create a capability binding',
    },
    async (c) => {
      const raw = await safeJsonOrEmpty(c.req.raw)
      assertGroupLayerOnly(raw)
      const parsed = CapabilityBindingWriteSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('capability-binding-invalid', 'invalid binding payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(serializeBinding(await createBinding(deps.db, parsed.data, actorOf(c))), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/capability-bindings/:id',
      permissions: ['capability-bindings:update'],
      tokenAccess: 'allow',
      summary: 'Replace a capability binding',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisibleBinding(actor, c.req.param('id'))
      await requireResourceOwner(deps.db, actor, 'capability_binding', existing)

      const raw = await safeJsonOrEmpty(c.req.raw)
      assertGroupLayerOnly(raw)
      const parsed = CapabilityBindingWriteSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('capability-binding-invalid', 'invalid binding payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(serializeBinding(await updateBinding(deps.db, existing, parsed.data)))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-bindings/:id/copy',
      permissions: ['capability-bindings:create'],
      tokenAccess: 'allow',
      summary: 'Copy a capability binding into a private draft of your own',
    },
    async (c) => {
      const actor = actorOf(c)
      const source = await loadVisibleBinding(actor, c.req.param('id'))
      const parsed = CapabilityTemplateCopySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('capability-template-invalid', 'invalid copy payload', {
          issues: parsed.error.issues,
        })
      }
      return c.json(
        serializeBinding(await copyBinding(deps.db, source, actor, parsed.data.name)),
        201,
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/capability-bindings/:id',
      permissions: ['capability-bindings:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a capability binding',
    },
    async (c) => {
      const actor = actorOf(c)
      const existing = await loadVisibleBinding(actor, c.req.param('id'))
      await requireResourceOwner(deps.db, actor, 'capability_binding', existing)
      await deleteBinding(deps.db, existing)
      return c.body(null, 204)
    },
  )

  mountAclEndpoints(app, deps, {
    type: 'capability_binding',
    base: '/api/capability-bindings',
    param: 'id',
    load: async (db, key) => await getBindingRow(db, key),
  })
}
