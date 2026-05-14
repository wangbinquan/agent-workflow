// GET    /api/repos/recent              list recent-used repos
// POST   /api/repos/recent               upsert one (also probes default branch)
// GET    /api/repos/refs?path=...        branches / tags / recent commits
// GET    /api/repos/files?path=...       git ls-files

import { UpsertRecentRepoSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  getRepoFiles,
  getRepoRefs,
  listRecentRepos,
  upsertRecentRepo,
} from '@/services/repo'
import { ValidationError } from '@/util/errors'

export function mountRepoRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/repos/recent', async (c) => c.json(await listRecentRepos(deps.db)))

  app.post('/api/repos/recent', async (c) => {
    const parsed = UpsertRecentRepoSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('repo-invalid', 'invalid recent-repo payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(await upsertRecentRepo(deps.db, parsed.data.path))
  })

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

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
