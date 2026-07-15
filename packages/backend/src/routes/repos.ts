// GET    /api/repos/refs?path=...        branches / tags / recent commits
// GET    /api/repos/files?path=...       git ls-files
//
// RFC-165: the /api/repos/recent pair retired with path-mode launches
// (recent_repos dropped by migration 0085); refs/files stay — the URL-mode
// pickers query them against the cached mirror's localPath (RFC-110).

import type { Hono } from 'hono'
import { cachedRepos } from '@/db/schema'
import type { AppDeps } from '@/server'
import { getRepoFiles, getRepoRefs, isKnownRepoPath } from '@/services/repo'
import { ValidationError } from '@/util/errors'

export function mountRepoRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099 audit (2026-07-15): `path` is attacker-controllable and repos:read
  // is in the user baseline. Constrain introspection to paths inside a known
  // cached-repos mirror so a user can't enumerate arbitrary host git repos.
  async function requireKnownPath(path: string): Promise<void> {
    const rows = await deps.db.select({ localPath: cachedRepos.localPath }).from(cachedRepos)
    if (
      !isKnownRepoPath(
        rows.map((r) => r.localPath),
        path,
      )
    ) {
      throw new ValidationError('repo-path-unknown', 'path is not a known cached repository')
    }
  }

  app.get('/api/repos/refs', async (c) => {
    const path = requirePath(c.req.query('path'))
    await requireKnownPath(path)
    return c.json(await getRepoRefs(path))
  })

  app.get('/api/repos/files', async (c) => {
    const path = requirePath(c.req.query('path'))
    await requireKnownPath(path)
    return c.json(await getRepoFiles(path))
  })
}

function requirePath(p: string | undefined): string {
  if (p === undefined || p.length === 0) {
    throw new ValidationError('path-required', "'path' query parameter is required")
  }
  return p
}
