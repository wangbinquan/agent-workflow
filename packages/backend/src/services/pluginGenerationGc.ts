// RFC-201 T10.2 — conservative Plugin generation orphan/old GC.
//
// A generation is removed only when no Plugin row references it, it has aged
// past grace, and there are no non-terminal node runs at all. The last gate is
// intentionally coarse: until runtime paths are persisted per run, absence of
// all active work is the only cheap proof that an old cachedPath is not still
// being imported by a child process. Uncertainty retains data.

import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { createLogger } from '@/util/log'
import { collectPluginGenerationGarbage } from './plugin'

const log = createLogger('plugin-generation-gc')
const DEFAULT_INTERVAL_MS = 60 * 60_000
const DEFAULT_GRACE_MS = 24 * 60 * 60_000
const NON_TERMINAL = ['pending', 'running', 'awaiting_review', 'awaiting_human'] as const

export async function runPluginGenerationGc(opts: {
  db: DbClient
  pluginsDir?: string
  graceMs?: number
  now?: number
}): Promise<string[]> {
  const active = await opts.db
    .select({ id: nodeRuns.id })
    .from(nodeRuns)
    .where(inArray(nodeRuns.status, [...NON_TERMINAL]))
    .limit(1)
  if (active.length > 0) return []
  return collectPluginGenerationGarbage(
    opts.db,
    { pluginsDir: opts.pluginsDir },
    { graceMs: opts.graceMs ?? DEFAULT_GRACE_MS, now: opts.now },
  )
}

export function startPluginGenerationGc(opts: {
  db: DbClient
  pluginsDir?: string
  intervalMs?: number
  graceMs?: number
}): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const removed = await runPluginGenerationGc(opts)
      if (removed.length > 0)
        log.info('removed unreferenced plugin generations', { count: removed.length })
    } catch (error) {
      log.warn('plugin generation gc failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), opts.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref?.()
  return { stop: () => clearInterval(timer) }
}
