import { createHash, randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'

import { writeJson, writeText } from '../core/http'
import type { MockOidcTokenMode, MockOidcUser } from '../types'

export const MOCK_OIDC_CLIENT_ID = 'mock-client'
export const MOCK_OIDC_CLIENT_SECRET = 'mock-secret'

interface PendingCode {
  clientId: string
  redirectUri: string
  codeChallenge: string
  nonce: string
  user: MockOidcUser
  expiresAt: number
}

interface AccessToken {
  user: MockOidcUser
  clientId: string
  active: boolean
  expiresAt: number
}

type IdentityProtocol = 'oauth' | 'oidc'

export class OidcMock {
  readonly #privateKey: CryptoKey
  readonly #publicJwk: JWK
  readonly #codes = new Map<string, PendingCode>()
  readonly #tokens = new Map<string, AccessToken>()
  #users: MockOidcUser[]
  #tokenMode: MockOidcTokenMode
  readonly #defaultTokenMode: MockOidcTokenMode
  readonly #protocol: IdentityProtocol
  readonly #issuer: () => string

  private constructor(input: {
    privateKey: CryptoKey
    publicJwk: JWK
    issuer: () => string
    users: MockOidcUser[]
    defaultTokenMode: MockOidcTokenMode
    protocol: IdentityProtocol
  }) {
    this.#privateKey = input.privateKey
    this.#publicJwk = input.publicJwk
    this.#issuer = input.issuer
    this.#users = structuredClone(input.users)
    this.#defaultTokenMode = input.defaultTokenMode
    this.#tokenMode = input.defaultTokenMode
    this.#protocol = input.protocol
  }

  static async create(
    issuer: () => string,
    options: {
      defaultTokenMode?: MockOidcTokenMode
      protocol?: IdentityProtocol
    } = {},
  ): Promise<OidcMock> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
    const publicJwk = await exportJWK(publicKey)
    publicJwk.kid = 'system-mock-key-1'
    publicJwk.alg = 'RS256'
    publicJwk.use = 'sig'
    return new OidcMock({
      issuer,
      privateKey,
      publicJwk,
      users: defaultOidcUsers(),
      defaultTokenMode: options.defaultTokenMode ?? 'id-token',
      protocol: options.protocol ?? 'oidc',
    })
  }

  reset(): void {
    this.#codes.clear()
    this.#tokens.clear()
    this.#users = defaultOidcUsers()
    this.#tokenMode = this.#defaultTokenMode
  }

  configure(input: { users?: MockOidcUser[]; tokenMode?: MockOidcTokenMode }): void {
    if (input.users !== undefined) this.#users = structuredClone(input.users)
    if (input.tokenMode !== undefined) this.#tokenMode = input.tokenMode
  }

  snapshot(): { users: MockOidcUser[]; tokenMode: MockOidcTokenMode } {
    return { users: structuredClone(this.#users), tokenMode: this.#tokenMode }
  }

  async handle(input: {
    request: IncomingMessage
    response: ServerResponse
    url: URL
    body: Buffer
    routePrefix?: string
  }): Promise<boolean> {
    const issuer = this.#issuer()
    const path = input.url.pathname.slice((input.routePrefix ?? '/oidc').length) || '/'
    if (
      input.request.method === 'GET' &&
      (path === '/.well-known/openid-configuration' ||
        path === '/.well-known/oauth-authorization-server')
    ) {
      if (path === '/.well-known/openid-configuration' && this.#protocol === 'oauth') return false
      writeJson(input.response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        userinfo_endpoint: `${issuer}/userinfo`,
        jwks_uri: `${issuer}/jwks.json`,
        introspection_endpoint: `${issuer}/introspect`,
        revocation_endpoint: `${issuer}/revoke`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
        scopes_supported:
          this.#protocol === 'oidc'
            ? ['openid', 'profile', 'email', 'offline_access']
            : ['profile', 'email', 'offline_access'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
        ...(this.#protocol === 'oidc'
          ? {
              subject_types_supported: ['public'],
              id_token_signing_alg_values_supported: ['RS256'],
              end_session_endpoint: `${issuer}/logout`,
            }
          : {}),
      })
      return true
    }
    if (input.request.method === 'GET' && path === '/jwks.json') {
      writeJson(input.response, 200, { keys: [this.#publicJwk] })
      return true
    }
    if (input.request.method === 'GET' && path === '/authorize') {
      this.#authorizePage(input.response, input.url)
      return true
    }
    if (input.request.method === 'POST' && path === '/authorize') {
      this.#authorizeSubmit(input.response, formRecord(input.body))
      return true
    }
    if (input.request.method === 'POST' && path === '/token') {
      await this.#token(input.request, input.response, formRecord(input.body))
      return true
    }
    if (
      (input.request.method === 'GET' || input.request.method === 'POST') &&
      path === '/userinfo'
    ) {
      this.#userinfo(input.request, input.response, input.body)
      return true
    }
    if (input.request.method === 'POST' && path === '/introspect') {
      const token = formRecord(input.body).token ?? ''
      const entry = this.#tokens.get(token)
      writeJson(input.response, 200, {
        active: entry?.active === true && entry.expiresAt > Date.now(),
        ...(entry === undefined
          ? {}
          : {
              client_id: entry.clientId,
              sub: entry.user.sub,
              username: entry.user.preferredUsername ?? entry.user.sub,
              exp: Math.floor(entry.expiresAt / 1000),
            }),
      })
      return true
    }
    if (input.request.method === 'POST' && path === '/revoke') {
      const token = formRecord(input.body).token ?? ''
      const entry = this.#tokens.get(token)
      if (entry !== undefined) entry.active = false
      input.response.writeHead(200)
      input.response.end()
      return true
    }
    if (input.request.method === 'GET' && path === '/logout') {
      const redirect = input.url.searchParams.get('post_logout_redirect_uri')
      if (redirect !== null) {
        input.response.writeHead(302, { location: redirect })
        input.response.end()
      } else {
        writeText(input.response, 200, 'signed out')
      }
      return true
    }
    return false
  }

  #authorizePage(response: ServerResponse, url: URL): void {
    const required = ['client_id', 'redirect_uri', 'response_type', 'state']
    for (const key of required) {
      if (!url.searchParams.has(key)) {
        writeText(response, 400, `missing ${key}`)
        return
      }
    }
    if (url.searchParams.get('client_id') !== MOCK_OIDC_CLIENT_ID) {
      writeText(response, 400, 'unknown client_id')
      return
    }
    if (url.searchParams.get('response_type') !== 'code') {
      writeText(response, 400, 'unsupported response_type')
      return
    }
    const hidden = [...url.searchParams.entries()]
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`,
      )
      .join('')
    const forms = this.#users
      .map(
        (user) => `<form method="post" action="${htmlEscape(this.#issuer())}/authorize">
          ${hidden}<input type="hidden" name="mock_sub" value="${htmlEscape(user.sub)}">
          <button type="submit" data-testid="oidc-user-${htmlEscape(user.sub)}">${htmlEscape(user.name)} (${htmlEscape(user.email)})</button>
        </form>`,
      )
      .join('\n')
    writeText(
      response,
      200,
      `<!doctype html><html><head><meta charset="utf-8"><title>System mock identity provider</title></head><body><h1>Choose a mock identity</h1>${forms}</body></html>`,
      'text/html; charset=utf-8',
    )
  }

  #authorizeSubmit(response: ServerResponse, form: Record<string, string>): void {
    const user = this.#users.find((candidate) => candidate.sub === form.mock_sub)
    if (
      user === undefined ||
      form.client_id !== MOCK_OIDC_CLIENT_ID ||
      form.redirect_uri === undefined
    ) {
      writeJson(response, 400, { error: 'invalid_request' })
      return
    }
    const code = randomId()
    this.#codes.set(code, {
      clientId: form.client_id,
      redirectUri: form.redirect_uri,
      codeChallenge: form.code_challenge ?? '',
      nonce: form.nonce ?? '',
      user,
      expiresAt: Date.now() + 5 * 60_000,
    })
    const redirect = new URL(form.redirect_uri)
    redirect.searchParams.set('code', code)
    redirect.searchParams.set('state', form.state ?? '')
    response.writeHead(302, { location: redirect.toString() })
    response.end()
  }

  async #token(
    request: IncomingMessage,
    response: ServerResponse,
    form: Record<string, string>,
  ): Promise<void> {
    const basic = basicCredentials(request.headers.authorization)
    const clientId = basic?.username ?? form.client_id ?? ''
    const clientSecret = basic?.password ?? form.client_secret ?? ''
    if (clientId !== MOCK_OIDC_CLIENT_ID || clientSecret !== MOCK_OIDC_CLIENT_SECRET) {
      writeJson(response, 401, { error: 'invalid_client' })
      return
    }
    if (form.grant_type === 'client_credentials') {
      const user = this.#users[0]
      if (user === undefined) {
        writeJson(response, 400, { error: 'invalid_grant' })
        return
      }
      await this.#writeTokens(response, user, clientId)
      return
    }
    if (form.grant_type === 'refresh_token') {
      const entry = this.#tokens.get(form.refresh_token ?? '')
      if (entry === undefined || !entry.active) {
        writeJson(response, 400, { error: 'invalid_grant' })
        return
      }
      await this.#writeTokens(response, entry.user, clientId)
      return
    }
    const code = this.#codes.get(form.code ?? '')
    if (code === undefined || code.expiresAt < Date.now()) {
      writeJson(response, 400, { error: 'invalid_grant' })
      return
    }
    this.#codes.delete(form.code ?? '')
    if (code.clientId !== clientId || code.redirectUri !== form.redirect_uri) {
      writeJson(response, 400, { error: 'invalid_grant' })
      return
    }
    if (code.codeChallenge.length > 0) {
      const challenge = createHash('sha256')
        .update(form.code_verifier ?? '')
        .digest('base64url')
      if (challenge !== code.codeChallenge) {
        writeJson(response, 400, { error: 'invalid_grant', error_description: 'PKCE mismatch' })
        return
      }
    }
    await this.#writeTokens(response, code.user, clientId, code.nonce)
  }

  async #writeTokens(
    response: ServerResponse,
    user: MockOidcUser,
    clientId: string,
    nonce = '',
  ): Promise<void> {
    const accessToken = randomId()
    const expiresAt = Date.now() + 60 * 60_000
    this.#tokens.set(accessToken, { user, clientId, active: true, expiresAt })
    const refreshToken = randomId()
    this.#tokens.set(refreshToken, {
      user,
      clientId,
      active: true,
      expiresAt: Date.now() + 86_400_000,
    })
    const now = Math.floor(Date.now() / 1000)
    const idToken = await new SignJWT(userClaims(user, { nonce }))
      .setProtectedHeader({ alg: 'RS256', kid: this.#publicJwk.kid })
      .setIssuer(this.#issuer())
      .setSubject(user.sub)
      .setAudience(clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(this.#privateKey)
    writeJson(response, 200, {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope:
        this.#protocol === 'oidc'
          ? 'openid profile email offline_access'
          : 'profile email offline_access',
      ...(this.#protocol === 'oidc' && this.#tokenMode === 'id-token' ? { id_token: idToken } : {}),
    })
  }

  #userinfo(request: IncomingMessage, response: ServerResponse, body: Buffer): void {
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
    let bodyToken = ''
    if (body.length > 0) {
      const contentType = request.headers['content-type'] ?? ''
      if (contentType.includes('application/json')) {
        const parsed = JSON.parse(body.toString('utf8')) as { access_token?: string }
        bodyToken = parsed.access_token ?? ''
      } else {
        bodyToken = formRecord(body).access_token ?? ''
      }
    }
    const entry = this.#tokens.get(bearer ?? bodyToken)
    if (entry === undefined || !entry.active || entry.expiresAt <= Date.now()) {
      writeJson(response, 401, { error: 'invalid_token' }, { 'www-authenticate': 'Bearer' })
      return
    }
    writeJson(response, 200, { sub: entry.user.sub, ...userClaims(entry.user) })
  }
}

function defaultOidcUsers(): MockOidcUser[] {
  return [
    {
      sub: 'mock-alice',
      email: 'alice@mock.test',
      name: 'Alice Mock',
      preferredUsername: 'alice',
      emailVerified: true,
    },
    {
      sub: 'mock-bob',
      email: 'bob@mock.test',
      name: 'Bob Mock',
      preferredUsername: 'bob',
      emailVerified: true,
    },
  ]
}

function userClaims(
  user: MockOidcUser,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    email: user.email,
    email_verified: user.emailVerified ?? true,
    name: user.name,
    preferred_username: user.preferredUsername ?? user.sub,
    ...user.claims,
    ...extra,
  }
}

function formRecord(body: Buffer): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body.toString('utf8')).entries())
}

function basicCredentials(
  header: string | undefined,
): { username: string; password: string } | null {
  const encoded = /^Basic\s+(.+)$/i.exec(header ?? '')?.[1]
  if (encoded === undefined) return null
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return null
  return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

function randomId(): string {
  return randomBytes(24).toString('base64url')
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === '&') return '&amp;'
    if (character === '<') return '&lt;'
    if (character === '>') return '&gt;'
    if (character === '"') return '&quot;'
    return '&#39;'
  })
}
