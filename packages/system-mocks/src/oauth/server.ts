import { OidcMock } from '../oidc/server'

/**
 * Creates the standalone OAuth 2.0 authorization server.
 *
 * OAuth and OIDC deliberately have separate issuers, keys, users, tokens,
 * request journals and control state. The shared protocol implementation only
 * avoids duplicating Authorization Code, PKCE and token-endpoint mechanics.
 */
export async function createOauthMock(issuer: () => string): Promise<OidcMock> {
  return await OidcMock.create(issuer, {
    defaultTokenMode: 'access-token-only',
    protocol: 'oauth',
  })
}
