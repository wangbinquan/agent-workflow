// Locks the RFC-099 audit (2026-07-15) fix for the OIDC open-redirect hole.
// routes/oidc-auth.ts did `c.redirect(`${flow.postLoginRedirect ?? '/'}#aw_session=${token}`)`
// with the freshly-minted session token in the URL fragment, and
// postLoginRedirect came straight from the PUBLIC login/start body with NO
// validation. An attacker could set postLoginRedirect=https://evil.com and,
// after luring a victim through the flow, exfiltrate the victim's session
// token from evil.com's location.hash → account takeover. startFlow now
// sanitizes postLoginRedirect down to a same-origin relative path (mirrors the
// frontend safeInternalRedirect in routes/auth.tsx). If this goes red, the
// open-redirect re-opened.

import { describe, expect, test } from 'bun:test'
import { sanitizePostLoginRedirect, startFlow } from '../src/auth/oidc/flow'

describe('sanitizePostLoginRedirect', () => {
  test('rejects absolute http(s) URLs → undefined', () => {
    expect(sanitizePostLoginRedirect('https://evil.com')).toBeUndefined()
    expect(sanitizePostLoginRedirect('http://evil.com/steal')).toBeUndefined()
  })

  test('rejects protocol-relative and backslash open-redirect tricks', () => {
    expect(sanitizePostLoginRedirect('//evil.com')).toBeUndefined()
    expect(sanitizePostLoginRedirect('/\\evil.com')).toBeUndefined()
    expect(sanitizePostLoginRedirect('\\\\evil.com')).toBeUndefined()
  })

  test('rejects empty / non-path values → undefined', () => {
    expect(sanitizePostLoginRedirect('')).toBeUndefined()
    expect(sanitizePostLoginRedirect(undefined)).toBeUndefined()
    expect(sanitizePostLoginRedirect('account')).toBeUndefined()
  })

  test('keeps same-origin relative paths (with query) intact', () => {
    expect(sanitizePostLoginRedirect('/account?linked=github')).toBe('/account?linked=github')
    expect(sanitizePostLoginRedirect('/tasks/t/preview?path=docs/report.md')).toBe(
      '/tasks/t/preview?path=docs/report.md',
    )
    expect(sanitizePostLoginRedirect('/')).toBe('/')
  })
})

describe('startFlow sanitizes postLoginRedirect at the source', () => {
  test('an absolute URL never reaches the pending flow', () => {
    const flow = startFlow('provider-1', {
      redirectUri: 'https://app.example/callback',
      postLoginRedirect: 'https://evil.com',
    })
    expect(flow.postLoginRedirect).toBeUndefined()
  })

  test('a safe relative path is preserved', () => {
    const flow = startFlow('provider-1', {
      redirectUri: 'https://app.example/callback',
      postLoginRedirect: '/account?linked=github',
    })
    expect(flow.postLoginRedirect).toBe('/account?linked=github')
  })
})
