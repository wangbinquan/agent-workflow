// RFC-321 — session-only self-service code-host push credentials.
//
// The plaintext token exists only in the PUT seal command or one-shot POST
// identity probe. Validation failures deliberately return a generic error
// without serializing Zod issues or request data.

import type { Hono } from 'hono'
import {
  CodeHostProviderSchema,
  PutOwnCodeHostPushCredentialRequestSchema,
  TestOwnCodeHostPushCredentialRequestSchema,
  type CodeHostProvider,
  type OwnCodeHostPushCredentialList,
  type OwnCodeHostPushCredentialSummary,
  type PutOwnCodeHostPushCredentialRequest,
  type TestOwnCodeHostPushCredentialRequest,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import {
  RepositoryTransportCredentialError,
  type OwnRepositoryCredentialSubject,
} from '@/modules/source-control/public/types'
import { registerRoute } from '@/routes/registry'
import { probeCodeHostConnection } from '@/services/codeHost/connections'
import type { AppDeps } from '@/server'
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

const OPERATION_LIMIT_PER_MINUTE = 20
const OPERATION_LIMIT_WINDOW_MS = 60_000

type AccountPersonalCredentialResolution =
  | {
      readonly ok: true
      readonly credential: {
        readonly provider: CodeHostProvider
        readonly baseUrl: string
        readonly token: string
        readonly rejectUnauthorized: boolean
      }
    }
  | {
      readonly ok: false
      readonly code:
        | 'code-host-push-credential-connection-missing'
        | 'code-host-push-credential-stale'
        | 'code-host-push-credential-unavailable'
    }

interface AccountRepositoryTransportCredentials {
  list(subject: OwnRepositoryCredentialSubject): OwnCodeHostPushCredentialList
  put(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: PutOwnCodeHostPushCredentialRequest,
  ): OwnCodeHostPushCredentialSummary
  remove(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
  ): { readonly removed: boolean }
  resolvePersonalForTest(
    subject: OwnRepositoryCredentialSubject,
    provider: CodeHostProvider,
    request: TestOwnCodeHostPushCredentialRequest,
  ): AccountPersonalCredentialResolution
}

export interface AccountRepositoryTransportCredentialRouteDeps {
  readonly credentials: AccountRepositoryTransportCredentials
  readonly currentSubjects: {
    resolveCurrentSubject(userId: string): Promise<{ readonly userId: string } | null>
  }
}

class AccountCredentialOperationLimiter {
  private readonly hits = new Map<string, number[]>()

  allow(userId: string, now = Date.now()): boolean {
    const cutoff = now - OPERATION_LIMIT_WINDOW_MS
    const retained = (this.hits.get(userId) ?? []).filter((hit) => hit >= cutoff)
    if (retained.length >= OPERATION_LIMIT_PER_MINUTE) {
      this.hits.set(userId, retained)
      return false
    }
    retained.push(now)
    this.hits.set(userId, retained)
    return true
  }
}

function providerOf(raw: string): CodeHostProvider {
  const parsed = CodeHostProviderSchema.safeParse(raw)
  if (!parsed.success) {
    throw new NotFoundError('code-host-provider-unknown', `unknown code host provider '${raw}'`)
  }
  return parsed.data
}

function credentialCall<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (!(error instanceof RepositoryTransportCredentialError)) throw error
    if (error.kind === 'validation') throw new ValidationError(error.code, error.message)
    if (error.kind === 'conflict') throw new ConflictError(error.code, error.message)
    throw new NotFoundError(error.code, error.message)
  }
}

async function currentSessionSubject(
  c: Parameters<typeof actorOf>[0],
  currentSubjects: AccountRepositoryTransportCredentialRouteDeps['currentSubjects'],
): Promise<OwnRepositoryCredentialSubject> {
  const actor = actorOf(c)
  if (actor.source !== 'session') {
    throw new ForbiddenError(
      'session-required',
      'code-host push credentials can only be managed by an interactive user session',
    )
  }
  const subject = await currentSubjects.resolveCurrentSubject(actor.user.id)
  if (subject === null) {
    throw new ForbiddenError('account-subject-unavailable', 'the current account is not active')
  }
  return { kind: 'user', userId: subject.userId }
}

function requireOperationBudget(limiter: AccountCredentialOperationLimiter, userId: string): void {
  if (limiter.allow(userId)) return
  throw new DomainError(
    'code-host-push-credential-rate-limited',
    'too many code-host push credential operations; try again later',
    429,
  )
}

export function mountAccountRepositoryTransportCredentialRoutes(
  app: Hono,
  deps: AppDeps,
  routeDeps: AccountRepositoryTransportCredentialRouteDeps,
): void {
  const credentials = routeDeps.credentials
  const limiter = new AccountCredentialOperationLimiter()

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/account/code-host-push-credentials',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'List the current user code-host push credential summaries',
    },
    async (c) =>
      c.json(credentials.list(await currentSessionSubject(c, routeDeps.currentSubjects))),
  )

  registerRoute(
    app,
    {
      method: 'PUT',
      path: '/api/account/code-host-push-credentials/:provider',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Create or replace the current user code-host push credential',
    },
    async (c) => {
      const subject = await currentSessionSubject(c, routeDeps.currentSubjects)
      requireOperationBudget(limiter, subject.userId)
      const provider = providerOf(c.req.param('provider'))
      const parsed = PutOwnCodeHostPushCredentialRequestSchema.safeParse(
        await safeJsonOrEmpty(c.req.raw),
      )
      if (!parsed.success) {
        throw new ValidationError(
          'code-host-push-credential-invalid',
          'invalid code-host push credential body',
        )
      }
      return c.json(credentialCall(() => credentials.put(subject, provider, parsed.data)))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/account/code-host-push-credentials/:provider/test',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Test the current user code-host push credential identity',
    },
    async (c) => {
      const subject = await currentSessionSubject(c, routeDeps.currentSubjects)
      requireOperationBudget(limiter, subject.userId)
      const provider = providerOf(c.req.param('provider'))
      const parsed = TestOwnCodeHostPushCredentialRequestSchema.safeParse(
        await safeJsonOrEmpty(c.req.raw),
      )
      if (!parsed.success) {
        throw new ValidationError(
          'code-host-push-credential-invalid',
          'invalid code-host push credential test body',
        )
      }
      const resolved = credentials.resolvePersonalForTest(subject, provider, parsed.data)
      if (!resolved.ok) {
        const message =
          resolved.code === 'code-host-push-credential-connection-missing'
            ? `${provider} has no configured code-host connection`
            : resolved.code === 'code-host-push-credential-stale'
              ? 'the code-host connection changed; refresh before testing the credential'
              : 'no stored personal credential is available; enter a token before testing'
        if (resolved.code === 'code-host-push-credential-unavailable') {
          throw new ValidationError(resolved.code, message)
        }
        throw new ConflictError(resolved.code, message)
      }
      const credential = resolved.credential
      return c.json(
        await probeCodeHostConnection({
          provider: credential.provider,
          baseUrl: credential.baseUrl,
          token: credential.token,
          rejectUnauthorized: credential.rejectUnauthorized,
          ...(deps.codeHostFetch !== undefined ? { fetchImpl: deps.codeHostFetch } : {}),
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/account/code-host-push-credentials/:provider',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Remove the current user code-host push credential',
    },
    async (c) => {
      const subject = await currentSessionSubject(c, routeDeps.currentSubjects)
      requireOperationBudget(limiter, subject.userId)
      return c.json(
        credentialCall(() => credentials.remove(subject, providerOf(c.req.param('provider')))),
      )
    },
  )
}
