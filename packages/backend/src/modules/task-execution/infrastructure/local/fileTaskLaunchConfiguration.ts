import { loadConfig } from '@/config'
import { resolveTaskUploadLimitsFromReader } from '../../application/launchConfiguration'
import type { TaskLaunchConfigurationSnapshot } from '../../application/ports/taskLaunchConfiguration'
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from '../../domain/uploads'

/** The standalone adapter performs the original live file read on every call. */
export function createFileTaskLaunchConfigurationQueries(configPath: string) {
  return Object.freeze({
    read(): TaskLaunchConfigurationSnapshot {
      return loadConfig(configPath)
    },
  })
}

/**
 * RFC-020: read `uploadLimits` from settings, falling back to defaults. Kept
 * narrow so the multipart handlers stay declarative. (RFC-445: moved here from
 * services/launchMultipart.ts, beside the file adapter it reads through.)
 */
export function resolveUploadLimits(configPath: string): UploadLimits {
  return resolveTaskUploadLimitsFromReader(
    createFileTaskLaunchConfigurationQueries(configPath).read,
    DEFAULT_UPLOAD_LIMITS,
  )
}
