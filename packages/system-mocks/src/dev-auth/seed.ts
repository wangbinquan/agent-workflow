// Seeder behind the dev one-click login page.
//
// What it puts into the dev database, all of it idempotent and all of it
// labelled `[dev]`:
//
//   * one password admin (`dev_seed_admin`) — the only account the seeder needs
//     credentials for. It exists because registering an identity provider is
//     `oidc:configure` and setting someone's role is `users:write`, and after
//     bootstrap completes the daemon token authenticates nothing (RFC-221,
//     backend/src/auth/session.ts). Created through the daemon's own CLI, which
//     writes through the real identity-access services rather than raw SQL.
//   * one OIDC provider row pointing at the mock IdP this package serves.
//   * four accounts — one per platform role — provisioned by REALLY walking the
//     authorization-code flow, then patched to their target role. Provisioning
//     always lands `oidcDefaultRole` (guest|user only, see db/schema.ts), so the
//     patch is what makes "one click = exactly this role" true from click one.
//
// Re-running is cheap and self-healing: existing identities resolve to the same
// accounts, and a role someone changed by hand mid-session is put back.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { MOCK_OIDC_CLIENT_ID, MOCK_OIDC_CLIENT_SECRET } from '../oidc/server'
import {
  api,
  apiRaw,
  changePassword,
  createProvider,
  listProviders,
  login,
  me,
  patchProvider,
  patchUserRole,
  type OidcProviderView,
} from './daemon'
import { DEV_ROLES, type DevRoleKey, type DevRoleSpec } from './roles'

export const DEV_PROVIDER_SLUG = 'dev-roles'
export const DEV_SEED_ADMIN_USERNAME = 'dev_seed_admin'

export interface CliResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export type CliRunner = (args: string[]) => Promise<CliResult>

export interface SeedDevAuthInput {
  readonly home: string
  readonly baseUrl: string
  /** Issuer of the mock IdP served by this process, e.g. http://127.0.0.1:7460/oidc */
  readonly issuerUrl: string
  readonly runCli: CliRunner
  readonly log?: (message: string) => void
}

export interface SeededRole {
  readonly key: DevRoleKey
  readonly username: string
  readonly userId: string
  readonly displayName: string
}

export interface DevAuthSeedResult {
  readonly providerSlug: string
  readonly providerId: string
  readonly adminUsername: string
  readonly roles: readonly SeededRole[]
  readonly seededAt: number
}

interface StoredCredentials {
  username: string
  password: string
}

function credentialsPath(home: string): string {
  return join(home, '.dev-auth.json')
}

function readCredentials(home: string): StoredCredentials | null {
  const path = credentialsPath(home)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredCredentials>
    if (typeof parsed.username !== 'string' || typeof parsed.password !== 'string') return null
    return { username: parsed.username, password: parsed.password }
  } catch {
    return null
  }
}

function writeCredentials(home: string, credentials: StoredCredentials): void {
  const path = credentialsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows has no POSIX mode; the file still lives inside the private home.
  }
}

export function generatePassword(): string {
  // 32 base64url chars — comfortably inside the schema's 8..256 window and not
  // something a person will be tempted to reuse anywhere real.
  return `dev-${randomBytes(24).toString('base64url')}`
}

/**
 * Resolve a session for the seed admin, creating (or repairing) the account
 * through the daemon CLI when the stored credentials no longer work.
 */
export async function ensureSeedAdminSession(input: {
  readonly home: string
  readonly baseUrl: string
  readonly runCli: CliRunner
  readonly log?: (message: string) => void
}): Promise<{ token: string; username: string }> {
  const stored = readCredentials(input.home)
  if (stored !== null) {
    const existing = await login(input.baseUrl, stored).catch(() => null)
    if (existing !== null && existing.mustChangePassword !== true) {
      return { token: existing.sessionToken, username: stored.username }
    }
  }

  const username = stored?.username ?? DEV_SEED_ADMIN_USERNAME
  const password = generatePassword()
  input.log?.(`ensuring seed administrator '${username}' via the daemon CLI`)

  const created = await input.runCli([
    'user',
    'create',
    '--username',
    username,
    '--admin',
    '--display',
    '[dev] seed admin',
    '--password',
    password,
  ])
  if (created.status !== 0) {
    // Already there (any earlier run, or a hand-made account with that name):
    // rotate its password instead. `reset-password` forces a change on next
    // login, which the change-password call below clears.
    const reset = await input.runCli([
      'user',
      'reset-password',
      '--username',
      username,
      '--new-password',
      password,
    ])
    if (reset.status !== 0) {
      throw new Error(
        `dev-auth: could not provision seed administrator '${username}'.\n` +
          `  create: ${created.stdout.trim() || created.stderr.trim()}\n` +
          `  reset : ${reset.stdout.trim() || reset.stderr.trim()}`,
      )
    }
  }

  const session = await login(input.baseUrl, { username, password })
  let token = session.sessionToken
  let effectivePassword = password
  if (session.mustChangePassword === true) {
    const rotated = generatePassword()
    const result = await changePassword(input.baseUrl, token, { newPassword: rotated })
    effectivePassword = rotated
    if (typeof result.sessionToken === 'string') token = result.sessionToken
  }
  writeCredentials(input.home, { username, password: effectivePassword })
  return { token, username }
}

