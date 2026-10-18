import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { CREWSTATION_ISSUER, crewStationServiceAudience } from './crewStationIdentityToken'

/**
 * The audiences a platform worker's source token can carry for this service.
 * CrewStation's gateway names the target of a platform caller by its
 * service-domain host (`platform-caller:<service>.<domain>`), not by the
 * `project/service` identity it uses for a business caller: with only the
 * latter accepted, every `cs-events` delivery was refused 401 (RFC-370 hosted
 * acceptance, 2026-10-18). Both still bind the token to this one service.
 */
export function crewStationPlatformSourceAudiences(input: {
  readonly project: string
  readonly service: string
  readonly serviceDomain: string | null
}): readonly string[] {
  return [
    crewStationServiceAudience(input.project, input.service),
    ...(input.serviceDomain === null
      ? []
      : [`service:platform-caller:${input.service}.${input.serviceDomain}`]),
  ]
}

/** Service-domain authentication is separate from user credentials. Neither a
 * producer token nor a user token may impersonate the platform delivery worker. */
export function createCrewStationSourceTokenVerifier(input: {
  readonly jwksUrl: string
  readonly audience: string | readonly string[]
  readonly source: { readonly project: string; readonly service: string }
  readonly keys?: JWTVerifyGetKey
  readonly now?: () => number
}) {
  const keys =
    input.keys ??
    createRemoteJWKSet(new URL(input.jwksUrl), {
      timeoutDuration: 5000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    })
  const audience = typeof input.audience === 'string' ? input.audience : [...input.audience]
  return Object.freeze({
    async verify(token: string): Promise<boolean> {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: CREWSTATION_ISSUER,
          audience,
          requiredClaims: ['sub', 'iat', 'exp'],
          ...(input.now ? { currentDate: new Date(input.now()) } : {}),
        })
        return (
          payload.cs_kind === 'platform' &&
          payload.cs_project === input.source.project &&
          payload.sub === `service:${input.source.project}/${input.source.service}`
        )
      } catch {
        return false
      }
    },
  })
}
