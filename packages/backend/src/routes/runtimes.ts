// RFC-112 PR-B — runtime registry HTTP surface. GET is open to any authed user
// (picking a runtime needs the list); all writes + the smoke /probe require
// `settings:write` (D3 — a runtime is machine-level config incl. a local binary
// path, and the route orchestrates spawning that binary). Mounted under /api/* by
// server.ts; thrown DomainErrors map to status via app.onError.

import type { Hono } from 'hono'
import { z } from 'zod'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { actorOf } from '@/auth/actor'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  cacheRuntimeProbe,
  createRuntime,
  deleteRuntime,
  getRuntime,
  assertRuntimeSpawnCapabilities,
  listRuntimes,
  parseRuntimeExtraArgs,
  RUNTIME_PROTOCOLS,
  runtimeProbeTargetOf,
  runtimeRowToView,
  setRuntimeEnabled,
  updateRuntime,
  withRuntimeProbeConfigFence,
} from '@/services/runtimeRegistry'
import type { RuntimeKind } from '@/services/runtime'
import { tryGetRuntimeDriver } from '@/services/runtime'
import { smokeRuntime as productionSmokeRuntime, type SmokeResult } from '@/services/runtimeSmoke'
import { getMcpRuntimeTestService, isRuntimeMcpTestEligible } from '@/services/mcpRuntimeTest'
import { Paths } from '@/util/paths'

// RFC-143: derived from the DRIVERS registry (via RUNTIME_PROTOCOLS) rather than
// a re-hardcoded literal enum — a new runtime kind is accepted automatically.
const ProtocolSchema = z.enum(RUNTIME_PROTOCOLS as [RuntimeKind, ...RuntimeKind[]])

const ProbeBody = z.object({
  protocol: ProtocolSchema,
  binaryPath: z.string().min(1),
  model: z.string().min(1).optional(),
  isSandbox: z.boolean().optional(),
  // 2026-08-04 — shape-only here; the registry's validateExtraArgs is the
  // semantic gate (protocol / reserved flags / token rules) at save time. A
  // pre-save probe passes them through so Test reproduces the future dispatch.
  extraArgs: z.array(z.string().min(1)).max(16).optional(),
})

// RFC-113: per-runtime execution profile params.
const ProfileFields = {
  model: z.string().nullable().optional(),
  variant: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  steps: z.number().int().positive().nullable().optional(),
  maxSteps: z.number().int().positive().nullable().optional(),
  isSandbox: z.boolean().optional(),
}

// RFC-154: config-dir injection overrides. Shape-only here — the semantic
// validation (leaf-name / legal non-reserved env name) lives in the registry
// (validateConfigDirName / validateConfigDirEnv), single source for CLI + route.
const ConfigDirFields = {
  configDirEnv: z.string().nullable().optional(),
  configDirName: z.string().nullable().optional(),
}

const CreateBody = z.object({
  name: z.string().min(1),
  protocol: ProtocolSchema,
  binaryPath: z.string().min(1).optional(),
  /** run the deep-smoke probe before saving (default true when a path is given). */
  probe: z.boolean().optional(),
  extraArgs: z.array(z.string().min(1)).max(16).nullable().optional(),
  ...ProfileFields,
  ...ConfigDirFields,
})

