#!/usr/bin/env bun
// Tiny mock OIDC IdP for RFC-036 end-to-end testing. Not for production.
//
// Exposes:
//   GET  /.well-known/openid-configuration   discovery metadata
//   GET  /authorize?client_id&redirect_uri&state&code_challenge&...
//        renders a tiny HTML page with "Sign in as <user>" buttons; on
//        click it redirects to redirect_uri with ?code=<one-time>&state=<...>
//   POST /token                              accepts code + client_id +
//        client_secret + code_verifier; returns { access_token, id_token,
//        token_type, expires_in }; id_token is RS256-signed with the
//        per-process key.
//   GET  /jwks.json                          returns the public RSA key
//        in JWK form so the daemon can verify id_tokens.
//
// Run:
//   bun run scripts/mock-oidc.ts [--port 9001]
// Then in /settings → Authentication add a provider with:
//   issuerUrl    = http://localhost:9001
//   clientId     = mock-client
//   clientSecret = mock-secret
//   scopes       = openid profile email
//   provisioning = auto   (so any IdP login auto-creates a local user)
//   enabled      = on

import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose'
import { createHash } from 'node:crypto'

const PORT = Number(getArg('--port') ?? '9001')
const ISSUER = `http://localhost:${PORT}`
const CLIENT_ID = 'mock-client'
const CLIENT_SECRET = 'mock-secret'

interface KeyState {
  privateKey: KeyLike
  publicJwk: JWK
  kid: string
}

const ks = await initKeys()
console.log(`[mock-oidc] kid=${ks.kid} issuer=${ISSUER}`)

interface PendingCode {
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  state: string
  nonce: string
  sub: string
  email: string
  name: string
  expiresAt: number
}

const codes = new Map<string, PendingCode>()
const CODE_TTL_MS = 5 * 60 * 1000

