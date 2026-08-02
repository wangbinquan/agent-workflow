// GET /api/daemon — the daemon's EFFECTIVE runtime binding (host / port / url it
// is actually listening on right now), read from the run-info file.
//
// Deliberately separate from GET /api/config: that returns the PERSISTED
// bindHost/bindPort, which is blank for the default (ephemeral) port and is
// overridden — without being written back — when the daemon is launched with
// --host / --port. The Network settings tab shows this alongside the editable
// config so the operator can see the live address, not just the on-restart one.
//
// Returns null when the run-info file is absent/garbled (frontend hides the
// readout). Requires token auth (mounted under /api/* in server.ts).

import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { readDaemonInfo } from '@/util/daemonInfo'
import { Paths } from '@/util/paths'

export function mountDaemonRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/daemon',
      permissions: ['settings:read'],
      tokenAccess: 'allow',
      summary: 'Daemon bind host/port and process info',
    },
    (c) => {
      return c.json(readDaemonInfo(deps.daemonInfoPath ?? Paths.daemonInfo))
    },
  )
}
