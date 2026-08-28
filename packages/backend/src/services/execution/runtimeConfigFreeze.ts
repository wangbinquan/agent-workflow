import { loadConfig } from '@/config'

/**
 * Read the current binary fallbacks at node-mint time. The resulting values
 * are frozen onto the node run and never re-read by that run.
 */
export function freezeBinaryConfig(
  configPath: string | undefined,
): { opencodePath?: string | null; claudeCodePath?: string | null } | undefined {
  if (configPath === undefined || configPath === '') return undefined
  try {
    const cfg = loadConfig(configPath)
    return { opencodePath: cfg.opencodePath ?? null, claudeCodePath: cfg.claudeCodePath ?? null }
  } catch {
    return undefined
  }
}
