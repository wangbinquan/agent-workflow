// RFC-360: HTTP decoding and response mapping; runtime management owns every use case.
import type { Hono } from 'hono'
import { z } from 'zod'
import { registerRoute } from '@/routes/registry'
import { actorOf } from '@/auth/actor'
import { ValidationError } from '@/util/errors'
import type { RuntimeKind } from '@/modules/runtime-management/public/types'
import type {
  RuntimeDiagnosticCommands,
  RuntimeProfileCommands,
} from '@/modules/runtime-management/public/commands'
import type { RuntimeProfileQueries } from '@/modules/runtime-management/public/queries'

function schemasFor(protocols: readonly RuntimeKind[]) {
  const ProtocolSchema = z.enum(protocols as [RuntimeKind, ...RuntimeKind[]])

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

  return { ProbeBody, CreateBody, UpdateBody, EnabledBody }
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ValidationError('invalid-body', parsed.error.issues.map((i) => i.message).join('; '))
  }
  return parsed.data
}

export interface RuntimesRouteDependencies {
  readonly protocols: readonly RuntimeKind[]
  readonly profiles: RuntimeProfileCommands
  readonly queries: RuntimeProfileQueries
  readonly diagnostics: RuntimeDiagnosticCommands
}

export function mountRuntimesRoutes(app: Hono, deps: RuntimesRouteDependencies): void {
  const { ProbeBody, CreateBody, UpdateBody, EnabledBody } = schemasFor(deps.protocols)
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
      return c.json(await deps.queries.list())
    },
  )
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
      return c.json(await deps.queries.status())
    },
  )
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
      return c.json(await deps.diagnostics.probe({ kind: 'unsaved', ...body }))
    },
  )
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
      return c.json(await deps.profiles.create({ ...body, createdBy: actorOf(c).user.id }), 201)
    },
  )
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
      const body = parseBody(UpdateBody, await c.req.json().catch(() => ({})))
      return c.json(await deps.profiles.update(c.req.param('name'), body))
    },
  )
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
      const body = parseBody(EnabledBody, await c.req.json().catch(() => ({})))
      return c.json(await deps.profiles.setEnabled(c.req.param('name'), body.enabled))
    },
  )
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
      return c.json(await deps.profiles.remove(c.req.param('name')))
    },
  )
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
      return c.json(await deps.diagnostics.probe({ kind: 'registered', name: c.req.param('name') }))
    },
  )
}
