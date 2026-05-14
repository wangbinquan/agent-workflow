// Token auth per design.md §10.2.
// Daemon startup -> ensureTokenFile() reads or generates a 32-byte hex token
// at ~/.agent-workflow/token (chmod 600). Hono middleware accepts either:
//   Authorization: Bearer <token>
// or query param ?token=<token>. All /api/* require it; /health is public.
//
// Comparison is constant-time to avoid timing attacks. Rotating the token
// invalidates all existing sessions (clients must re-read URL from daemon
// stdout or settings page).

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MiddlewareHandler } from 'hono'
import { UnauthorizedError } from '@/util/errors'

const TOKEN_BYTES = 32 // 32 bytes hex = 64-char string

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

/**
 * Read the existing token file, or generate a new one if missing.
 * Always ensures mode 0o600 (some filesystems / umasks ignore the open flag).
 */
export function ensureTokenFile(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    chmodSync(tokenPath, 0o600)
    return readFileSync(tokenPath, 'utf-8').trim()
  }
  return rotateTokenFile(tokenPath)
}

/** Generate a fresh token, overwriting any existing file. */
export function rotateTokenFile(tokenPath: string): string {
  const token = generateToken()
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, token, { mode: 0o600 })
  chmodSync(tokenPath, 0o600)
  return token
}

/**
 * Hono middleware: rejects requests without a valid token.
 * Constant-time comparison via crypto.timingSafeEqual.
 */
export function tokenAuth(expected: string): MiddlewareHandler {
  const expectedBuf = Buffer.from(expected, 'utf-8')
  return async (c, next) => {
    const provided = extractToken(c.req.header('Authorization'), c.req.query('token'))
    if (provided === null || !safeEqual(provided, expectedBuf)) {
      throw new UnauthorizedError()
    }
    await next()
  }
}

function extractToken(
  authHeader: string | undefined,
  queryToken: string | undefined,
): string | null {
  if (queryToken && queryToken.length > 0) return queryToken
  if (authHeader) {
    const m = authHeader.match(/^Bearer\s+(\S+)\s*$/i)
    if (m && m[1] !== undefined) return m[1]
  }
  return null
}

function safeEqual(provided: string, expected: Buffer): boolean {
  const providedBuf = Buffer.from(provided, 'utf-8')
  if (providedBuf.length !== expected.length) return false
  return timingSafeEqual(providedBuf, expected)
}
