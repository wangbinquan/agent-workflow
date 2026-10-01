import { loadConfig } from '@/config'
import type { TaskBackgroundConfigurationQuery } from '../../application/ports/taskBackgroundConfiguration'

export function createFileTaskBackgroundConfigurationQuery(
  configPath: string,
): TaskBackgroundConfigurationQuery {
  return Object.freeze({ read: () => loadConfig(configPath) })
}
