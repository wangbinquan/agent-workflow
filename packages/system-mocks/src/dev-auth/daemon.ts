// Minimal HTTP client for the running daemon, used by the dev-auth seeder.
//
// Everything here goes through the daemon's PUBLIC REST surface — the same
// endpoints the frontend calls. Nothing writes SQLite directly: the seeder must
// not be a second implementation of the identity-access invariants, and a
// broken assumption should fail as a 4xx we can print, not as a half-written
// row in the developer's database.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface DaemonInfo {
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly baseUrl: string
}

export class DaemonApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly bodyText: string

  constructor(input: { status: number; code: string | null; bodyText: string; message: string }) {
    super(input.message)
    this.name = 'DaemonApiError'
    this.status = input.status
    this.code = input.code
    this.bodyText = input.bodyText
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Read `${home}/.daemon.info`, mirroring the rule vite's proxy resolver uses:
 * the file only counts when its recorded pid is a live process, otherwise it is
 * a leftover from a daemon that has already exited.
 */
export function readDaemonInfo(home: string): DaemonInfo | null {
  const infoPath = join(home, '.daemon.info')
  if (!existsSync(infoPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(infoPath, 'utf8')) as {
      pid?: number
      host?: string
      port?: number
      url?: string
    }
    if (typeof parsed.pid !== 'number' || !pidAlive(parsed.pid)) return null
    const host = typeof parsed.host === 'string' && parsed.host !== '' ? parsed.host : '127.0.0.1'
    const port = typeof parsed.port === 'number' ? parsed.port : 0
    const baseUrl =
      typeof parsed.url === 'string' && parsed.url !== ''
        ? parsed.url.replace(/\/$/, '')
        : `http://${host}:${port}`
    return { pid: parsed.pid, host, port, baseUrl }
  } catch {
    return null
  }
}

export function readDaemonToken(home: string): string | null {
  const tokenPath = join(home, 'token')
  if (!existsSync(tokenPath)) return null
  const raw = readFileSync(tokenPath, 'utf8').trim()
  return raw === '' ? null : raw
}

export interface WaitForDaemonOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  readonly onWait?: (attempt: number) => void
}

