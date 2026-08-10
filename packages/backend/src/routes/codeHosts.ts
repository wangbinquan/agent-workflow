// RFC-269 — 代码平台连接管理面（凭据 CRUD + 测试连接）。
//
// 与 webhook 端点管理面同档：这是平台基础设施而不是业务资源，写面与读面都走
// `settings:*`（admin），并且 `tokenAccess:'never'` —— 一枚 PAT 既读不到 base
// URL，也改不了 token。token 三形态：写入接受明文、存储 secretBox 密封、读取
// 只回尾 4 位（`tokenHint`）。

import type { Hono } from 'hono'

import {
  CodeHostProviderSchema,
  TestCodeHostConnectionSchema,
  UpsertCodeHostConnectionSchema,
  type CodeHostProvider,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import {
  normalizeCodeHostRejectUnauthorized,
  createCodeHostConnectionsService,
  probeCodeHostConnection,
} from '@/services/codeHost/connections'
import { registerRoute } from '@/routes/registry'
import type { AppDeps } from '@/server'
import { NotFoundError, ValidationError } from '@/util/errors'

function providerOf(raw: string): CodeHostProvider {
  // safeParse 而不是 `as`：RFC-054 W1-7 要求路由层的窄化走 Zod，而不是断言。
  const parsed = CodeHostProviderSchema.safeParse(raw)
  if (!parsed.success) {
    throw new NotFoundError('code-host-provider-unknown', `unknown code host provider '${raw}'`)
  }
  return parsed.data
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

export function mountCodeHostRoutes(app: Hono, deps: AppDeps): void {
  const secretBox = deps.secretBox
  // 对齐 OIDC / webhook 端点的自我跳过：没有密封器就不开凭据面，而不是退化成
  // 明文存储。
  if (!secretBox) return
  const service = createCodeHostConnectionsService({ db: deps.db, secretBox })

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/code-hosts',
      permissions: ['settings:read'],
      tokenAccess: 'never',
      summary: 'List code-host connections (token masked to its last 4 chars)',
    },
    (c) => c.json(service.list()),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/code-hosts/:provider',
      permissions: ['settings:write'],
      tokenAccess: 'never',
      summary: 'Configure a code-host connection (omit token to keep the stored one)',
    },
    async (c) => {
      const provider = providerOf(c.req.param('provider'))
      const parsed = UpsertCodeHostConnectionSchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('code-host-connection-invalid', 'invalid connection body', {
          issues: parsed.error.issues,
        })
      }
      return c.json(
        service.upsert(provider, {
          baseUrl: parsed.data.baseUrl,
          ...(parsed.data.token !== undefined ? { token: parsed.data.token } : {}),
          ...(parsed.data.rejectUnauthorized !== undefined
            ? { rejectUnauthorized: parsed.data.rejectUnauthorized }
            : {}),
          actorUserId: actorOf(c).user.id,
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/code-hosts/:provider',
      permissions: ['settings:write'],
      tokenAccess: 'never',
      summary: 'Remove a code-host connection',
    },
    (c) => {
      const provider = providerOf(c.req.param('provider'))
      const removed = service.remove(provider)
      if (!removed) {
        throw new NotFoundError('code-host-not-configured', `${provider} is not configured`)
      }
      return c.json({ ok: true })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/code-hosts/:provider/test',
      permissions: ['settings:write'],
      tokenAccess: 'never',
      summary: 'Test a code-host connection against its identity endpoint',
    },
    async (c) => {
      const provider = providerOf(c.req.param('provider'))
      const parsed = TestCodeHostConnectionSchema.safeParse(
        await safeJson(c.req.raw).catch(() => ({})),
      )
      const body = parsed.success ? parsed.data : {}
      // 未传的字段回落到已保存的值，所以「先保存再测」与「边填边测」都成立。
      const stored = service.resolve(provider)
      const baseUrl = body.baseUrl ?? stored?.baseUrl
      const token = body.token ?? stored?.token
      const rejectUnauthorized = normalizeCodeHostRejectUnauthorized(
        provider,
        body.rejectUnauthorized ?? stored?.rejectUnauthorized,
      )
      if (baseUrl === undefined || token === undefined) {
        throw new ValidationError(
          'code-host-not-configured',
          `${provider} has no stored credential; provide baseUrl and token to test`,
        )
      }
      const result = await probeCodeHostConnection({
        provider,
        baseUrl,
        token,
        rejectUnauthorized,
        ...(deps.codeHostFetch !== undefined ? { fetchImpl: deps.codeHostFetch } : {}),
      })
      // 只有在「测的就是已保存的那套」时才回写结果 —— 否则一次对着草稿值的
      // 成功探活会给已保存的坏配置盖上绿勾。
      if (
        stored !== null &&
        baseUrl === stored.baseUrl &&
        token === stored.token &&
        rejectUnauthorized === stored.rejectUnauthorized
      ) {
        service.recordTest(provider, result)
      }
      return c.json(result)
    },
  )
}
