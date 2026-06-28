// RFC-112 PR-B — runtime registry HTTP surface. GET is open to any authed user
// (picking a runtime needs the list); all writes + the smoke /probe are
// admin-only (D3 — a runtime is machine-level config incl. a local binary path,
// and the route orchestrates spawning that binary). Mounted under /api/* by
// server.ts; thrown DomainErrors map to status via app.onError.

import type { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { actorOf } from '@/auth/actor'
import { requireAdmin } from '@/auth/permissions'
import { NotFoundError, ValidationError } from '@/util/errors'
import {
  cacheRuntimeProbe,
  createRuntime,
  deleteRuntime,
  getRuntime,
  listRuntimes,
  runtimeRowToView,
  setRuntimeEnabled,
  updateRuntime,
} from '@/services/runtimeRegistry'
import { smokeRuntime, type SmokeResult } from '@/services/runtimeSmoke'

const ProtocolSchema = z.enum(['opencode', 'claude-code'])

const ProbeBody = z.object({
  protocol: ProtocolSchema,
  binaryPath: z.string().min(1),
})

// RFC-113: per-runtime execution profile params.
const ProfileFields = {
  model: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  steps: z.number().int().positive().nullable().optional(),
  maxSteps: z.number().int().positive().nullable().optional(),
}

const CreateBody = z.object({
  name: z.string().min(1),
  protocol: ProtocolSchema,
  binaryPath: z.string().min(1).optional(),
  /** run the deep-smoke probe before saving (default true when a path is given). */
  probe: z.boolean().optional(),
  ...ProfileFields,
})

const UpdateBody = z.object({
  binaryPath: z.string().nullable().optional(),
  ...ProfileFields,
})

// RFC-118: enable/disable toggle body.
const EnabledBody = z.object({ enabled: z.boolean() })

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('invalid-body', parsed.error.issues.map((i) => i.message).join('; '))
  }
  return parsed.data
}

export function mountRuntimesRoutes(app: Hono, deps: AppDeps): void {
  // List — any authed user (the agent/settings runtime pickers read this).
  app.get('/api/runtimes', async (c) => {
    const rows = await listRuntimes(deps.db)
    const defaultRuntime = loadConfig(deps.configPath).defaultRuntime
    return c.json({ runtimes: rows.map((r) => runtimeRowToView(r, defaultRuntime)) })
  })

  // Deep-smoke a given (protocol, binary) WITHOUT saving — registration preflight
  // + the list's "Test" button. Admin only (it spawns the binary).
  app.post('/api/runtimes/probe', requireAdmin(), async (c) => {
    const body = parseBody(ProbeBody, await c.req.json().catch(() => ({})))
    const cfg = loadConfig(deps.configPath)
    const result = await smokeRuntime({
      protocol: body.protocol,
      binaryPath: body.binaryPath,
      config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
      bridgeCredentials: true,
    })
    return c.json({ smoke: result })
  })

  // Register a custom runtime. Optionally deep-smokes first; the result is
  // stored as advisory `lastProbe` but does NOT block saving (Codex P2 — an
  // auth-missing fork is still registrable; the admin decides).
  app.post('/api/runtimes', requireAdmin(), async (c) => {
    const body = parseBody(CreateBody, await c.req.json().catch(() => ({})))
    const actor = actorOf(c)
    let smoke: SmokeResult | undefined
    const wantProbe = body.probe ?? body.binaryPath !== undefined
    if (wantProbe && body.binaryPath !== undefined) {
      const cfg = loadConfig(deps.configPath)
      smoke = await smokeRuntime({
        protocol: body.protocol,
        binaryPath: body.binaryPath,
        config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
        bridgeCredentials: true,
      })
    }
    const row = await createRuntime(deps.db, {
      name: body.name,
      protocol: body.protocol,
      binaryPath: body.binaryPath ?? null,
      lastProbeJson: smoke !== undefined ? JSON.stringify(smoke) : null,
      createdBy: actor.user.id,
      model: body.model,
      variant: body.variant,
      temperature: body.temperature,
      steps: body.steps,
      maxSteps: body.maxSteps,
    })
    const def = loadConfig(deps.configPath).defaultRuntime
    return c.json(
      { runtime: runtimeRowToView(row, def), ...(smoke !== undefined ? { smoke } : {}) },
      201,
    )
  })

  // Update a runtime's binary path + profile params (name + protocol immutable;
  // RFC-113 D8: built-ins editable here, only delete/identity stays locked).
  app.put('/api/runtimes/:name', requireAdmin(), async (c) => {
    const name = c.req.param('name')
    const body = parseBody(UpdateBody, await c.req.json().catch(() => ({})))
    const row = await updateRuntime(deps.db, name, {
      ...(body.binaryPath !== undefined ? { binaryPath: body.binaryPath } : {}),
      model: body.model,
      variant: body.variant,
      temperature: body.temperature,
      steps: body.steps,
      maxSteps: body.maxSteps,
    })
    return c.json({ runtime: runtimeRowToView(row, loadConfig(deps.configPath).defaultRuntime) })
  })

  // RFC-118: enable/disable a runtime (incl. built-ins) — admin only. A disabled
  // runtime stays in the list but drops out of the agent / default-runtime pickers.
  // The effective default (config.defaultRuntime ?? 'opencode') can't be disabled
  // (setRuntimeEnabled guards → 409).
  app.post('/api/runtimes/:name/enabled', requireAdmin(), async (c) => {
    const name = c.req.param('name')
    const body = parseBody(EnabledBody, await c.req.json().catch(() => ({})))
    const cfg = loadConfig(deps.configPath)
    const row = await setRuntimeEnabled(deps.db, name, body.enabled, cfg.defaultRuntime)
    return c.json({ runtime: runtimeRowToView(row, cfg.defaultRuntime) })
  })

  // Delete a custom runtime (blocked while referenced by an agent / the default).
  app.delete('/api/runtimes/:name', requireAdmin(), async (c) => {
    const name = c.req.param('name')
    const cfg = loadConfig(deps.configPath)
    await deleteRuntime(deps.db, name, cfg.defaultRuntime)
    return c.json({ ok: true })
  })

  // Re-smoke an existing runtime + cache the result onto the row (the list's
  // "Test" button for a saved runtime). Resolves the binary the same way a real
  // dispatch would (custom path, or the protocol default for built-ins). Probe
  // caching is allowed on built-ins (it's advisory display, not an identity edit).
  app.post('/api/runtimes/:name/probe', requireAdmin(), async (c) => {
    const name = c.req.param('name')
    const row = await getRuntime(deps.db, name)
    if (row === null) {
      throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
    }
    const cfg = loadConfig(deps.configPath)
    const binaryPath =
      row.binaryPath ??
      (row.protocol === 'opencode'
        ? (cfg.opencodePath ?? 'opencode')
        : (cfg.claudeCodePath ?? 'claude'))
    const smoke = await smokeRuntime({
      protocol: row.protocol,
      binaryPath,
      config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
      bridgeCredentials: true,
    })
    await cacheRuntimeProbe(deps.db, name, JSON.stringify(smoke))
    return c.json({ smoke })
  })
}
