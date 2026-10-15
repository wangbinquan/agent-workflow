// RFC-370 M0 — the CrewStation gateway's signed user identity token.
//
// Every request reaching a hosted service through the user domain carries
// `x-cs-identity-token`, a short-lived JWT the platform signs per request:
// iss `crewstation`, aud `service:<project>/<service>`, sub `user:<uuid>`,
// `cs_kind: user`, plus `name` / `email` when the project forwards them. Keys
// come only from the configured JWKS endpoint, never from the request.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

export const CREWSTATION_IDENTITY_HEADER = 'x-cs-identity-token'
export const CREWSTATION_ISSUER = 'crewstation'
const USER_SUBJECT_PREFIX = 'user:'

export function crewStationServiceAudience(project: string, service: string): string {
  return `service:${project}/${service}`
}

export interface CrewStationIdentityClaims {
  /** `user:<uuid>` — the platform's stable user subject. */
  readonly subject: string
  readonly name: string | null
  readonly email: string | null
  readonly expiresAt: number
}

export interface CrewStationIdentityTokenVerifier {
  /** Null for any token that is not a valid user identity token for this service. */
  verify(token: string): Promise<CrewStationIdentityClaims | null>
}

function optionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function createCrewStationIdentityTokenVerifier(input: {
  readonly jwksUrl: string
  readonly audience: string
  /** Test seam; production fetches and caches the platform's JWKS. */
  readonly keys?: JWTVerifyGetKey
  readonly now?: () => number
}): CrewStationIdentityTokenVerifier {
  const keys =
    input.keys ??
    createRemoteJWKSet(new URL(input.jwksUrl), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    })
  return Object.freeze({
    async verify(token: string) {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: CREWSTATION_ISSUER,
          audience: input.audience,
          requiredClaims: ['sub', 'exp'],
          ...(input.now === undefined ? {} : { currentDate: new Date(input.now()) }),
        })
        const subject = payload.sub ?? ''
        if (payload.cs_kind !== 'user') return null
        if (
          !subject.startsWith(USER_SUBJECT_PREFIX) ||
          subject.length <= USER_SUBJECT_PREFIX.length
        )
          return null
        return {
          subject,
          name: optionalText(payload.name),
          email: optionalText(payload.email),
          expiresAt: (payload.exp ?? 0) * 1000,
        }
      } catch {
        return null
      }
    },
  })
}
