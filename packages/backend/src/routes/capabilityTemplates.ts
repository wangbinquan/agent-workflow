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
import { z } from 'zod'
import { CapabilityTemplateCopySchema, CapabilityTemplateWriteSchema } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { mountAclEndpoints } from '@/routes/resourceAcl'
import {
  copyTemplate,
  createTemplate,
  deleteTemplate,
  getTemplateRow,
  listTemplateRows,
  mayReadScripts,
  serializeTemplate,
  updateTemplate,
} from '@/services/capabilityTemplates'
import {
  mergeFromUpstream,
  readUpstreamReport,
} from '@/modules/code-capability/application/templateUpstreamStatus'
import {
  assertNameUnchangedForEditor,
  canViewResource,
  filterVisibleRows,
  requireResourceEdit,
  requireResourceGovern,
} from '@/services/resourceAcl'
import type { AppDeps } from '@/server'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export function mountCapabilityTemplateRoutes(app: Hono, deps: AppDeps): void {
  async function loadVisibleTemplate(actor: Actor, id: string) {
    const row = await getTemplateRow(deps.db, id)
    if (row === null || !(await canViewResource(deps.db, actor, 'capability_template', row))) {
      // 404, not 403: an invisible resource must be indistinguishable from a
      // missing one, or the status code becomes an existence oracle.
      throw new NotFoundError('capability-template-not-found', `template '${id}' not found`)
    }
    return row
  }

  /**
   * Parse a write, re-filling the fields this caller was never shown.
   *
   * See the redaction note at the top: a caller without `scripts:author` gets
   * a body with no `scripts`/`hooks`, so their honest round-trip must not be
   * read as "delete them".
   */
  async function parseWrite(raw: unknown, actor: Actor, existing: { id: string } | null) {
    // Parsed, not cast: RFC-054 W1-7 bans `as T` in a route handler, and the
    // reason applies exactly here — a cast would let a body of any shape reach
    // the re-fill below and be handed on as if it had been checked.
    const loose = z.record(z.string(), z.unknown()).safeParse(raw)
    const body: Record<string, unknown> = loose.success ? { ...loose.data } : {}
    if (!mayReadScripts(actor) && existing !== null) {
      const stored = await getTemplateRow(deps.db, existing.id)
      if (stored !== null) {
        if (body.scripts === undefined) body.scripts = JSON.parse(stored.scriptsJson) as unknown
        if (body.hooks === undefined) body.hooks = JSON.parse(stored.hooksJson) as unknown
      }
    }
    const parsed = CapabilityTemplateWriteSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('capability-template-invalid', 'invalid template payload', {
        issues: parsed.error.issues,
      })
    }
    return parsed.data
  }

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
      const visible = await filterVisibleRows(
        deps.db,
        actor,
        'capability_template',
        await listTemplateRows(deps.db),
      )
      return c.json(visible.map((row) => serializeTemplate(row, actor)))
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
      return c.json(serializeTemplate(await loadVisibleTemplate(actor, c.req.param('id')), actor))
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
      const input = await parseWrite(await safeJsonOrEmpty(c.req.raw), actor, null)
      const row = await createTemplate(deps.db, input, actor)
      return c.json(serializeTemplate(row, actor), 201)
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
      const existing = await loadVisibleTemplate(actor, c.req.param('id'))
      // RFC-324: content write. Unlike agents/skills/MCPs, a template's update
      // body DOES carry its name (the write schema is the whole document), so
      // the rename fence has to run here.
      const access = await requireResourceEdit(deps.db, actor, 'capability_template', existing)
      const input = await parseWrite(await safeJsonOrEmpty(c.req.raw), actor, existing)
      assertNameUnchangedForEditor(access, existing.name, input.name)
      // The field-level gate lives in the service, so the bundle path gets it
      // too — a route-only check would make an import a way around the rule.
      const row = await updateTemplate(deps.db, existing, input, actor)
      return c.json(serializeTemplate(row, actor))
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
      const source = await loadVisibleTemplate(actor, c.req.param('id'))
      const parsed = CapabilityTemplateCopySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('capability-template-invalid', 'invalid copy payload', {
          issues: parsed.error.issues,
        })
      }
      const row = await copyTemplate(deps.db, source, actor, parsed.data.name)
      return c.json(serializeTemplate(row, actor), 201)
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
      const existing = await loadVisibleTemplate(actor, c.req.param('id'))
      await requireResourceGovern(deps.db, actor, 'capability_template', existing)
      await deleteTemplate(deps.db, existing)
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
      const row = await loadVisibleTemplate(actor, c.req.param('id'))
      return c.json(await readUpstreamReport(deps.db, row))
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
      const row = await loadVisibleTemplate(actor, c.req.param('id'))
      await requireResourceEdit(deps.db, actor, 'capability_template', row)
      // The `scripts:author` check lives in the command, not here: the merge
      // can carry SCRIPTS across and those run as the daemon, so a route-only
      // check would make any second caller a way around the rule.
      const outcome = await mergeFromUpstream(deps.db, row, actor)
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

  mountAclEndpoints(app, deps, {
    type: 'capability_template',
    base: '/api/capability-templates',
    param: 'id',
    load: async (db, key) => await getTemplateRow(db, key),
  })
}
