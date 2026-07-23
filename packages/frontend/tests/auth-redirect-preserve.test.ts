// RFC-105 — shared deep links survive login.
//
// The auth redirect used to store only `location.pathname`, so a shared
// `/tasks/t/preview?path=docs/report.md` collapsed to `/tasks/t/preview` after
// login → invalid-link. Now __root stores the full relative href and auth
// restores it via history.push, guarded against open redirects.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseBootstrapTokenLocation } from '../src/lib/bootstrap-token'
import { safeInternalRedirect } from '../src/routes/auth'

const ROOT = resolve(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8')

describe('safeInternalRedirect', () => {
  test('preserves same-origin relative paths incl. query', () => {
    expect(safeInternalRedirect('/tasks/t/preview?path=docs/report.md')).toBe(
      '/tasks/t/preview?path=docs/report.md',
    )
    expect(safeInternalRedirect('/agents')).toBe('/agents')
    expect(safeInternalRedirect('/reviews/r1?version=v2')).toBe('/reviews/r1?version=v2')
  })

  test('rejects open-redirect shapes → default landing', () => {
    expect(safeInternalRedirect(undefined)).toBe('/agents')
    expect(safeInternalRedirect('//evil.com')).toBe('/agents')
    expect(safeInternalRedirect('/\\evil.com')).toBe('/agents')
    expect(safeInternalRedirect('https://evil.com')).toBe('/agents')
    expect(safeInternalRedirect('javascript:alert(1)')).toBe('/agents')
    expect(safeInternalRedirect('agents')).toBe('/agents')
  })

  test('preserves a #fragment for the client-side (password/token) path', () => {
    // The OIDC path strips it (guarded separately); password/token history.push
    // keeps the heading anchor.
    expect(safeInternalRedirect('/tasks/t/preview?path=a.md#h')).toBe(
      '/tasks/t/preview?path=a.md#h',
    )
  })
})

describe('bootstrap URL handoff', () => {
  test('extracts the token while preserving non-secret query and fragment state', () => {
    expect(
      parseBootstrapTokenLocation('/tasks/t-1?token=%20setup-secret%20&tab=output#latest'),
    ).toEqual({
      token: 'setup-secret',
      sanitizedHref: '/tasks/t-1?tab=output#latest',
      redirect: '/tasks/t-1?tab=output#latest',
    })
  })

  test('uses the explicit auth redirect and removes every duplicate token parameter', () => {
    expect(
      parseBootstrapTokenLocation(
        '/auth?token=first&redirect=%2Freviews%2Fr1%3Fversion%3Dv2&token=second',
      ),
    ).toEqual({
      token: 'first',
      sanitizedHref: '/auth?redirect=%2Freviews%2Fr1%3Fversion%3Dv2',
      redirect: '/reviews/r1?version=v2',
    })
  })

  test('ignores ordinary URLs and treats an empty token as non-authenticating', () => {
    expect(parseBootstrapTokenLocation('/agents?tab=all')).toBeNull()
    expect(parseBootstrapTokenLocation('/?token=%20%20')).toEqual({
      token: null,
      sanitizedHref: '/',
      redirect: '/',
    })
  })
})

describe('RFC-105 source guards — login preserves deep-link search', () => {
  test('__root stores the full href (not just pathname) on the auth redirect', () => {
    const root = read('src/routes/__root.tsx')
    expect(root).toContain('bootstrapLocation?.sanitizedHref ?? location.href')
    expect(root).not.toContain('redirect: location.pathname')
  })

  test('auth restores via history.replace + the open-redirect guard', () => {
    const auth = read('src/routes/auth.tsx')
    expect(auth).toContain('router.history.replace(safeInternalRedirect(redirect))')
    // The fragile `redirect as '/agents'` cast that dropped search is gone.
    expect(auth).not.toContain("redirect as '/agents'")
  })

  test('OIDC postLoginRedirect strips the #fragment (callback appends its own)', () => {
    const auth = read('src/routes/auth.tsx')
    expect(auth).toContain("safeInternalRedirect(redirect).split('#')[0]")
  })
})
