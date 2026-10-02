import { createFileApplicationConfiguration } from '../infrastructure/local/fileApplicationConfiguration'
import type { ApplicationConfigurationQueries } from '../public/queries'

/** Standalone diagnostics use the same lazy, live file query as the selected binding. */
export function composeFileDoctorConfigurationQueries(
  configPath: string,
): ApplicationConfigurationQueries {
  const persistence = createFileApplicationConfiguration(configPath)
  return Object.freeze({ read: () => persistence.load() })
}
