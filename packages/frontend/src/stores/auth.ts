// Auth token storage. Token lives in localStorage; UI prompts for it on first
// load via /auth. The daemon prints the token at start; user pastes it in.
//
// Exposed as a tiny event-target so React components can subscribe via
// useSyncExternalStore without pulling in a state-management lib.

const TOKEN_KEY = 'agent-workflow.token'
const BASE_URL_KEY = 'agent-workflow.baseUrl'

// Default to the page's own origin so:
//   - Production (user opens the daemon URL directly): API calls hit the daemon.
//   - Dev (`bun dev` opens Vite at :5174): API calls go through Vite's proxy,
//     which forwards to the daemon's actual port (read from .daemon.info).
// Stored override (BASE_URL_KEY) still wins for remote-daemon setups.
function defaultBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:7456'
  return window.location.origin
}

type Listener = () => void
const listeners = new Set<Listener>()
// Non-secret identity for the currently installed credential. Components use
// this to fence cached resource data and async continuations across account
// switches without copying the credential itself into additional caches.
let authSessionRevision = 0

function emit(): void {
  for (const l of listeners) l()
}

function safeStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null
    return window.localStorage
  } catch {
    return null
  }
}

// RFC-036 — module-init OIDC fragment consumer. The OIDC callback redirects
// the browser to `<postLoginRedirect>#aw_session=<token>`. The token has to
// land in localStorage BEFORE TanStack Router's beforeLoad inspects
// getToken() — otherwise the user is bounced to /auth and the fragment is
// lost. This block runs once when the module is first imported (i.e. at SPA
// bootstrap), so by the time any route hook reads getToken() the token is
// already there. The fragment is stripped from window.history so a reload
// won't replay it.
;(function consumeSessionFragment() {
  if (typeof window === 'undefined') return
  const m = window.location.hash.match(/^#aw_session=(.+)$/)
  if (!m || !m[1]) return
  try {
    const raw = decodeURIComponent(m[1]).trim()
    if (raw.length > 0) {
      safeStorage()?.setItem(TOKEN_KEY, raw)
    }
  } catch {
    // ignore malformed fragments
  }
  // Strip the fragment so refresh doesn't reapply it.
  const { pathname, search } = window.location
  window.history.replaceState(null, '', `${pathname}${search}`)
})()

export function getToken(): string | null {
  return safeStorage()?.getItem(TOKEN_KEY) ?? null
}

export function getAuthSessionRevision(): number {
  return authSessionRevision
}

export function setToken(token: string): void {
  const trimmed = token.trim()
  if (trimmed === '') {
    clearToken()
    return
  }
  const changed = getToken() !== trimmed
  safeStorage()?.setItem(TOKEN_KEY, trimmed)
  if (changed) authSessionRevision += 1
  emit()
}

export function clearToken(): void {
  const changed = getToken() !== null
  safeStorage()?.removeItem(TOKEN_KEY)
  if (changed) authSessionRevision += 1
  emit()
}

export function getBaseUrl(): string {
  return safeStorage()?.getItem(BASE_URL_KEY) ?? defaultBaseUrl()
}

export function setBaseUrl(url: string): void {
  const trimmed = url.trim().replace(/\/$/, '')
  if (trimmed === '' || trimmed === defaultBaseUrl()) {
    safeStorage()?.removeItem(BASE_URL_KEY)
  } else {
    safeStorage()?.setItem(BASE_URL_KEY, trimmed)
  }
  emit()
}

export function subscribeAuth(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const AUTH_DEFAULT_BASE_URL = defaultBaseUrl()
