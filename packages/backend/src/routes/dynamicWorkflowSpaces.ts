// Dynamic workflow space HTTP routes (RFC-167 PR-1).
// GET    /api/dynamic-workflow-spaces               — list (ACL-filtered)
// GET    /api/dynamic-workflow-spaces/:name         — one (invisible → 404, D1)
// POST   /api/dynamic-workflow-spaces               — create (creator becomes owner)
// PUT    /api/dynamic-workflow-spaces/:name         — update (pool full-replace)
// DELETE /api/dynamic-workflow-spaces/:name         — delete (launched tasks keep their snapshot)
// POST   /api/dynamic-workflow-spaces/:name/rename  — rename
// GET/PUT /api/dynamic-workflow-spaces/:name/acl    — RFC-099 ACL management
//
// The launch endpoint (POST .../:name/tasks) lands with the engine PR (PR-2).
// RFC-099 D15: create/update check only NEWLY-added pool agent references are
// usable by the editor (assertNewRefsUsable) — dangling names still pass
// (existence is launch-validated, same as a workflow node's agentName).

import {
  CreateDynamicWorkflowSpaceSchema,
  RenameDynamicWorkflowSpaceSchema,
  UpdateDynamicWorkflowSpaceSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertNewRefsUsable } from '@/services/resourceRefs'
import {
  createDynamicWorkflowSpace,
  deleteDynamicWorkflowSpace,
  diffNewPoolAgentNames,
  getDynamicWorkflowSpace,
  listDynamicWorkflowSpaces,
  renameDynamicWorkflowSpace,
  updateDynamicWorkflowSpace,
} from '@/services/dynamicWorkflowSpaces'
import { NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountDynamicWorkflowSpaceRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleSpace(actor: Actor, name: string) {
    const space = await getDynamicWorkflowSpace(deps.db, name)
    if (
      space === null ||
      !(await canViewResource(deps.db, actor, 'dynamic_workflow_space', space))
    ) {
      throw new NotFoundError(
        'dynamic-workflow-space-not-found',
        `dynamic workflow space '${name}' not found`,
      )
    }
    return space
  }

  app.get('/api/dynamic-workflow-spaces', async (c) => {
    const list = await listDynamicWorkflowSpaces(deps.db)
    return c.json(await filterVisibleRows(deps.db, actorOf(c), 'dynamic_workflow_space', list))
  })

  app.get('/api/dynamic-workflow-spaces/:name', async (c) => {
    return c.json(await loadVisibleSpace(actorOf(c), c.req.param('name')))
  })

  app.post('/api/dynamic-workflow-spaces', async (c) => {
    const parsed = CreateDynamicWorkflowSpaceSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('dynamic-workflow-space-invalid', 'invalid space payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'agent', names: diffNewPoolAgentNames(null, parsed.data.agentPool) },
    ])
    const created = await createDynamicWorkflowSpace(deps.db, parsed.data, {
      ownerUserId: actor.user.id,
    })
    return c.json(created, 201)
  })

  app.put('/api/dynamic-workflow-spaces/:name', async (c) => {
    const name = c.req.param('name')
    const parsed = UpdateDynamicWorkflowSpaceSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('dynamic-workflow-space-invalid', 'invalid space payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleSpace(actor, name)
    await requireResourceOwner(deps.db, actor, 'dynamic_workflow_space', existing)
    // D15: only NEW pool agent references need to be usable by the editor.
    if (parsed.data.agentPool !== undefined) {
      await assertNewRefsUsable(deps.db, actor, [
        { type: 'agent', names: diffNewPoolAgentNames(existing, parsed.data.agentPool) },
      ])
    }
    const updated = await updateDynamicWorkflowSpace(deps.db, name, parsed.data)
    return c.json(updated)
  })

  app.delete('/api/dynamic-workflow-spaces/:name', async (c) => {
    const name = c.req.param('name')
    const actor = actorOf(c)
    const existing = await loadVisibleSpace(actor, name)
    await requireResourceOwner(deps.db, actor, 'dynamic_workflow_space', existing)
    await deleteDynamicWorkflowSpace(deps.db, name)
    return c.body(null, 204)
  })

  app.post('/api/dynamic-workflow-spaces/:name/rename', async (c) => {
    const name = c.req.param('name')
    const parsed = RenameDynamicWorkflowSpaceSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('dynamic-workflow-space-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleSpace(actor, name)
    await requireResourceOwner(deps.db, actor, 'dynamic_workflow_space', existing)
    const renamed = await renameDynamicWorkflowSpace(deps.db, name, parsed.data.newName)
    return c.json(renamed)
  })

  // RFC-099 — GET/PUT /api/dynamic-workflow-spaces/:name/acl
  mountAclEndpoints(app, deps, {
    type: 'dynamic_workflow_space',
    base: '/api/dynamic-workflow-spaces',
    param: 'name',
    load: (db, name) => getDynamicWorkflowSpace(db, name),
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
