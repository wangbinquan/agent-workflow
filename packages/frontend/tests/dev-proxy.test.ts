// Locks in the 2026-10-29 dev single sign-on fix: under `bun dev` the login
// page's identity-provider button sent the browser back to the daemon's port
// and ended on `{"code":"route-not-found","message":"no route for /tasks"}`.
// With no `publicBaseUrl` the daemon derives the OIDC redirect_uri from
// `X-Forwarded-Host`; Vite's string shorthand (`'/api': target`) rewrites
// `Host` to the daemon address and forwards no `X-Forwarded-*`, so the
// redirect pointed at an origin that serves no pages in dev.

import { describe, expect, test } from 'vitest'
import { daemonProxy } from '../devProxy'

const target = 'http://127.0.0.1:7456'

describe('dev server proxy to the daemon', () => {
  test('API requests tell the daemon which host the browser is on', () => {
    expect(daemonProxy(target)['/api']).toEqual({ target, changeOrigin: true, xfwd: true })
  })

  test('WebSocket upgrades go to the same daemon', () => {
    expect(daemonProxy(target)['/ws']).toEqual({ target, ws: true, changeOrigin: true })
  })

  test('nothing else is proxied: every other path is the SPA', () => {
    expect(Object.keys(daemonProxy(target)).sort()).toEqual(['/api', '/ws'])
  })
})
