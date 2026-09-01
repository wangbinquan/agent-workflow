// RFC-309 T7/T8 — the HTTP face of the capability template. One resource.
//
// RFC-304 mounted two: `/api/capability-frameworks` (department: scripts and
// hooks, system-domain writes) and `/api/capability-bindings` (group: agents,
// prompts, params). Neither half was usable alone, so a person configuring a
// capability had to understand a split that existed for a permission reason
// they never saw.
//
// ## What moved, and what did not
//
// The permission reason is real and survives: scripts run as the daemon. What
// changed is where it is checked. The ROUTE is now an ordinary
// `capability-templates:*` surface that a token may carry; the FIELDS `scripts`
// and `hooks` are gated by `assertTemplateFieldsAllowed`, which needs
// `scripts:author` — still system-domain, so a token still cannot author a
// script no matter how its owner is granted.
//
// ## The redaction round-trip, which is easy to get wrong
//
// A reader without `scripts:author` receives the template with `scripts` and
// `hooks` ABSENT (`scriptsRedacted: true`). If they edit the name and PUT it
// back, a naive handler would read "no scripts" and wipe them. So the handler
// re-fills both fields from the stored row before validating whenever the
// caller cannot see them. The alternative — refusing the save — would make a
// template uneditable by exactly the people the merge exists to serve.

import type { Hono } from 'hono'
import { type ResourceAcl, type UpdateResourceAclBody } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import type { CapabilityTemplateOperations } from '@/modules/code-capability/application/capabilityTemplateOperations'
import { registerRoute } from '@/routes/registry'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import type { TemplateUpstreamOperations } from '@/modules/code-capability/application/templateUpstreamStatus'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export interface CapabilityTemplateRouteDeps {
  readonly codeHistoryQueries: {
    readonly templateUpstream: TemplateUpstreamOperations
  }
  readonly capabilityTemplates: CapabilityTemplateOperations
  readonly capabilityTemplateAcl: {
    readonly load: (key: string) => Promise<{
      readonly id: string
      readonly ownerUserId: string | null
      readonly visibility: 'private' | 'public'
    } | null>
    readonly canView: (
      actor: Actor,
      row: {
        readonly id: string
        readonly ownerUserId: string | null
        readonly visibility: 'private' | 'public'
      },
    ) => Promise<boolean>
    readonly read: (
      actor: Actor,
      row: {
        readonly id: string
        readonly ownerUserId: string | null
        readonly visibility: 'private' | 'public'
      },
    ) => Promise<ResourceAcl>
    readonly update: (
      actor: Actor,
      row: {
        readonly id: string
        readonly ownerUserId: string | null
        readonly visibility: 'private' | 'public'
      },
      body: UpdateResourceAclBody,
      updatedAt?: number,
    ) => Promise<ResourceAcl>
  }
}

export function mountCapabilityTemplateRoutes(app: Hono, deps: CapabilityTemplateRouteDeps): void {
  const templateUpstream = deps.codeHistoryQueries.templateUpstream
  const templates = deps.capabilityTemplates
  const acl = deps.capabilityTemplateAcl

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-templates',
      permissions: ['capability-templates:read'],
      tokenAccess: 'allow',
      summary: 'List capability templates visible to the caller (scripts redacted)',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await templates.list(actor))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-templates/:id',
      permissions: ['capability-templates:read'],
      tokenAccess: 'allow',
      summary: 'Get one capability template (scripts redacted without scripts:author)',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await templates.get(actor, c.req.param('id')))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-templates',
      permissions: ['capability-templates:create'],
      // Ordinary matrix point after RFC-309: creating a template is not the
      // same act as authoring a script, and the script fields carry their own
      // system-domain gate.
      tokenAccess: 'allow',
      summary: 'Create a capability template',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await templates.create(actor, await safeJsonOrEmpty(c.req.raw)), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/capability-templates/:id',
      permissions: ['capability-templates:update'],
      tokenAccess: 'allow',
      summary: 'Replace a capability template',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await templates.update(actor, c.req.param('id'), await safeJsonOrEmpty(c.req.raw)),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-templates/:id/copy',
      permissions: ['capability-templates:create'],
      tokenAccess: 'allow',
      summary: 'Copy a capability template into a private draft of your own',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(
        await templates.copy(actor, c.req.param('id'), await safeJsonOrEmpty(c.req.raw)),
        201,
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/capability-templates/:id',
      permissions: ['capability-templates:delete'],
      tokenAccess: 'allow',
      summary: 'Delete a capability template',
    },
    async (c) => {
      const actor = actorOf(c)
      await templates.delete(actor, c.req.param('id'))
      return c.body(null, 204)
    },
  )

  // RFC-309 T16 — the upstream link, finally readable and actionable.
  //
  // A GET rather than a field on the template itself: answering it costs a
  // second row read and a nine-field diff, and putting that on every list
  // response would make the templates page pay for it once per row to render a
  // badge most templates do not have.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/capability-templates/:id/upstream',
      permissions: ['capability-templates:read'],
      tokenAccess: 'allow',
      summary: 'Where this template stands relative to the one it was copied from',
    },
    async (c) => {
      const actor = actorOf(c)
      const id = c.req.param('id')
      await templates.requireVisible(actor, id)
      const report = await templateUpstream.read(id)
      if (report === null) {
        throw new NotFoundError(
          'capability-template-not-found',
          `template '${id}' not found in the selected database provider`,
        )
      }
      return c.json(report)
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/capability-templates/:id/upstream/merge',
      permissions: ['capability-templates:update'],
      tokenAccess: 'allow',
      summary: 'Take every upstream change this copy has not overridden',
    },
    async (c) => {
      const actor = actorOf(c)
      const id = c.req.param('id')
      await templates.requireEditable(actor, id)
      // The `scripts:author` check lives in the command, not here: the merge
      // can carry SCRIPTS across and those run as the daemon, so a route-only
      // check would make any second caller a way around the rule.
      const outcome = await templateUpstream.merge(id, actor)
      if (!outcome.ok) {
        if (outcome.code === 'scripts-forbidden') {
          throw new ForbiddenError(
            'capability-template-scripts-forbidden',
            'merging from upstream can change scripts, which requires the scripts:author permission',
          )
        }
        throw new ValidationError(
          outcome.code === 'no-upstream'
            ? 'capability-template-no-upstream'
            : 'capability-template-upstream-gone',
          outcome.code === 'no-upstream'
            ? 'this template was authored here, not copied — there is nothing to merge from'
            : 'the template this was copied from no longer exists',
        )
      }
      return c.json(outcome)
    },
  )

  mountAclEndpoints(app, {
    type: 'capability_template',
    base: '/api/capability-templates',
    param: 'id',
    load: acl.load,
    canView: acl.canView,
    read: acl.read,
    update: acl.update,
  })
}
