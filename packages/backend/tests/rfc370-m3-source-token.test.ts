// Event delivery accepts only the actual platform worker's signed identity.
import { expect, test } from 'bun:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createCrewStationSourceTokenVerifier } from '@/modules/identity-access/infrastructure/crewstation/crewStationSourceToken'
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
