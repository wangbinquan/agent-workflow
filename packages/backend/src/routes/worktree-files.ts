// GET /api/worktree-files/:taskId/* — RFC-005 PR-B T13.
//
// The Reviews UI renders markdown that may reference images by relative path
// (e.g. `![](./img/diagram.png)`). The frontend resolves these to this
// endpoint so the browser can fetch them through the daemon's already
// authenticated channel (token middleware) instead of leaking direct
// filesystem access.
//
// Hardening:
//   - Path traversal: lexical containment check against the task's worktreePath.
//   - Method: GET only.
//   - Range: full file in v1; range requests are not needed for design docs.
//   - Content-Type: derived from extension; unknown → application/octet-stream
//     so the browser doesn't naively render exotic types as HTML.

import { existsSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { getTask } from '@/services/task'
import { NotFoundError, ValidationError } from '@/util/errors'

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

export function mountWorktreeFilesRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/worktree-files/:taskId/*', async (c) => {
    const taskId = c.req.param('taskId')
    const task = await getTask(deps.db, taskId)
    if (task === null) {
      throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    }

    // Hono's wildcard match — everything after the taskId segment.
    // c.req.path: "/api/worktree-files/{taskId}/{rel}"
    const prefix = `/api/worktree-files/${taskId}/`
    const path = c.req.path
    const rel = path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : ''
    if (rel.length === 0) {
      throw new ValidationError(
        'worktree-file-missing-path',
        'relative file path must follow the task id',
      )
    }
    if (isAbsolute(rel)) {
      throw new ValidationError(
        'worktree-file-absolute-path',
        `path '${rel}' must be relative to the worktree`,
      )
    }

    const rootAbs = resolve(task.worktreePath)
    const target = resolve(rootAbs, rel)
    if (!(target === rootAbs || target.startsWith(rootAbs + sep))) {
      throw new ValidationError(
        'worktree-file-escapes-worktree',
        `path '${rel}' resolves outside the task worktree`,
      )
    }

    if (!existsSync(target)) {
      throw new NotFoundError(
        'worktree-file-not-found',
        `file '${rel}' not found in task ${taskId}`,
      )
    }
    const stat = statSync(target)
    if (!stat.isFile()) {
      throw new NotFoundError(
        'worktree-file-not-a-file',
        `path '${rel}' exists but is not a regular file`,
      )
    }

    const ext = extname(target).toLowerCase()
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'

    // Stream the file via Bun.file for zero-copy. Set explicit Cache-Control
    // since these are mutable design doc assets — clients should re-check.
    const file = Bun.file(target)
    return new Response(file, {
      headers: {
        'content-type': mime,
        'cache-control': 'no-cache',
        'content-length': String(stat.size),
      },
    })
  })

  // Keep the un-suffixed route reachable so the missing-path error is
  // produced via a normal 4xx rather than Hono's default 404.
  app.get('/api/worktree-files/:taskId', () => {
    throw new ValidationError(
      'worktree-file-missing-path',
      'relative file path must follow the task id',
    )
  })
}
