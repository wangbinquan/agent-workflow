// RFC-201 T10.2 — conservative Plugin generation orphan/old GC.
//
// A generation is removed only when no Plugin row references it, it has aged
// past grace, and there are no non-terminal node runs at all. The last gate is
// intentionally coarse: until runtime paths are persisted per run, absence of
// all active work is the only cheap proof that an old cachedPath is not still
// being imported by a child process. Uncertainty retains data.

import { CANCELABLE_TASK_STATUSES } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { Dirent } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { collectPluginGenerationGarbage } from './plugin'
import { HOUR_MS, MAINTENANCE_PHASE } from './daemonCadence'
import { startMaintenanceTicker } from './maintenanceTicker'

const log = createLogger('plugin-generation-gc')
const DEFAULT_GRACE_MS = 24 * 60 * 60_000
// RFC-317 T51（LC-06）—— 从转移表派生，不再手抄。
const NON_TERMINAL = CANCELABLE_TASK_STATUSES

function missingDirectory(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' ||
      (error as { code?: unknown }).code === 'ENOTDIR')
  )
}

/**
 * Cheap filesystem preflight for the common empty-installation case. An
 * unreadable existing directory is treated as a candidate so uncertainty can
 * never bypass the active-run safety proof.
 */
export async function hasPluginGenerationGcCandidates(pluginsDir?: string): Promise<boolean> {
  const root = pluginsDir ?? Paths.pluginsDir
  let plugins: Dirent[]
  try {
    plugins = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return !missingDirectory(error)
  }
  for (const plugin of plugins) {
    if (!plugin.isDirectory()) continue
    if (plugin.name.startsWith('.check-')) return true
    try {
      const generations = await readdir(join(root, plugin.name, 'generations'), {
        withFileTypes: true,
      })
      if (generations.some((generation) => generation.isDirectory())) return true
    } catch (error) {
      if (!missingDirectory(error)) return true
    }
  }
  return false
}

export async function runPluginGenerationGc(opts: {
  db: DbClient
  pluginsDir?: string
  graceMs?: number
  now?: number
}): Promise<string[]> {
  if (!(await hasPluginGenerationGcCandidates(opts.pluginsDir))) return []
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
  /** RFC-322：错峰相位。 */
  phaseOffsetMs?: number
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
  // boot 拍保持原样（同步发起，不经定时器）：它与相位正交。
  void tick()
  return startMaintenanceTicker({
    job: 'pluginGenerationGc',
    intervalMs: opts.intervalMs ?? HOUR_MS,
    phaseOffsetMs: opts.phaseOffsetMs ?? MAINTENANCE_PHASE.pluginGenerationGc,
    onTick: tick,
  })
}
