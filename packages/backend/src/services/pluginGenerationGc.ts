// RFC-201 T10.2 — conservative Plugin generation orphan/old GC.
//
// A generation is removed only when no Plugin row references it, it has aged
// past grace, and there are no non-terminal node runs at all. The last gate is
// intentionally coarse: until runtime paths are persisted per run, absence of
// all active work is the only cheap proof that an old cachedPath is not still
// being imported by a child process. Uncertainty retains data.

import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginGenerationGcCommand } from '@/modules/resource-catalog/public/commands'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { garbageCollectPluginGenerations } from './pluginInstaller'
import { HOUR_MS, MAINTENANCE_PHASE } from './daemonCadence'
import { startMaintenanceTicker } from './maintenanceTicker'

const log = createLogger('plugin-generation-gc')
const DEFAULT_GRACE_MS = 24 * 60 * 60_000

function missingDirectory(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = Reflect.get(error, 'code')
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Cheap filesystem preflight for the common empty-installation case. An
 * unreadable existing directory is treated as a candidate so uncertainty can
 * never bypass the active-run safety proof.
 */
export async function hasPluginGenerationGcCandidates(
  pluginsDir?: string,
  input: { readonly graceMs?: number; readonly now?: number } = {},
): Promise<boolean> {
  const root = pluginsDir ?? Paths.pluginsDir
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS
  const now = input.now ?? Date.now()
  let plugins: Dirent[]
  try {
    plugins = await readdir(root, { withFileTypes: true })
  } catch (error) {
    return !missingDirectory(error)
  }
  for (const plugin of plugins) {
    if (!plugin.isDirectory()) continue
    if (plugin.name.startsWith('.check-')) {
      try {
        if (now - (await stat(join(root, plugin.name))).mtimeMs >= graceMs) return true
      } catch (error) {
        if (!missingDirectory(error)) return true
      }
      continue
    }
    const generationsRoot = join(root, plugin.name, 'generations')
    try {
      const generations = await readdir(generationsRoot, {
        withFileTypes: true,
      })
      for (const generation of generations) {
        if (!generation.isDirectory()) continue
        try {
          if (now - (await stat(join(generationsRoot, generation.name))).mtimeMs >= graceMs) {
            return true
          }
        } catch (error) {
          if (!missingDirectory(error)) return true
        }
      }
    } catch (error) {
      if (!missingDirectory(error)) return true
    }
  }
  return false
}

/**
 * Filesystem half of the provider-neutral Resource Catalog maintenance
 * command. Runtime execution fencing and provider reads are supplied by the
 * command's owner at composition time; this compatibility surface no longer
 * knows which database provider is active.
 */
export interface PluginGenerationFilesystemGcInput {
  readonly referencedCachedPaths: ReadonlySet<string>
  readonly graceMs?: number
  readonly now?: number
}

export interface PluginGenerationFilesystemGcAdapter {
  hasCandidates(input: { readonly graceMs?: number; readonly now?: number }): Promise<boolean>
  collect(input: PluginGenerationFilesystemGcInput): Promise<readonly string[]>
}

export function createPluginGenerationFilesystemGcPort(
  pluginsDir?: string,
): PluginGenerationFilesystemGcAdapter {
  return Object.freeze({
    hasCandidates: (input: { readonly graceMs?: number; readonly now?: number }) =>
      hasPluginGenerationGcCandidates(pluginsDir, input),
    collect: (input: PluginGenerationFilesystemGcInput) =>
      garbageCollectPluginGenerations({
        pluginsDir,
        referencedCachedPaths: input.referencedCachedPaths,
        graceMs: input.graceMs,
        now: input.now,
      }),
  })
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
