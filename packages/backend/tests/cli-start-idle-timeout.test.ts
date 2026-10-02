// Regression sentry for "socket hang up while npm install runs":
//
// Bun.serve's default idleTimeout is 10 seconds. Several daemon endpoints
// (notably POST /api/plugins/:id/check-update and /upgrade) synchronously
// await installPluginInner, which runs `npm install <spec>` and only writes
// the HTTP response after npm exits. installPluginInner caps that at
// DEFAULT_INSTALL_TIMEOUT_MS = 60s; if the inbound socket carries no data
// for 10s in between, Bun closes it from under us — Vite's proxy then
// surfaces:
//
//   [vite] http proxy error: /api/plugins/.../check-update
//   Error: socket hang up
//     at Socket.socketOnEnd (node:_http_client:617:25)
//
// while the npm child keeps running in the background, orphaned from any
// HTTP response. The daemon log shows nothing because the daemon itself
// didn't error — Bun just closed the connection it considered idle.
//
// Lock the fix as a source-text check: Bun.serve must pass an explicit
// idleTimeout >= 60s so the connection survives every endpoint that can
// legitimately block on installPluginInner.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'

const START_TS = resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts')
const INSTALLER_TS = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'resource-catalog',
  'infrastructure',
  'local',
  'filePluginInstallation.ts',
)

describe('cli/start.ts — Bun.serve idleTimeout', () => {
  test('Bun.serve passes an explicit idleTimeout that covers the install timeout', () => {
    const src = readFileSync(START_TS, 'utf-8')
    const match = src.match(/idleTimeout:\s*(\d+)/)
    expect(match).not.toBeNull()
    const seconds = parseInt(match![1]!, 10)

    // Pull the installer's own ceiling so this test stays in sync if anyone
    // bumps DEFAULT_INSTALL_TIMEOUT_MS — they'll be forced to bump idleTimeout
    // too instead of silently re-introducing the socket-hang-up regression.
    const installerSrc = readFileSync(INSTALLER_TS, 'utf-8')
    const installerMatch = installerSrc.match(/DEFAULT_INSTALL_TIMEOUT_MS\s*=\s*([\d_]+)/)
    expect(installerMatch).not.toBeNull()
    const installerMs = parseInt(installerMatch![1]!.replace(/_/g, ''), 10)

    expect(seconds * 1_000).toBeGreaterThanOrEqual(installerMs)
  })
})
