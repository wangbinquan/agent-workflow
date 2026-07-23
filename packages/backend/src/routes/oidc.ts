// RFC-036 — admin-only /api/oidc/providers CRUD + /test endpoint.

import type { Hono } from 'hono'
import {
  CreateOidcProviderBodySchema,
  PatchOidcProviderBodySchema,
  UpdateAuthLoginPolicyBodySchema,
} from '@agent-workflow/shared'
import { requirePermission } from '@/auth/permissions'
import { getAuthLoginPolicy, setPasswordLoginEnabled } from '@/services/authLoginPolicy'
import { createOidcProvidersService, redactedProvider } from '@/services/oidcProviders'
import type { AppDeps } from '@/server'
import { NotFoundError, ValidationError } from '@/util/errors'
import { parseBoolQuery } from '@/util/http'

export function mountOidcRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/oidc/login-policy', requirePermission('oidc:read'), (c) => {
    return c.json(getAuthLoginPolicy(deps.db))
  })

  app.put('/api/oidc/login-policy', requirePermission('oidc:configure'), async (c) => {
    const parsed = UpdateAuthLoginPolicyBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('login-policy-invalid', 'invalid login policy payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(setPasswordLoginEnabled(deps.db, parsed.data.passwordLoginEnabled))
  })

  if (!deps.secretBox) {
    // OIDC requires the secret box. Without it, mounting these routes would
    // panic on first DB write. Skip silently for non-OIDC tests.
    return
  }
  const svc = createOidcProvidersService({ db: deps.db, secretBox: deps.secretBox })

  app.get('/api/oidc/providers', requirePermission('oidc:read'), async (c) => {
    const list = await svc.list()
    return c.json(list.map(redactedProvider))
  })

  app.get('/api/oidc/providers/:id', requirePermission('oidc:read'), async (c) => {
    const p = await svc.findById(c.req.param('id'))
    if (!p) throw new NotFoundError('oidc-provider-not-found', 'provider not found')
    return c.json(redactedProvider(p))
  })

  app.post('/api/oidc/providers', requirePermission('oidc:configure'), async (c) => {
    const parsed = CreateOidcProviderBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('oidc-provider-invalid', 'invalid OIDC provider payload', {
        issues: parsed.error.issues,
      })
    }
    const created = await svc.create(parsed.data)
    return c.json(redactedProvider(created), 201)
  })

  app.patch('/api/oidc/providers/:id', requirePermission('oidc:configure'), async (c) => {
    const parsed = PatchOidcProviderBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('oidc-provider-invalid', 'invalid OIDC provider patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await svc.patch(c.req.param('id'), parsed.data)
    return c.json(redactedProvider(updated))
  })

  app.delete('/api/oidc/providers/:id', requirePermission('oidc:configure'), async (c) => {
    // flag-audit W0：统一布尔解析（此前仅认 'true'——`?force=1` 在相邻 API 生效、
    // 在这里静默变 false）。
    const force = parseBoolQuery(c, 'force', { default: false })
    await svc.remove(c.req.param('id'), force)
    return c.body(null, 204)
  })

  app.post('/api/oidc/providers/:id/test', requirePermission('oidc:configure'), async (c) => {
    const p = await svc.findById(c.req.param('id'))
    if (!p) throw new NotFoundError('oidc-provider-not-found', 'provider not found')
    // RFC-220 — always 200 + ProbeResult: the per-field diagnosis matters
    // most when the config is broken, and a 422 would strip the structured
    // body in the frontend error path (behavior change #6).
    return c.json(await svc.probe(p))
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
