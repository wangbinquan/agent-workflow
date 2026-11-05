// GET    /api/repos/refs?cachedRepoId=...   branches / tags / recent commits
// GET    /api/repos/files?cachedRepoId=...  repo-relative files of the default branch
//
// RFC-165: the /api/repos/recent pair retired with path-mode launches
// (recent_repos dropped by migration 0085); refs/files stay for the URL-mode
// pickers (RFC-110).
//
// RFC-370 §10 V17: the pickers name a registered repository by id and the
// selected mirrors read it — a standalone daemon its own mirror clone, a hosted
// deployment the remote itself. `?path=` (a standalone mirror directory)
// remains for existing API clients; where the daemon's disk holds no mirror it
// is refused.
//
// RFC-446: `mirrors.local` itself reads only inside a registered mirror
// (source-control `infrastructure/local/repositoryIntrospection.ts`), so this
// route no longer takes the repository store.

import type { Hono } from 'hono'
import type { RepositoryMirrors } from '@/modules/source-control/public/types'
import { registerRoute } from '@/routes/registry'
import { ValidationError } from '@/util/errors'

export function mountRepoRoutes(app: Hono, mirrors: RepositoryMirrors): void {
  async function read<T>(
    query: (name: string) => string | undefined,
    byId: (cachedRepoId: string) => Promise<T>,
    byPath: (local: NonNullable<RepositoryMirrors['local']>, path: string) => Promise<T>,
  ): Promise<T> {
    const cachedRepoId = query('cachedRepoId')
    if (cachedRepoId !== undefined && cachedRepoId.length > 0) return await byId(cachedRepoId)
    const path = query('path')
    if (path === undefined || path.length === 0) {
      throw new ValidationError(
        'cached-repo-id-required',
        "'cachedRepoId' query parameter is required",
      )
    }
    if (mirrors.local === undefined) {
      throw new ValidationError(
        'repo-path-unsupported',
        'this deployment keeps no repository mirror on its own disk; name the repository by cachedRepoId',
      )
    }
    return await byPath(mirrors.local, path)
  }

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/repos/refs',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'List refs for a repo URL',
    },
    async (c) =>
      c.json(
        await read(
          (name) => c.req.query(name),
          (id) => mirrors.refs(id),
          (local, path) => local.refs(path),
        ),
      ),
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/repos/files',
      permissions: ['repos:read'],
      tokenAccess: 'allow',
      summary: 'List files at a repo ref',
    },
    async (c) =>
      c.json(
        await read(
          (name) => c.req.query(name),
          (id) => mirrors.files(id),
          (local, path) => local.files(path),
        ),
      ),
  )
}
