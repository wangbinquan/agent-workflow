// GET    /api/repos/refs?path=...        branches / tags / recent commits
// GET    /api/repos/files?path=...       git ls-files
//
// RFC-165: the /api/repos/recent pair retired with path-mode launches
// (recent_repos dropped by migration 0085); refs/files stay — the URL-mode
// pickers query them against the cached mirror's localPath (RFC-110).

import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { getRepoFiles, getRepoRefs } from '@/services/repo'
import { ValidationError } from '@/util/errors'

export function mountRepoRoutes(app: Hono, _deps: AppDeps): void {
  app.get('/api/repos/refs', async (c) => {
    const path = requirePath(c.req.query('path'))
    return c.json(await getRepoRefs(path))
  })

  app.get('/api/repos/files', async (c) => {
    const path = requirePath(c.req.query('path'))
    return c.json(await getRepoFiles(path))
  })
}

function requirePath(p: string | undefined): string {
  if (p === undefined || p.length === 0) {
    throw new ValidationError('path-required', "'path' query parameter is required")
  }
  return p
}