/** Block until the daemon publishes a live `.daemon.info` and answers /health. */
export async function waitForDaemon(
  home: string,
  options: WaitForDaemonOptions = {},
): Promise<DaemonInfo> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 500
  const deadline = Date.now() + timeoutMs
  let attempt = 0
  for (;;) {
    const info = readDaemonInfo(home)
    if (info !== null && (await healthy(info.baseUrl))) return info
    if (Date.now() >= deadline) {
      throw new Error(`dev-auth: daemon did not become ready within ${timeoutMs}ms (home=${home})`)
    }
    options.onWait?.(++attempt)
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`)
    return response.ok
  } catch {
    return false
  }
}

export interface ApiRequestInput {
  readonly baseUrl: string
  readonly path: string
  readonly method?: string
  readonly token?: string | null
  readonly body?: unknown
  /** Return the raw Response instead of parsed JSON (redirect chasing). */
  readonly raw?: boolean
}

async function send(input: ApiRequestInput): Promise<Response> {
  const headers: Record<string, string> = {}
  if (input.token) headers.authorization = `Bearer ${input.token}`
  if (input.body !== undefined) headers['content-type'] = 'application/json'
  return await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method ?? (input.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    redirect: input.raw === true ? 'manual' : 'follow',
  })
}

export async function apiRaw(input: ApiRequestInput): Promise<Response> {
  return await send({ ...input, raw: true })
}

export async function api<T>(input: ApiRequestInput): Promise<T> {
  const response = await send(input)
  const bodyText = await response.text()
  if (!response.ok) {
    let code: string | null = null
    try {
      const parsed = JSON.parse(bodyText) as { code?: unknown; message?: unknown }
      if (typeof parsed.code === 'string') code = parsed.code
    } catch {
      /* non-JSON error body — keep the raw text */
    }
    throw new DaemonApiError({
      status: response.status,
      code,
      bodyText,
      message: `${input.method ?? 'GET'} ${input.path} → ${response.status}${
        code === null ? '' : ` (${code})`
      }: ${bodyText.slice(0, 400)}`,
    })
  }
  if (bodyText === '') return undefined as T
  return JSON.parse(bodyText) as T
}

// ---------------------------------------------------------------------------
// Typed wrappers for the handful of endpoints the seeder touches.
// ---------------------------------------------------------------------------

export interface LoginResult {
  readonly sessionToken: string
  readonly mustChangePassword?: boolean
}

export async function login(
  baseUrl: string,
  credentials: { username: string; password: string },
): Promise<LoginResult> {
  return await api<LoginResult>({
    baseUrl,
    path: '/api/auth/login',
    method: 'POST',
    body: credentials,
  })
}

export async function changePassword(
  baseUrl: string,
  token: string,
  body: { oldPassword?: string; newPassword: string },
): Promise<{ sessionToken?: string }> {
  return await api<{ sessionToken?: string }>({
    baseUrl,
    path: '/api/auth/change-password',
    method: 'POST',
    token,
    body,
  })
}

export interface WhoAmI {
  readonly user: { id: string; username: string; role: string; displayName: string }
  readonly source: string
}

export async function me(baseUrl: string, token: string): Promise<WhoAmI> {
  return await api<WhoAmI>({ baseUrl, path: '/api/auth/me', token })
}

export async function bootstrapRequired(baseUrl: string, daemonToken: string): Promise<boolean> {
  const result = await api<{ required: boolean }>({
    baseUrl,
    path: '/api/auth/bootstrap/status',
    token: daemonToken,
  })
  return result.required
}

export async function bootstrapAdmin(
  baseUrl: string,
  daemonToken: string,
  body: { username: string; displayName: string; password: string },
): Promise<{ id: string }> {
  return await api<{ id: string }>({
    baseUrl,
    path: '/api/auth/bootstrap/admin',
    method: 'POST',
    token: daemonToken,
    body,
  })
}

export interface OidcProviderView {
  readonly id: string
  readonly slug: string
  readonly issuerUrl: string
  readonly enabled: boolean
}

export async function listProviders(
  baseUrl: string,
  token: string,
): Promise<readonly OidcProviderView[]> {
  return await api<OidcProviderView[]>({ baseUrl, path: '/api/oidc/providers', token })
}

export async function createProvider(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<OidcProviderView> {
  return await api<OidcProviderView>({
    baseUrl,
    path: '/api/oidc/providers',
    method: 'POST',
    token,
    body,
  })
}

export async function patchProvider(
  baseUrl: string,
  token: string,
  id: string,
  body: Record<string, unknown>,
): Promise<OidcProviderView> {
  return await api<OidcProviderView>({
    baseUrl,
    path: `/api/oidc/providers/${id}`,
    method: 'PATCH',
    token,
    body,
  })
}

export interface UserView {
  readonly id: string
  readonly username: string
  readonly role: string
  readonly status: string
}

export async function listUsers(baseUrl: string, token: string): Promise<readonly UserView[]> {
  return await api<UserView[]>({ baseUrl, path: '/api/users', token })
}

export async function patchUserRole(
  baseUrl: string,
  token: string,
  userId: string,
  role: string,
): Promise<UserView> {
  return await api<UserView>({
    baseUrl,
    path: `/api/users/${userId}`,
    method: 'PATCH',
    token,
    body: { role },
  })
}

export async function readPublicBaseUrl(baseUrl: string, token: string): Promise<string | null> {
  const config = await api<{ publicBaseUrl?: string }>({ baseUrl, path: '/api/config', token })
  return typeof config.publicBaseUrl === 'string' ? config.publicBaseUrl : null
}

export async function writePublicBaseUrl(
  baseUrl: string,
  token: string,
  publicBaseUrl: string,
): Promise<void> {
  await api({
    baseUrl,
    path: '/api/config',
    method: 'PUT',
    token,
    body: { publicBaseUrl },
  })
}