const SEED_USERS = [
  { sub: 'mock-alice', email: 'alice@mock.test', name: 'Alice (mock)' },
  { sub: 'mock-bob', email: 'bob@mock.test', name: 'Bob (mock)' },
  { sub: 'mock-carol', email: 'carol@corp.test', name: 'Carol (mock corp)' },
]

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    const path = url.pathname
    console.log(`[mock-oidc] ${req.method} ${path}${url.search}`)
    try {
      if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
        return jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks.json`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'profile', 'email'],
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
          code_challenge_methods_supported: ['S256'],
        })
      }
      if (req.method === 'GET' && path === '/jwks.json') {
        return jsonResponse({ keys: [ks.publicJwk] })
      }
      if (req.method === 'GET' && path === '/authorize') return handleAuthorize(url)
      if (req.method === 'POST' && path === '/authorize') return handleAuthorizeSubmit(req)
      if (req.method === 'POST' && path === '/token') return handleToken(req)
      return new Response('not found', { status: 404 })
    } catch (err) {
      console.error('[mock-oidc] error', err)
      return new Response(String(err), { status: 500 })
    }
  },
})

console.log(`[mock-oidc] listening on ${server.url}`)
console.log(`[mock-oidc] CLIENT_ID=${CLIENT_ID} CLIENT_SECRET=${CLIENT_SECRET}`)

// ---------------------------------------------------------------------------

async function initKeys(): Promise<KeyState> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { modulusLength: 2048 })
  const publicJwk = await exportJWK(publicKey)
  const kid = 'mock-key-1'
  publicJwk.kid = kid
  publicJwk.alg = 'RS256'
  publicJwk.use = 'sig'
  return { privateKey, publicJwk, kid }
}

function handleAuthorize(url: URL): Response {
  const params = Object.fromEntries(url.searchParams.entries())
  const required = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge']
  for (const k of required) {
    if (!params[k]) return new Response(`missing ${k}`, { status: 400 })
  }
  if (params.client_id !== CLIENT_ID) {
    return new Response(`unknown client_id: ${params.client_id}`, { status: 400 })
  }
  if (params.response_type !== 'code') {
    return new Response(`unsupported response_type: ${params.response_type}`, { status: 400 })
  }
  if ((params.code_challenge_method ?? 'plain') !== 'S256') {
    return new Response(`unsupported code_challenge_method: ${params.code_challenge_method}`, {
      status: 400,
    })
  }
  // Render a tiny HTML picker.
  const userButtons = SEED_USERS.map(
    (u) => `
      <form method="POST" action="/authorize" class="user">
        <input type="hidden" name="sub" value="${escape(u.sub)}" />
        <input type="hidden" name="email" value="${escape(u.email)}" />
        <input type="hidden" name="name" value="${escape(u.name)}" />
        ${Object.entries(params)
          .map(([k, v]) => `<input type="hidden" name="${escape(k)}" value="${escape(v)}" />`)
          .join('\n')}
        <button type="submit">${escape(u.name)} (${escape(u.email)})</button>
      </form>`,
  ).join('\n')
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>mock-oidc · sign in</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;background:#f6f7f9;color:#1f2328}
  h1{font-size:18px;margin:0 0 8px}
  p{color:#6b7280;font-size:13px}
  .user button{display:block;width:100%;padding:14px;margin:10px 0;border:1px solid #d0d7de;border-radius:8px;background:#fff;font-size:14px;cursor:pointer;text-align:left}
  .user button:hover{border-color:#2f6feb;background:#f0f5ff}
  details{margin-top:24px;color:#6b7280;font-size:12px}
  code{background:#eef0f3;padding:1px 4px;border-radius:3px}
</style></head><body>
<h1>mock-oidc · choose a user</h1>
<p>This is a local test IdP for RFC-036. Picking a button signs you in as that mock user and redirects back to the agent-workflow daemon.</p>
${userButtons}
<details><summary>request details</summary><pre>${escape(JSON.stringify(params, null, 2))}</pre></details>
</body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}

async function handleAuthorizeSubmit(req: Request): Promise<Response> {
  const form = await req.formData()
  const params: Record<string, string> = {}
  for (const [k, v] of form.entries()) {
    if (typeof v === 'string') params[k] = v
  }
  const code = randomId()
  codes.set(code, {
    clientId: params.client_id!,
    redirectUri: params.redirect_uri!,
    codeChallenge: params.code_challenge!,
    codeChallengeMethod: params.code_challenge_method ?? 'plain',
    state: params.state!,
    nonce: params.nonce ?? '',
    sub: params.sub!,
    email: params.email!,
    name: params.name!,
    expiresAt: Date.now() + CODE_TTL_MS,
  })
  const back = new URL(params.redirect_uri!)
  back.searchParams.set('code', code)
  back.searchParams.set('state', params.state!)
  return new Response(null, { status: 302, headers: { location: back.toString() } })
}

async function handleToken(req: Request): Promise<Response> {
  const form = await req.formData()
  const code = String(form.get('code') ?? '')
  const clientId = String(form.get('client_id') ?? '')
  const clientSecret = String(form.get('client_secret') ?? '')
  const codeVerifier = String(form.get('code_verifier') ?? '')
  const redirectUri = String(form.get('redirect_uri') ?? '')

  const entry = codes.get(code)
  if (!entry) return jsonResponse({ error: 'invalid_grant' }, 400)
  codes.delete(code)
  if (entry.expiresAt < Date.now()) return jsonResponse({ error: 'expired_grant' }, 400)
  if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET) {
    return jsonResponse({ error: 'invalid_client' }, 401)
  }
  if (redirectUri !== entry.redirectUri) {
    return jsonResponse({ error: 'redirect_uri_mismatch' }, 400)
  }
  // PKCE verify
  const expectedChallenge = base64url(createHash('sha256').update(codeVerifier).digest())
  if (expectedChallenge !== entry.codeChallenge) {
    return jsonResponse({ error: 'pkce_mismatch' }, 400)
  }
  const now = Math.floor(Date.now() / 1000)
  const idToken = await new SignJWT({
    nonce: entry.nonce,
    email: entry.email,
    email_verified: true,
    name: entry.name,
    preferred_username: entry.sub,
  })
    .setProtectedHeader({ alg: 'RS256', kid: ks.kid })
    .setIssuer(ISSUER)
    .setSubject(entry.sub)
    .setAudience(clientId)
    .setIssuedAt(now)
    .setExpirationTime(now + 600)
    .sign(ks.privateKey)
  return jsonResponse({
    access_token: randomId(),
    token_type: 'Bearer',
    expires_in: 3600,
    id_token: idToken,
    scope: 'openid profile email',
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function randomId(): string {
  return base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(24))))
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

function getArg(name: string): string | null {
  const i = process.argv.indexOf(name)
  if (i < 0) return null
  return process.argv[i + 1] ?? null
}
