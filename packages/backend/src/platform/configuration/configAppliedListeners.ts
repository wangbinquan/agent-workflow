import type { Config } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'

const log = createLogger('config-applied-listeners')
export type ConfigAppliedListener = (config: Config) => void | Promise<void>

/**
 * RFC-536: one listener set per application configuration (the configuration binding owns it). Saving the settings
 * notifies it; the daemon session and the maintenance service register on it. There is no process-level table keyed
 * by the configuration path.
 */
export interface ConfigAppliedListeners {
  register(listener: ConfigAppliedListener): () => void
  /** Notify runtime consumers only after the selected configuration was persisted. */
  notify(config: Config): void | Promise<void>
}

/** `key` names the configuration in the failure log (the configuration path or the selected source's logical key). */
export function createConfigAppliedListeners(key: string): ConfigAppliedListeners {
  const listeners = new Set<ConfigAppliedListener>()
  return Object.freeze<ConfigAppliedListeners>({
    register(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    notify(config) {
      const pending: Promise<void>[] = []
      const reportError = (error: unknown): void => {
        log.error('config hot-apply listener failed', {
          configPath: key,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      for (const listener of listeners) {
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
    },
  })
}
