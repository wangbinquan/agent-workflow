import type { ProxyOptions } from 'vite'

/**
 * The dev server's proxy to the daemon. `xfwd` forwards the browser-facing
 * host: without `publicBaseUrl` the daemon builds OIDC redirect URIs from
 * `X-Forwarded-Host`, and Vite's string shorthand rewrites `Host` to the
 * daemon's address while forwarding nothing, so the login page's
 * identity-provider button returned the browser to the daemon port, which
 * serves no pages in dev (2026-10-29).
 */
export function daemonProxy(target: string): Record<string, ProxyOptions> {
  return {
    '/api': { target, changeOrigin: true, xfwd: true },
    '/ws': { target, ws: true, changeOrigin: true },
  }
}