function providerBody(issuerUrl: string): Record<string, unknown> {
  return {
    slug: DEV_PROVIDER_SLUG,
    displayName: '[dev] 角色一键登录',
    issuerUrl,
    clientId: MOCK_OIDC_CLIENT_ID,
    clientSecret: MOCK_OIDC_CLIENT_SECRET,
    scopes: 'openid profile email',
    provisioning: 'auto',
    allowedEmailDomains: [],
    iconUrl: null,
    enabled: true,
    userinfoRequestStyle: 'get_bearer',
    trustEmailVerified: true,
    usernameClaim: null,
    subjectClaim: null,
  }
}

export async function ensureProvider(input: {
  readonly baseUrl: string
  readonly token: string
  readonly issuerUrl: string
}): Promise<OidcProviderView> {
  const providers = await listProviders(input.baseUrl, input.token)
  const existing = providers.find((provider) => provider.slug === DEV_PROVIDER_SLUG)
  const body = providerBody(input.issuerUrl)
  // The issuer moves whenever the dev port changes, so an existing row is
  // re-pointed rather than left stale — the identities hang off the provider
  // ROW, so patching keeps every seeded account bound.
  return existing === undefined
    ? await createProvider(input.baseUrl, input.token, body)
    : await patchProvider(input.baseUrl, input.token, existing.id, body)
}

export interface AuthorizationHandoff {
  /** Where the IdP wants the browser to go next (the daemon's callback URL). */
  readonly callbackUrl: string
}

/**
 * Mint a login flow for one role and answer the IdP's account chooser on the
 * caller's behalf. Split out from both call sites (seeding and the one-click
 * route) because it is the whole trick: PKCE + state stay the daemon's, and the
 * only thing this adds is "which of the four mock identities".
 */
export async function startRoleAuthorization(input: {
  readonly baseUrl: string
  readonly issuerUrl: string
  readonly role: DevRoleSpec
  readonly postLoginRedirect?: string
}): Promise<AuthorizationHandoff> {
  const started = await api<{ authorizeUrl: string }>({
    baseUrl: input.baseUrl,
    path: `/api/auth/oidc/${DEV_PROVIDER_SLUG}/login/start`,
    method: 'POST',
    body: { postLoginRedirect: input.postLoginRedirect ?? '/agents' },
  })
  const authorizeUrl = new URL(started.authorizeUrl)
  const form = new URLSearchParams(authorizeUrl.searchParams)
  form.set('mock_sub', input.role.sub)
  const response = await fetch(`${input.issuerUrl}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
    redirect: 'manual',
  })
  const location = response.headers.get('location')
  if (response.status !== 302 || location === null) {
    throw new Error(
      `dev-auth: mock IdP refused the ${input.role.key} authorization (${response.status})`,
    )
  }
  return { callbackUrl: location }
}

/** Extract the session token the daemon hands back in the redirect fragment. */
export function sessionTokenFromCallbackLocation(location: string): string | null {
  const match = /#aw_session=(.+)$/.exec(location)
  if (match?.[1] === undefined) return null
  const token = decodeURIComponent(match[1]).trim()
  return token === '' ? null : token
}

/** Walk one role's login end to end against the daemon and return its session. */
async function completeRoleLogin(input: {
  readonly baseUrl: string
  readonly issuerUrl: string
  readonly role: DevRoleSpec
}): Promise<string> {
  const handoff = await startRoleAuthorization(input)
  const callback = new URL(handoff.callbackUrl)
  const response = await apiRaw({
    baseUrl: input.baseUrl,
    path: `${callback.pathname}${callback.search}`,
  })
  const location = response.headers.get('location')
  if (location === null) {
    throw new Error(
      `dev-auth: callback for ${input.role.key} did not redirect (${response.status}): ` +
        `${(await response.text()).slice(0, 300)}`,
    )
  }
  const token = sessionTokenFromCallbackLocation(location)
  if (token === null) {
    throw new Error(`dev-auth: callback for ${input.role.key} carried no session token`)
  }
  return token
}

async function seedRole(input: {
  readonly baseUrl: string
  readonly issuerUrl: string
  readonly adminToken: string
  readonly role: DevRoleSpec
}): Promise<SeededRole> {
  const sessionToken = await completeRoleLogin(input)
  const who = await me(input.baseUrl, sessionToken)
  if (who.user.role !== input.role.key) {
    await patchUserRole(input.baseUrl, input.adminToken, who.user.id, input.role.key)
  }
  // The provisioning session is a side effect of seeding, not something the
  // developer asked for; leaving it live would show up in /users as a phantom
  // login and (RFC-312) as a phantom presence dot.
  await api({
    baseUrl: input.baseUrl,
    path: '/api/auth/logout',
    method: 'POST',
    token: sessionToken,
  }).catch(() => undefined)
  return {
    key: input.role.key,
    username: who.user.username,
    userId: who.user.id,
    displayName: who.user.displayName,
  }
}

export async function seedDevAuth(input: SeedDevAuthInput): Promise<DevAuthSeedResult> {
  const admin = await ensureSeedAdminSession(input)
  input.log?.(`seed administrator ready (${admin.username})`)
  const provider = await ensureProvider({
    baseUrl: input.baseUrl,
    token: admin.token,
    issuerUrl: input.issuerUrl,
  })
  input.log?.(`identity provider '${provider.slug}' → ${provider.issuerUrl}`)
  const roles: SeededRole[] = []
  for (const role of DEV_ROLES) {
    const seeded = await seedRole({
      baseUrl: input.baseUrl,
      issuerUrl: input.issuerUrl,
      adminToken: admin.token,
      role,
    })
    input.log?.(`role ${role.key} → ${seeded.username} (${seeded.userId})`)
    roles.push(seeded)
  }
  return {
    providerSlug: provider.slug,
    providerId: provider.id,
    adminUsername: admin.username,
    roles,
    seededAt: Date.now(),
  }
}
