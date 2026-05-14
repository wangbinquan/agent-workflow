// GET /health — public; no token required.
// Schema per design.md §4.2.2 row 1.

import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { sql } from 'drizzle-orm'
import { tasks } from '@/db/schema'

export function mountHealthRoutes(app: Hono, deps: AppDeps): void {
  app.get('/health', async (c) => {
    let runningTasks = 0
    try {
      const rows = await deps.db
        .select({ n: sql<number>`count(*)` })
        .from(tasks)
        .where(sql`status = 'running'`)
      runningTasks = Number(rows[0]?.n ?? 0)
    } catch {
      // DB may be locked or in-flight migration; report 0 rather than failing
      // the health probe (which is used by `agent-workflow doctor` too).
    }

    return c.json({
      ok: true,
      opencodeVersion: deps.opencodeVersion,
      dbVersion: deps.dbVersion,
      uptime: Math.round(process.uptime()),
      runningTasks,
    })
  })
}
