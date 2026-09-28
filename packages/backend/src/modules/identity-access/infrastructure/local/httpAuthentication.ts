import type { AuthRuntime } from '@/auth/application/authRuntime'
import { hashAuthToken } from '@/auth/application/authRuntime'
import { ForbiddenError, UnauthorizedError } from '@/util/errors'
import { createInFlightCoalescer } from '@/util/inFlight'
import type { DirectAuthorityIdentity } from '../../public/participants'
import type { HttpAuthenticationParticipant } from '../../public/participants'
import { resolveIdentity, type DirectAuthorityAdmissionRuntime } from './localCredentialAdmission'

export interface LocalHttpAuthenticationDependencies {
  readonly auth: AuthRuntime
  readonly daemonToken: string
  readonly identityAccess: DirectAuthorityAdmissionRuntime
  readonly now?: () => number
}

// RFC-036 — public paths that bypass multiAuth entirely. The OIDC login flow
// must be reachable before the user has a session token (they are obtaining
// one via the IdP). Each entry is a path prefix; `:slug` segments are
// matched by the literal-then-/ shape, no regex required.
const PUBLIC_PATH_PREFIXES = [
  '/api/auth/oidc/providers', // list enabled providers for the login page
  '/api/auth/oidc/', // /api/auth/oidc/:slug/login/start + /callback
  '/api/auth/login',
] as const

function isPublicAuthPath(path: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((p) => path === p || path.startsWith(p))
}

function isBootstrapDaemonPath(method: string, path: string): boolean {
  return (
    (method === 'GET' && path === '/api/whoami') ||
    (method === 'GET' && path === '/api/auth/bootstrap/status') ||
    (method === 'POST' && path === '/api/auth/bootstrap/admin')
  )
}

export function createLocalHttpAuthentication(
  deps: LocalHttpAuthenticationDependencies,
): HttpAuthenticationParticipant {
  const auth = deps.auth
  const daemonBuf = Buffer.from(deps.daemonToken, 'utf-8')
  // A browser commonly releases a burst of REST requests after one query
  // invalidation. Resolve one credential snapshot for that overlapping burst;
  // settled results are never cached, so the next request re-reads revocation,
  // status, grants and authority revision exactly as before.
  const resolveInFlight = createInFlightCoalescer<
    string,
    { identity: DirectAuthorityIdentity | null; bootstrapRequired: boolean }
  >()
  return Object.freeze({
    async authenticate(request) {
      if (isPublicAuthPath(request.path)) {
        return { kind: 'public' } as const
      }
      const raw = parseLocalBearerHeader(request.header('Authorization'))
      if (!raw) throw new UnauthorizedError()
      const now = deps.now ? deps.now() : Date.now()
      const resolved = await resolveInFlight(hashAuthToken(raw), async () => {
        const identity = await resolveIdentity(auth, raw, daemonBuf, deps.identityAccess, now)
        return {
          identity,
          bootstrapRequired:
            identity?.actor.source === 'daemon' && (await auth.isBootstrapRequired()),
        }
      })
      const identity = resolved.identity
      if (identity === null) throw new UnauthorizedError()
      const actor = identity.actor
      if (
        actor.source === 'daemon' &&
        resolved.bootstrapRequired &&
        !isBootstrapDaemonPath(request.method, request.path)
      ) {
        throw new ForbiddenError(
          'bootstrap-admin-required',
          'create the first administrator before using the application',
          { setupPath: '/setup/admin' },
        )
      }
      return { kind: 'authenticated', identity } as const
    },
  } satisfies HttpAuthenticationParticipant)
}

/** Standalone HTTP credential syntax, also used by the legacy Hono facade. */
export function parseLocalBearerHeader(header: string | null | undefined): string | null {
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S+)\s*$/i)
  if (!match || !match[1]) return null
  return match[1]
}
