import type { Config } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'

const log = createLogger('config-applied-listeners')
type ConfigAppliedListener = (config: Config) => void
const listenersByPath = new Map<string, Set<ConfigAppliedListener>>()

export function registerConfigAppliedListener(
  configPath: string,
  listener: ConfigAppliedListener,
): () => void {
  const listeners = listenersByPath.get(configPath) ?? new Set<ConfigAppliedListener>()
  listeners.add(listener)
  listenersByPath.set(configPath, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) listenersByPath.delete(configPath)
  }
}

/** Notify runtime consumers only after config.json was persisted successfully. */
export function notifyConfigApplied(configPath: string, config: Config): void {
  for (const listener of listenersByPath.get(configPath) ?? []) {
    try {
      listener(config)
    } catch (error) {
      log.error('config hot-apply listener failed', {
        configPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
