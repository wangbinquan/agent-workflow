// RFC-201 T10.2 — conservative Plugin generation orphan/old GC.
//
// A generation is removed only when no Plugin row references it, it has aged
// past grace, and there are no non-terminal node runs at all. The last gate is
// intentionally coarse: until runtime paths are persisted per run, absence of
// all active work is the only cheap proof that an old cachedPath is not still
// being imported by a child process. Uncertainty retains data.

import {
  createPluginGenerationFilesystemGcPort as composePluginGenerationFilesystemGcPort,
  type PluginGenerationFilesystemGcAdapter,
} from '@/modules/resource-catalog/composition/pluginGenerationGc'
export {
  hasPluginGenerationGcCandidates,
  type PluginGenerationFilesystemGcInput,
  type PluginGenerationFilesystemGcAdapter,
} from '@/modules/resource-catalog/composition/pluginGenerationGc'
import type { PluginGenerationGcCommand } from '@/modules/resource-catalog/public/commands'
import { createLogger } from '@/util/log'
import { HOUR_MS, MAINTENANCE_PHASE } from '@/services/daemonCadence'
import { startMaintenanceTicker } from './maintenanceTicker'

const log = createLogger('plugin-generation-gc')
const DEFAULT_GRACE_MS = 24 * 60 * 60_000

/** Standalone compatibility selects the owner-owned physical adapter. */
export function createPluginGenerationFilesystemGcPort(
  pluginsDir?: string,
): PluginGenerationFilesystemGcAdapter {
  return composePluginGenerationFilesystemGcPort(pluginsDir)
}

export async function runPluginGenerationGc(opts: {
  command: PluginGenerationGcCommand
  executionFence: 'clear' | 'busy'
  graceMs?: number
  now?: number
}): Promise<string[]> {
  const receipt = await opts.command.run({
    executionFence: opts.executionFence,
    graceMs: opts.graceMs ?? DEFAULT_GRACE_MS,
    ...(opts.now === undefined ? {} : { now: opts.now }),
  })
  return [...receipt.removedGenerationPaths]
}

export function startPluginGenerationGc(opts: {
  command: PluginGenerationGcCommand
  executionFence: () => Promise<'clear' | 'busy'>
  intervalMs?: number
  graceMs?: number
  /** RFC-322：错峰相位。 */
  phaseOffsetMs?: number
}): { stop: () => void } {
  const tick = async (): Promise<void> => {
    try {
      const removed = await runPluginGenerationGc({
        command: opts.command,
        executionFence: await opts.executionFence(),
        ...(opts.graceMs === undefined ? {} : { graceMs: opts.graceMs }),
      })
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
