import { loadConfig } from '@/config'
import type { TaskLaunchConfigurationSnapshot } from '../../application/ports/taskLaunchConfiguration'

/** The standalone adapter performs the original live file read on every call. */
export function createFileTaskLaunchConfigurationQueries(configPath: string) {
  return Object.freeze({
    read(): TaskLaunchConfigurationSnapshot {
      return loadConfig(configPath)
    },
  })
}
