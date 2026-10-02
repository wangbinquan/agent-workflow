import type { Config } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'

const log = createLogger('config-applied-listeners')
type ConfigAppliedListener = (config: Config) => void | Promise<void>
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

/** Notify runtime consumers only after the selected configuration was persisted. */
export function notifyConfigApplied(configPath: string, config: Config): void | Promise<void> {
  const pending: Promise<void>[] = []
  const reportError = (error: unknown): void => {
    log.error('config hot-apply listener failed', {
      configPath,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  for (const listener of listenersByPath.get(configPath) ?? []) {
    try {
      const applied = listener(config)
      // Existing void callbacks may implicitly return a synchronous value.
      // Only a real asynchronous result changes notify's synchronous contract.
      if (applied != null && typeof applied.then === 'function') {
        pending.push(Promise.resolve(applied).catch(reportError))
      }
    } catch (error) {
      reportError(error)
    }
  }
  if (pending.length > 0) return Promise.all(pending).then(() => undefined)
}
