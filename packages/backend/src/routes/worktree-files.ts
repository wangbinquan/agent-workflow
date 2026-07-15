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

import { existsSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve, sep } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import { tasks } from '@/db/schema'
import type { AppDeps } from '@/server'
import { canViewTask } from '@/services/taskCollab'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

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
    // Load the raw task row (not the Task DTO — canViewTask needs ownerUserId,
    // which the DTO drops). One query yields both the visibility fields and
    // worktreePath.
    const taskRows = await deps.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
    const task = taskRows[0]
    if (task === undefined) {
      throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
    }
    // RFC-099 (D20): tasks are member-only private. This proxy is NOT under the
    // /api/tasks/:id/* visibility middleware, so it must run its own gate — an
    // RFC-005-era single-user route that never got the multi-user check. Same
    // 403 shape the other task routes use.
    const actor = actorOf(c)
    if (!(await canViewTask(deps.db, actor, task))) {
      throw new ForbiddenError('task-not-visible', `task '${taskId}' is not visible to this actor`)
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

    // Symlink containment: the lexical check above stops `../`, but a symlink
    // INSIDE the worktree can still point out (e.g. → /etc/passwd). Resolve the
    // real path and re-check under the worktree's own realpath (the root itself
    // may live behind a symlink, e.g. macOS /tmp → /private/tmp).
    let realTarget: string
    try {
      realTarget = realpathSync(target)
    } catch {
      throw new NotFoundError(
        'worktree-file-not-found',
        `file '${rel}' not found in task ${taskId}`,
      )
    }
    const rootReal = realpathSync(rootAbs)
    const rootRealPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
    if (!(realTarget === rootReal || realTarget.startsWith(rootRealPrefix))) {
      throw new ValidationError(
        'worktree-file-symlink-escapes',
        `path '${rel}' resolves outside the task worktree via a symlink`,
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
