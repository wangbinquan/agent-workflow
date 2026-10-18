// Event delivery accepts only the actual platform worker's signed identity.
import { expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import {
  createCrewStationSourceTokenVerifier,
  crewStationPlatformSourceAudiences,
} from '@/modules/identity-access/infrastructure/crewstation/crewStationSourceToken'
import { createCrewStationIdentityTokenVerifier } from '@/modules/identity-access/infrastructure/crewstation/crewStationIdentityToken'

test('platform cs-events source and user identity tokens are not interchangeable', async () => {
  const pair = await generateKeyPair('RS256'),
    jwk = await exportJWK(pair.publicKey)
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'key', alg: 'RS256' }] })
  const audience = 'service:aw/aw',
    jwksUrl = 'https://platform.invalid/jwks'
  const source = createCrewStationSourceTokenVerifier({
    keys,
    audience,
    jwksUrl,
    source: { project: 'platform', service: 'cs-events' },
  })
  const user = createCrewStationIdentityTokenVerifier({ keys, audience, jwksUrl })
  const token = (overrides: Record<string, unknown> = {}) =>
    new SignJWT({
      iss: 'crewstation',
      aud: audience,
      sub: 'service:platform/cs-events',
      cs_kind: 'platform',
      cs_project: 'platform',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key' })
      .sign(pair.privateKey)
  const valid = await token()
  expect(await source.verify(valid)).toBe(true)
  expect(await user.verify(valid)).toBeNull()
  const browser = await token({ sub: 'user:owner', cs_kind: 'user' })
  expect(await source.verify(browser)).toBe(false)
  expect(await user.verify(browser)).not.toBeNull()
  for (const invalid of [
    { aud: 'service:elsewhere/app' },
    { iss: 'elsewhere' },
    { cs_kind: 'service' },
    { sub: 'service:code-host/gitlab' },
    { sub: 'service:platform/cs-api' },
    { cs_project: 'other' },
    { exp: 1 },
  ])
    expect(await source.verify(await token(invalid))).toBe(false)
  expect(await source.verify('unsigned')).toBe(false)
})

// RFC-370 hosted acceptance (2026-10-18): CrewStation's gateway names a
// platform caller's target by its service-domain host, so a real `cs-events`
// delivery carries `service:platform-caller:<service>.<domain>`. Accepting
// only the `project/service` form refused every delivery with 401.
test('the platform caller audience of this service is accepted, another service host is not', async () => {
  const pair = await generateKeyPair('RS256'),
    jwk = await exportJWK(pair.publicKey)
  const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: 'key', alg: 'RS256' }] })
  const audiences = crewStationPlatformSourceAudiences({
    project: 'aw',
    service: 'aw',
    serviceDomain: 'svc.cs.internal',
  })
  expect(audiences).toEqual(['service:aw/aw', 'service:platform-caller:aw.svc.cs.internal'])
  const source = createCrewStationSourceTokenVerifier({
    keys,
    audience: audiences,
    jwksUrl: 'https://platform.invalid/jwks',
    source: { project: 'platform', service: 'cs-events' },
  })
  const token = (aud: string) =>
    new SignJWT({
      iss: 'crewstation',
      aud,
      sub: 'service:platform/cs-events',
      cs_kind: 'platform',
      cs_project: 'platform',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key' })
      .sign(pair.privateKey)
  expect(await source.verify(await token('service:platform-caller:aw.svc.cs.internal'))).toBe(true)
  expect(await source.verify(await token('service:aw/aw'))).toBe(true)
  expect(await source.verify(await token('service:platform-caller:other.svc.cs.internal'))).toBe(
    false,
  )
  expect(
    crewStationPlatformSourceAudiences({ project: 'aw', service: 'aw', serviceDomain: null }),
  ).toEqual(['service:aw/aw'])
})
