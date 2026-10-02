// Standalone plugin generation preflight and reclamation effects.
import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Paths } from '@/util/paths'
import { garbageCollectPluginGenerations } from './filePluginInstallation'

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
