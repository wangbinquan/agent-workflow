import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureTokenFile, generateToken, rotateTokenFile, tokenAuth } from '../src/auth/token'
import { statMetadataIsAuthoritative } from '../src/util/fileTrust'
import { Hono } from 'hono'
import { errorHandler } from '../src/util/errors'

describe('token file management', () => {
  let tmp: string
  let tokenPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-token-'))
    tokenPath = join(tmp, 'token')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('generateToken returns 64-char hex string', () => {
    const t = generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ensureTokenFile generates on first call, reads on second', () => {
    expect(existsSync(tokenPath)).toBe(false)
    const first = ensureTokenFile(tokenPath)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(tokenPath)).toBe(true)
    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(first)

    const second = ensureTokenFile(tokenPath)
    expect(second).toBe(first) // stable across reads
  })

  test('ensureTokenFile sets mode 0600', () => {
    ensureTokenFile(tokenPath)
    const mode = statSync(tokenPath).mode & 0o777
    // RFC-254 T32: POSIX mode bits are only meaningful where `stat` is the
    // authority on who can read the file. On Windows `chmod` is a no-op and
    // `stat` answers a synthesized 0o666 for every file — asserting 0o600 there
    // measures nothing and fails for a reason that has nothing to do with the
    // token. Confidentiality on that platform comes from the ACL the per-user
    // app home carries, which is what `doctor`'s secret-file check reports and
    // what the file-trust primitive verifies; the same primitive decides here
    // whether the mode is worth asserting at all.
    if (statMetadataIsAuthoritative(process.platform)) {
      expect(mode).toBe(0o600)
      return
    }
    // The mode is not the guarantee here, so assert what IS true: the file was
    // created, and the platform reports the permissions it always reports —
    // pinning that keeps this branch honest instead of vacuous.
    expect(existsSync(tokenPath)).toBe(true)
    expect(mode).toBe(0o666)
  })

  test('rotateTokenFile overwrites existing token', () => {
    const first = ensureTokenFile(tokenPath)
    const second = rotateTokenFile(tokenPath)
    expect(second).not.toBe(first)
    expect(readFileSync(tokenPath, 'utf-8').trim()).toBe(second)
  })
})

describe('tokenAuth middleware', () => {
  const TOKEN = 'a'.repeat(64) // fixed for tests; real daemon uses generateToken()

  function buildApp(): Hono {
    const app = new Hono()
    app.use('/api/*', tokenAuth(TOKEN))
    app.get('/api/whoami', (c) => c.json({ ok: true }))
    app.get('/health', (c) => c.json({ ok: true }))
    app.onError(errorHandler)
    return app
  }

  test('public route /health works without token', async () => {
    const res = await buildApp().request('/health')
    expect(res.status).toBe(200)
  })

  test('/api/* without token returns 401', async () => {
    const res = await buildApp().request('/api/whoami')
    expect(res.status).toBe(401)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code).toBe('unauthorized')
  })

  test('/api/* with Authorization: Bearer succeeds', async () => {
    const res = await buildApp().request('/api/whoami', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
  })

  test('/api/* with ?token= succeeds', async () => {
    const res = await buildApp().request(`/api/whoami?token=${TOKEN}`)
    expect(res.status).toBe(200)
  })

  test('wrong token is rejected', async () => {
    const res = await buildApp().request('/api/whoami', {
      headers: { Authorization: 'Bearer wrong-token' },
    })
    expect(res.status).toBe(401)
  })

  test('token of correct length but wrong content is rejected', async () => {
    const res = await buildApp().request('/api/whoami', {
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    })
    expect(res.status).toBe(401)
  })

  test('Authorization header without Bearer prefix is rejected', async () => {
    const res = await buildApp().request('/api/whoami', {
      headers: { Authorization: TOKEN },
    })
    expect(res.status).toBe(401)
  })

  test('empty query token is rejected', async () => {
    const res = await buildApp().request('/api/whoami?token=')
    expect(res.status).toBe(401)
  })
})
