// MCP HTTP routes (RFC-028 + RFC-030).
// GET    /api/mcps                  — list
// GET    /api/mcps/probes           — RFC-030: list all probe rows (joined w/ mcp name)
// GET    /api/mcps/:name            — one
// POST   /api/mcps                  — create
// PUT    /api/mcps/:name            — update (subset of fields; type immutable)
// DELETE /api/mcps/:name            — delete (refuses if referenced)
// POST   /api/mcps/:name/rename     — rename (cascades into agents.mcp arrays)
// GET    /api/mcps/:name/probe      — RFC-030: last probe row, 404 if never probed
// POST   /api/mcps/:name/probe      — RFC-030: trigger probe + upsert; returns row
//
// IMPORTANT: /api/mcps/probes is registered BEFORE /api/mcps/:name so it
// doesn't get swallowed by the parametric route (`:name = "probes"`).

import { CreateMcpSchema, RenameMcpSchema, UpdateMcpSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { createMcp, deleteMcp, getMcp, listMcps, renameMcp, updateMcp } from '@/services/mcp'
import { probeMcp, type ProbeOptions } from '@/services/mcpProbe'
import { getProbe, listProbes, upsertProbe } from '@/services/mcpProbeStore'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('mcps-routes')

// Allow tests to override the probe options (e.g. inject a fake openClient).
// In production this stays undefined and probeMcp uses defaults.
let probeOptionsOverride: ProbeOptions | undefined
export function __setProbeOptionsForTesting(opts: ProbeOptions | undefined): void {
  probeOptionsOverride = opts
}

export function mountMcpRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/mcps', async (c) => {
    const list = await listMcps(deps.db)
    return c.json(list)
  })

  // RFC-030 — must come BEFORE /api/mcps/:name to avoid being swallowed.
  app.get('/api/mcps/probes', async (c) => {
    const list = await listProbes(deps.db)
    return c.json(list)
  })

  app.get('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    const mcp = await getMcp(deps.db, name)
    if (mcp === null) {
      throw new NotFoundError('mcp-not-found', `mcp '${name}' not found`)
    }
    return c.json(mcp)
  })

  app.post('/api/mcps', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await createMcp(deps.db, parsed.data)
    return c.json(created, 201)
  })

  app.put('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-invalid', 'invalid mcp patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await updateMcp(deps.db, name, parsed.data)
    return c.json(updated)
  })

  app.delete('/api/mcps/:name', async (c) => {
    const name = c.req.param('name')
    await deleteMcp(deps.db, name)
    return c.body(null, 204)
  })

  app.post('/api/mcps/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameMcpSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('mcp-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const renamed = await renameMcp(deps.db, name, parsed.data)
    return c.json(renamed)
  })

  // RFC-030 — per-mcp probe endpoints.
  app.get('/api/mcps/:name/probe', async (c) => {
    const name = c.req.param('name')
    // Existence check on the parent mcp keeps the 404 distinction:
    //   - mcp doesn't exist            → 404 mcp-not-found
    //   - mcp exists but never probed  → 404 probe-not-found
    const mcp = await getMcp(deps.db, name)
    if (mcp === null) {
      throw new NotFoundError('mcp-not-found', `mcp '${name}' not found`)
    }
    const probe = await getProbe(deps.db, name)
    if (probe === null) {
      throw new NotFoundError(
        'probe-not-found',
        `mcp '${name}' has not been probed yet — POST /api/mcps/${name}/probe first`,
      )
    }
    return c.json(probe)
  })

  app.post('/api/mcps/:name/probe', async (c) => {
    const name = c.req.param('name')
    const mcp = await getMcp(deps.db, name)
    if (mcp === null) {
      throw new NotFoundError('mcp-not-found', `mcp '${name}' not found`)
    }
    // probeMcp throws ValidationError('mcp-disabled') → maps to 422
    // automatically via the DomainError middleware. Anything else from the
    // probe service is captured into the returned ProbeResult with status=error.
    let result
    try {
      result = await probeMcp(mcp, probeOptionsOverride)
    } catch (err) {
      if (err instanceof DomainError) throw err
      // log-only: probe orchestrator should not throw non-DomainError. If it
      // does, this is an internal bug — surface as 500 via the default error
      // handler (HTTP alert path); the log captures the unexpected
      // exception for operator debugging.
      log.error('probeMcp unexpectedly threw', {
        mcp: name,
        message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
    const persisted = await upsertProbe(deps.db, mcp.id, mcp.name, result)
    return c.json(persisted)
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
