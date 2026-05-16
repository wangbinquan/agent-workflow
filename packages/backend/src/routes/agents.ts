// GET    /api/agents             — list
// GET    /api/agents/:name       — one
// POST   /api/agents             — create
// PUT    /api/agents/:name       — update (any subset of fields)
// DELETE /api/agents/:name       — delete (refuses if referenced)
// POST   /api/agents/:name/rename — rename (refuses if referenced or name taken)

import {
  AgentNameSchema,
  CreateAgentSchema,
  RenameAgentSchema,
  UpdateAgentSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  renameAgent,
  updateAgent,
} from '@/services/agent'
import { resolveDependsClosure, validateDependsOn } from '@/services/agentDeps'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { Agent } from '@agent-workflow/shared'

export function mountAgentRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/agents', async (c) => {
    const list = await listAgents(deps.db)
    return c.json(list)
  })

  app.get('/api/agents/:name', async (c) => {
    const name = c.req.param('name')
    const agent = await getAgent(deps.db, name)
    if (agent === null) {
      throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
    }
    return c.json(agent)
  })

  app.post('/api/agents', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-invalid', 'invalid agent payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createAgent(deps.db, parsed.data)
    return c.json(created, 201)
  })

  app.put('/api/agents/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-invalid', 'invalid agent patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await updateAgent(deps.db, name, parsed.data)
    return c.json(updated)
  })

  app.delete('/api/agents/:name', async (c) => {
    const name = c.req.param('name')
    await deleteAgent(deps.db, name)
    return c.body(null, 204)
  })

  app.post('/api/agents/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameAgentSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('agent-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const renamed = await renameAgent(deps.db, name, parsed.data)
    return c.json(renamed)
  })

  // RFC-022: closure read-only endpoint. Returns the BFS-ordered agent list
  // for the named agent's dependsOn closure (root first). Missing closure
  // members surface as `{ name, missing: true }` placeholders so the UI can
  // render `<missing> name` rather than silently shrinking the tree.
  app.get('/api/agents/:name/closure', async (c) => {
    const name = c.req.param('name')
    const root = await getAgent(deps.db, name)
    if (root === null) {
      throw new NotFoundError('agent-not-found', `agent '${name}' not found`)
    }
    const closure = await resolveDependsClosure(deps.db, root, { allowMissing: true })
    // `allowMissing: true` never produces ok:false (cycles only arise when a
    // name appears on the active path — which agent.ts save guard prevents),
    // but defensively handle the type anyway.
    if (closure.ok === false) {
      return c.json({
        ok: false,
        code: 'agent-dependency-cycle',
        cyclePath: closure.cyclePath,
      })
    }
    return c.json({
      ok: true,
      agents: toAgentClosureSummaries(closure.agents, root),
    })
  })

  // RFC-022: preview endpoint used by AgentForm while editing. Returns
  // HTTP 200 with `ok: false` on validation errors (instead of a 4xx)
  // because every keystroke would otherwise flash red in the browser's
  // network panel. Save-time POST/PUT keep their 400 path.
  const ClosurePreviewBodySchema = z.object({
    name: AgentNameSchema,
    dependsOn: z.array(AgentNameSchema).max(64).default([]),
  })
  app.post('/api/agents/closure-preview', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = ClosurePreviewBodySchema.safeParse(body)
    if (!parsed.success) {
      return c.json({
        ok: false,
        code: 'agent-closure-preview-invalid',
        details: { issues: parsed.error.issues },
      })
    }
    try {
      await validateDependsOn(deps.db, parsed.data.name, parsed.data.dependsOn)
    } catch (err) {
      if (err instanceof DomainError) {
        return c.json({ ok: false, code: err.code, details: err.details })
      }
      throw err
    }
    // Build a synthetic root agent for closure expansion (selfName may not
    // exist in DB yet — new-agent flow). validateDependsOn already vetted
    // names exist + no cycle, so allowMissing:false is safe here.
    const existing = await getAgent(deps.db, parsed.data.name)
    const syntheticRoot: Agent = existing
      ? { ...existing, dependsOn: parsed.data.dependsOn }
      : ({
          id: '',
          name: parsed.data.name,
          description: '',
          outputs: [],
          readonly: false,
          syncOutputsOnIterate: true,
          permission: {},
          skills: [],
          dependsOn: parsed.data.dependsOn,
          frontmatterExtra: {},
          bodyMd: '',
          schemaVersion: 1,
          createdAt: 0,
          updatedAt: 0,
        } satisfies Agent)
    const closure = await resolveDependsClosure(deps.db, syntheticRoot, { allowMissing: false })
    if (closure.ok === false) {
      // Shouldn't happen — validateDependsOn already screened cycles — but
      // surface defensively so a race doesn't 500.
      return c.json({
        ok: false,
        code: 'agent-dependency-cycle',
        details: { cyclePath: closure.cyclePath },
      })
    }
    return c.json({
      ok: true,
      agents: toAgentClosureSummaries(closure.agents, syntheticRoot),
    })
  })
}

/**
 * RFC-022 closure response shape — minimal projection over `Agent` that the
 * `<DependencyTree>` renderer needs. `skillCount` is computed from
 * `agent.skills.length`; dependency-missing names appear as placeholder
 * rows so the UI can still render them under their parent.
 */
function toAgentClosureSummaries(
  closure: Agent[],
  root: Agent,
): Array<{
  name: string
  description: string
  skillCount: number
  readonly: boolean
  dependsOn: string[]
  missing: boolean
}> {
  const out: Array<{
    name: string
    description: string
    skillCount: number
    readonly: boolean
    dependsOn: string[]
    missing: boolean
  }> = closure.map((a) => ({
    name: a.name,
    description: a.description,
    skillCount: a.skills.length,
    readonly: a.readonly,
    dependsOn: a.dependsOn,
    missing: false,
  }))
  // Append placeholder rows for names referenced by any closure member but
  // not present in the resolved list. Without this the UI can't show
  // `<missing>` rows under their parents — buildDependencyTree on the
  // frontend treats absent names as missing leaves anyway, but appending
  // them here keeps the wire shape symmetric.
  const present = new Set(closure.map((a) => a.name))
  const missing = new Set<string>()
  for (const a of closure) {
    for (const dep of a.dependsOn) {
      if (!present.has(dep)) missing.add(dep)
    }
  }
  for (const name of missing) {
    out.push({
      name,
      description: '',
      skillCount: 0,
      readonly: false,
      dependsOn: [],
      missing: true,
    })
  }
  // root reference kept for future use (rendering hint); silence unused lint.
  void root
  return out
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
