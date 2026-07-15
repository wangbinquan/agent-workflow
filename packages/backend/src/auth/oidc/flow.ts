// RFC-036 — in-memory PKCE + state map for OIDC login/link flows. Single
// process; lives for the daemon's lifetime. 5-minute TTL + one-shot consume
// (callback retrieves and deletes the entry in one step) per design.md §5.2.

import { createHash, randomBytes } from 'node:crypto'

export interface PendingFlow {
  providerId: string
  /** Caller-facing redirect_uri sent to the IdP — verified again at callback. */
  redirectUri: string
  codeVerifier: string
  nonce: string
  expiresAt: number
  /** Set when the flow is "link an additional identity to an already-signed-in user". */
  linkUserId?: string
  /** Optional post-login redirect for the SPA (defaults to '/' if unset). */
  postLoginRedirect?: string
}

const TTL_MS = 5 * 60 * 1000
const pending = new Map<string, PendingFlow>()

export function clearPendingFlows(): void {
  pending.clear()
}

export interface StartFlowResult extends PendingFlow {
  state: string
  codeChallenge: string
}

/**
 * Reduce a caller-supplied post-login redirect to a safe same-origin relative
 * path, or undefined. Must start with a single '/' and not '//' or '/\'
 * (protocol-relative / backslash open-redirect tricks). Mirrors the frontend
 * safeInternalRedirect (routes/auth.tsx). startFlow is the ONLY entry point for
 * postLoginRedirect, so applying it there keeps both redirect sites in
 * routes/oidc-auth.ts structurally safe — critical because one of them appends
 * the freshly-minted session token in the URL fragment.
 */
export function sanitizePostLoginRedirect(raw: string | undefined): string | undefined {
  if (raw === undefined || !/^\/(?![/\\])/.test(raw)) return undefined
  return raw
}

export function startFlow(
  providerId: string,
  opts: {
    redirectUri: string
    linkUserId?: string
    postLoginRedirect?: string
    now?: number
  },
): StartFlowResult {
  const state = base64url(randomBytes(32))
  const codeVerifier = base64url(randomBytes(48))
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest())
  const nonce = base64url(randomBytes(16))
  const now = opts.now ?? Date.now()
  const flow: PendingFlow = {
    providerId,
    redirectUri: opts.redirectUri,
    codeVerifier,
    nonce,
    expiresAt: now + TTL_MS,
    linkUserId: opts.linkUserId,
    postLoginRedirect: sanitizePostLoginRedirect(opts.postLoginRedirect),
  }
  pending.set(state, flow)
  return { ...flow, state, codeChallenge }
}

/** Idempotent one-shot consume. Returns null on miss / expired (and deletes anyway). */
export function consumeFlow(state: string, now: number = Date.now()): PendingFlow | null {
  const flow = pending.get(state)
  if (!flow) return null
  pending.delete(state)
  if (flow.expiresAt < now) return null
  return flow
}

/** Hourly GC complement to one-shot consume — sweeps any expired-but-never-consumed entries. */
export function sweepExpiredFlows(now: number = Date.now()): number {
  let removed = 0
  for (const [k, v] of pending) {
    if (v.expiresAt < now) {
      pending.delete(k)
      removed++
    }
  }
  return removed
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