const UpdateBody = z.object({
  binaryPath: z.string().nullable().optional(),
  extraArgs: z.array(z.string().min(1)).max(16).nullable().optional(),
  ...ProfileFields,
  ...ConfigDirFields,
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
  // RFC-282 C2（P2-1）— display path: a dirty protocol on one row degrades to
  // its stored binaryPath / protocol label instead of 500-ing the whole list.
  return row.binaryPath ?? tryGetRuntimeDriver(row.protocol)?.defaultBinary(cfg)[0] ?? row.protocol
}

/**
 * RFC-135 D5: per-row `--version` probe timeout for /api/runtimes/status.
 * RFC-284 T26 —— 测试注入改走 deps（runtimeDiagnosticTestDependencies.
 * probeTimeoutMsForTest），env 通道已删；production has no reason to override
 * the 5s default.
 */
const STATUS_PROBE_TIMEOUT_MS = 5000

export function mountRuntimesRoutes(app: Hono, deps: AppDeps): void {
  const runtimeTests = getMcpRuntimeTestService({
    db: deps.db,
    configPath: deps.configPath,
    appHome: deps.mcpRuntimeTestDependencies?.appHome ?? Paths.root,
    runFn: deps.mcpRuntimeTestDependencies?.runFn,
    now: deps.mcpRuntimeTestDependencies?.now,
    capacity: deps.mcpRuntimeTestDependencies?.capacity,
  })
  const smokeRuntime =
    deps.runtimeDiagnosticTestDependencies?.smokeRuntime ?? productionSmokeRuntime

  // List — any authed user (the agent/settings runtime pickers read this).
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/runtimes',
      permissions: ['runtime:read'],
      tokenAccess: 'allow',
      summary: 'List registered runtimes',
    },
    async (c) => {
      const rows = await listRuntimes(deps.db)
      const cfg = loadConfig(deps.configPath)
      return c.json({
        runtimes: rows.map((row) => ({
          ...runtimeRowToView(row, cfg.defaultRuntime, resolveRuntimeBinary(row, cfg)),
          capabilities: {
            mcpRuntimeTestV1: isRuntimeMcpTestEligible(row),
          },
        })),
      })
    },
  )

  // RFC-135 — live light status for the homepage hero: every ENABLED runtime is
  // probed `--version` in parallel against the binary a dispatch would use.
  // This is advisory availability telemetry and does not alter child launch.
  // `runtime:read` mirrors the legacy /api/runtime/* gate (server.ts) — this
  // spawns registered binaries, so a narrowed PAT without the permission must
  // not reach it.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/runtimes/status',
      permissions: ['runtime:read'],
      tokenAccess: 'allow',
      summary: 'Runtime qualification status',
    },
    async (c) => {
      const cfg = loadConfig(deps.configPath)
      const rows = (await listRuntimes(deps.db)).filter((r) => r.enabled)
      // Mirror resolveRuntimeByName's fail-safe: a stale/unknown configured
      // default falls back to the opencode builtin for real dispatch, so the
      // status line must mark that SAME row as the default — else a broken
      // effective default reads as a soft non-default failure. (The enabled
      // filter can't hide the configured default: RFC-118 blocks disabling it.)
      const configured = cfg.defaultRuntime ?? 'opencode'
      const defaultName = rows.some((r) => r.name === configured) ? configured : 'opencode'
      const timeoutMs =
        deps.runtimeDiagnosticTestDependencies?.probeTimeoutMsForTest ?? STATUS_PROBE_TIMEOUT_MS
      const runtimes = await Promise.all(
        rows.map(async (row) => {
          const binary = resolveRuntimeBinary(row, cfg)
          // quiet: an enabled-but-missing optional runtime is a normal state
          // here (opencode-only installs keep the claude-code builtin enabled)
          // and the homepage polls every 60s — the response already carries the
          // failure, so per-probe warns would just flood the log (D5/§6).
          // RFC-282 C2（P2-1）— status list: an unknown-protocol row reports
          // itself unavailable instead of rejecting the whole Promise.all.
          const rowDriver = tryGetRuntimeDriver(row.protocol)
          const probe =
            rowDriver === null
              ? {
                  binary,
                  version: null,
                  compatible: false,
                  ran: false,
                  incompatibleReason: `unknown runtime protocol '${row.protocol}'`,
                }
              : await rowDriver.probe(binary, {
                  timeoutMs,
                  quiet: true,
                })
          const availabilityState =
            probe.ran === true
              ? probe.compatible
                ? ('ready' as const)
                : ('protocol-incompatible' as const)
              : ('not-found' as const)
          return {
            name: row.name,
            protocol: row.protocol,
            binary: probe.binary,
            ok: availabilityState === 'ready',
            version: probe.version,
            reportedVersion: probe.version,
            state: availabilityState,
            isDefault: row.name === defaultName,
          }
        }),
      )
      return c.json({ runtimes })
    },
  )

  // Deep-smoke a given (protocol, binary) WITHOUT saving — registration preflight
  // + the list's "Test" button. Admin only (it spawns the binary).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/runtimes/probe',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Probe an arbitrary runtime binary',
    },
    async (c) => {
      const body = parseBody(ProbeBody, await c.req.json().catch(() => ({})))
      // RFC-317 T71（findings RT-01）—— 能力门必须在**任何 spawn 之前**。
      // ProbeBody 只做形状校验（:43 的注释自己写着「registry 的 validateExtraArgs
      // 才是权威」），而这条路径此前从不调它：请求体里的 extraArgs / isSandbox
      // 直接进 smokeRuntime 拉起真子进程。
      assertRuntimeSpawnCapabilities(body.protocol, {
        extraArgs: body.extraArgs,
        isSandbox: body.isSandbox,
      })
      const cfg = loadConfig(deps.configPath)
      const result = await smokeRuntime({
        protocol: body.protocol,
        binaryPath: body.binaryPath,
        config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
        ...(body.model !== undefined ? { model: body.model } : {}),
        isSandbox: body.isSandbox === true,
        ...(body.extraArgs !== undefined && body.extraArgs.length > 0
          ? { extraArgs: body.extraArgs }
          : {}),
      })
      return c.json({ smoke: result })
    },
  )

  // Register a custom runtime. Optionally deep-smokes first; the result is
  // stored as advisory `lastProbe` but does NOT block saving (Codex P2 — an
  // auth-missing fork is still registrable; the admin decides).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/runtimes',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Register a runtime',
    },
    async (c) => {
      const body = parseBody(CreateBody, await c.req.json().catch(() => ({})))
      const actor = actorOf(c)
      let smoke: SmokeResult | undefined
      const wantProbe = body.probe ?? body.binaryPath !== undefined
      if (wantProbe && body.binaryPath !== undefined) {
        // RFC-317 T71（findings RT-01）—— 预检 smoke 跑在 createRuntime **之前**，
        // 所以「createRuntime 会校验」救不了它：一组不被接受的参数会先被**执行**，
        // 之后才因保存失败而报错。能力门前置到 spawn 之前。
        assertRuntimeSpawnCapabilities(body.protocol, {
          extraArgs: body.extraArgs,
          isSandbox: body.isSandbox,
        })
        const cfg = loadConfig(deps.configPath)
        smoke = await smokeRuntime({
          protocol: body.protocol,
          binaryPath: body.binaryPath,
          config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
          ...(typeof body.model === 'string' ? { model: body.model } : {}),
          isSandbox: body.isSandbox === true,
          ...(Array.isArray(body.extraArgs) && body.extraArgs.length > 0
            ? { extraArgs: body.extraArgs }
            : {}),
        })
      }
      let row = await createRuntime(deps.db, {
        name: body.name,
        protocol: body.protocol,
        binaryPath: body.binaryPath ?? null,
        configDirEnv: body.configDirEnv,
        configDirName: body.configDirName,
        createdBy: actor.user.id,
        model: body.model,
        variant: body.variant,
        temperature: body.temperature,
        steps: body.steps,
        maxSteps: body.maxSteps,
        isSandbox: body.isSandbox,
        extraArgs: body.extraArgs,
      })
      const cfg = loadConfig(deps.configPath)
      if (smoke !== undefined) {
        const target = runtimeProbeTargetOf(row, resolveRuntimeBinary(row, cfg))
        await cacheRuntimeProbe(deps.db, target, smoke)
        const refreshed = await getRuntime(deps.db, row.name)
        if (refreshed?.id === row.id) row = refreshed
      }
      return c.json(
        {
          runtime: runtimeRowToView(row, cfg.defaultRuntime, resolveRuntimeBinary(row, cfg)),
          ...(smoke !== undefined ? { smoke } : {}),
        },
        201,
      )
    },
  )

  // Update a runtime's binary path + profile params (name + protocol immutable;
  // RFC-113 D8: built-ins editable here, only delete/identity stays locked).
  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/runtimes/:name',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Update a runtime',
    },
    async (c) => {
      const name = c.req.param('name')
      const body = parseBody(UpdateBody, await c.req.json().catch(() => ({})))
      const row = await updateRuntime(deps.db, name, {
        ...(body.binaryPath !== undefined ? { binaryPath: body.binaryPath } : {}),
        ...(body.configDirEnv !== undefined ? { configDirEnv: body.configDirEnv } : {}),
        ...(body.configDirName !== undefined ? { configDirName: body.configDirName } : {}),
        ...(body.extraArgs !== undefined ? { extraArgs: body.extraArgs } : {}),
        model: body.model,
        variant: body.variant,
        temperature: body.temperature,
        steps: body.steps,
        maxSteps: body.maxSteps,
        isSandbox: body.isSandbox,
      })
      await runtimeTests.reconcileDurableIntents()
      const cfg = loadConfig(deps.configPath)
      return c.json({
        runtime: runtimeRowToView(row, cfg.defaultRuntime, resolveRuntimeBinary(row, cfg)),
      })
    },
  )

  // RFC-118: enable/disable a runtime (incl. built-ins) — admin only. A disabled
  // runtime stays in the list but drops out of the agent / default-runtime pickers.
  // The effective default (config.defaultRuntime ?? 'opencode') can't be disabled
  // (setRuntimeEnabled guards → 409).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/runtimes/:name/enabled',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Enable or disable a runtime',
    },
    async (c) => {
      const name = c.req.param('name')
      const body = parseBody(EnabledBody, await c.req.json().catch(() => ({})))
      const cfg = loadConfig(deps.configPath)
      const row = await setRuntimeEnabled(deps.db, name, body.enabled, cfg.defaultRuntime)
      await runtimeTests.reconcileDurableIntents()
      return c.json({
        runtime: runtimeRowToView(row, cfg.defaultRuntime, resolveRuntimeBinary(row, cfg)),
      })
    },
  )

  // Delete a runtime — blocked while referenced by an agent, the effective default,
  // or a per-feature config runtime field, and blocked if it's the last row (RFC-153).
  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/runtimes/:name',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Delete a runtime',
    },
    async (c) => {
      const name = c.req.param('name')
      const cfg = loadConfig(deps.configPath)
      await deleteRuntime(deps.db, name, {
        defaultRuntime: cfg.defaultRuntime,
        memoryDistillRuntime: cfg.memoryDistillRuntime,
        commitPushRuntime: cfg.commitPushRuntime,
        mergeAgentRuntime: cfg.mergeAgentRuntime,
        intentBuilderRuntime: cfg.intentBuilderRuntime,
        changeNarrativeRuntime: cfg.changeNarrativeRuntime,
      })
      await runtimeTests.reconcileDurableIntents()
      return c.json({ ok: true })
    },
  )

  // Re-smoke an existing runtime + cache the result onto the row (the list's
  // "Test" button for a saved runtime). Resolves the binary the same way a real
  // dispatch would (custom path, or the protocol default for built-ins). Probe
  // caching is allowed on built-ins (it's advisory display, not an identity edit).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/runtimes/:name/probe',
      permissions: ['settings:write'],
      tokenAccess: 'allow',
      summary: 'Probe a registered runtime',
    },
    async (c) => {
      const name = c.req.param('name')
      const row = await getRuntime(deps.db, name)
      if (row === null) {
        throw new NotFoundError('runtime-not-found', `runtime '${name}' not found`)
      }
      const cfg = loadConfig(deps.configPath)
      const binaryPath = resolveRuntimeBinary(row, cfg)
      const probeTarget = runtimeProbeTargetOf(row, binaryPath)
      const rowExtraArgs = parseRuntimeExtraArgs(row.extraArgsJson)
      // RFC-317 T71 —— 这一处的入参来自**已持久化的行**（写入时过过校验），
      // 因此不是 RT-01 点名的请求体通道；仍然过一次门是有意的：driver 的能力声明
      // 可能在这一行写下之后**被收回**，那时按旧行去 spawn 就成了绕过。
      // 三个 spawn 站点判据一致，也让下面那条源码棘轮不必区分「哪些站点算数」。
      assertRuntimeSpawnCapabilities(row.protocol, {
        extraArgs: rowExtraArgs,
        isSandbox: row.isSandbox,
      })
      const smoke = await smokeRuntime({
        protocol: row.protocol,
        binaryPath,
        config: { opencodePath: cfg.opencodePath, claudeCodePath: cfg.claudeCodePath },
        ...(row.model !== null ? { model: row.model } : {}),
        isSandbox: row.isSandbox,
        ...(rowExtraArgs !== null ? { extraArgs: rowExtraArgs } : {}),
      })
      return withRuntimeProbeConfigFence(deps.configPath, async () => {
        // A row with binaryPath=NULL inherits the protocol path from config.json.
        // Config PUT holds this same fence while it first bumps the persisted DB
        // generation and then replaces the file, closing the final check→CAS gap.
        const currentRow = await getRuntime(deps.db, name)
        const currentConfig = loadConfig(deps.configPath)
        if (
          currentRow === null ||
          resolveRuntimeBinary(currentRow, currentConfig) !== probeTarget.resolvedBinaryPath
        ) {
          throw new ConflictError(
            'runtime-probe-stale',
            `runtime '${name}' changed while its probe was running; retry the probe`,
          )
        }
        await deps.runtimeDiagnosticTestDependencies?.beforeRuntimeProbeCache?.()
        const cached = await cacheRuntimeProbe(deps.db, probeTarget, smoke)
        if (!cached) {
          throw new ConflictError(
            'runtime-probe-stale',
            `runtime '${name}' changed while its probe was running; retry the probe`,
          )
        }
        return c.json({ smoke })
      })
    },
  )
}
