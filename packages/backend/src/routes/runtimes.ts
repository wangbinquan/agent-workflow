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
import { requireAdmin, requirePermission } from '@/auth/permissions'
import { NotFoundError, ValidationError } from '@/util/errors'
import {
  cacheRuntimeProbe,
  createRuntime,
  deleteRuntime,
  getRuntime,
  listRuntimes,
  RUNTIME_PROTOCOLS,
  runtimeRowToView,
  setRuntimeEnabled,
  updateRuntime,
} from '@/services/runtimeRegistry'
import type { RuntimeKind } from '@/services/runtime'
import { getRuntimeDriver } from '@/services/runtime'
import { smokeRuntime, type SmokeResult } from '@/services/runtimeSmoke'

// RFC-143: derived from the DRIVERS registry (via RUNTIME_PROTOCOLS) rather than
// a re-hardcoded literal enum — a new runtime kind is accepted automatically.
const ProtocolSchema = z.enum(RUNTIME_PROTOCOLS as [RuntimeKind, ...RuntimeKind[]])

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

/**
 * RFC-135: the binary a real dispatch would use for a registry row — its own
 * binaryPath, else the protocol default from config. Single source for the
 * status endpoint AND the per-runtime deep-smoke probe below.
 */
function resolveRuntimeBinary(
  row: { protocol: RuntimeKind; binaryPath: string | null },
  cfg: { opencodePath?: string | null; claudeCodePath?: string | null },
): string {
  // RFC-143: custom binaryPath wins, else the driver's default (config path /
  // built-in name) — one source, no re-hardcoded per-protocol config-key pick.
  return row.binaryPath ?? getRuntimeDriver(row.protocol).defaultBinary(cfg)[0]!
}

/**
 * RFC-135 D5: per-row `--version` probe timeout for /api/runtimes/status.
 * Read per request so tests can inject a small value via env; production has
 * no reason to override the 5s default.
 */
function statusProbeTimeoutMs(): number {
  const raw = Number(process.env.AW_RUNTIME_STATUS_PROBE_TIMEOUT_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 5000
}

export function mountRuntimesRoutes(app: Hono, deps: AppDeps): void {
  // List — any authed user (the agent/settings runtime pickers read this).
  app.get('/api/runtimes', async (c) => {
    const rows = await listRuntimes(deps.db)
    const defaultRuntime = loadConfig(deps.configPath).defaultRuntime
    return c.json({ runtimes: rows.map((r) => runtimeRowToView(r, defaultRuntime)) })
  })

  // RFC-135 — live light status for the homepage hero: every ENABLED runtime,
  // probed `--version` in parallel against the binary a dispatch would use.
  // `runtime:read` mirrors the legacy /api/runtime/* gate (server.ts) — this
  // spawns registered binaries, so a narrowed PAT without the permission must
  // not reach it. Availability = exit 0; NO version gate (RFC-135 D3 — custom
  // binaries own their version scheme, and an unparseable version string still
  // counts as runnable: ok true, version null).
  app.get('/api/runtimes/status', requirePermission('runtime:read'), async (c) => {
    const cfg = loadConfig(deps.configPath)
    const rows = (await listRuntimes(deps.db)).filter((r) => r.enabled)
    // Mirror resolveRuntimeByName's fail-safe: a stale/unknown configured
    // default falls back to the opencode builtin for real dispatch, so the
    // status line must mark that SAME row as the default — else a broken
    // effective default reads as a soft non-default failure. (The enabled
    // filter can't hide the configured default: RFC-118 blocks disabling it.)
    const configured = cfg.defaultRuntime ?? 'opencode'
    const defaultName = rows.some((r) => r.name === configured) ? configured : 'opencode'
    const timeoutMs = statusProbeTimeoutMs()
    const runtimes = await Promise.all(
      rows.map(async (row) => {
        const binary = resolveRuntimeBinary(row, cfg)
        // quiet: an enabled-but-missing optional runtime is a normal state
        // here (opencode-only installs keep the claude-code builtin enabled)
        // and the homepage polls every 60s — the response already carries the
        // failure, so per-probe warns would just flood the log (D5/§6).
        const probe = await getRuntimeDriver(row.protocol).probe(binary, {
          timeoutMs,
          quiet: true,
        })
        return {
          name: row.name,
          protocol: row.protocol,
          binary: probe.binary,
          ok: probe.ran === true,
          version: probe.version,
          isDefault: row.name === defaultName,
        }
      }),
    )
    return c.json({ runtimes })
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
    const binaryPath = resolveRuntimeBinary(row, cfg)
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
