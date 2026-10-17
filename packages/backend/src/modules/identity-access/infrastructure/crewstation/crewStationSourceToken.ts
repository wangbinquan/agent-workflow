import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { CREWSTATION_ISSUER } from './crewStationIdentityToken'

/** Service-domain authentication is separate from user credentials. Neither a
 * producer token nor a user token may impersonate the platform delivery worker. */
export function createCrewStationSourceTokenVerifier(input: {
  readonly jwksUrl: string
  readonly audience: string
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
  return Object.freeze({
    async verify(token: string): Promise<boolean> {
      try {
        const { payload } = await jwtVerify(token, keys, {
          issuer: CREWSTATION_ISSUER,
          audience: input.audience,
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
