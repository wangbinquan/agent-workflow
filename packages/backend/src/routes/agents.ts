// GET    /api/agents             — list
// GET    /api/agents/:name       — one
// POST   /api/agents             — create
// PUT    /api/agents/:name       — update (any subset of fields)
// DELETE /api/agents/:name       — delete (refuses if referenced)
// POST   /api/agents/:name/rename — rename (refuses if referenced or name taken)

import { CreateAgentSchema, RenameAgentSchema, UpdateAgentSchema } from '@agent-workflow/shared'
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
import { NotFoundError, ValidationError } from '@/util/errors'

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
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
