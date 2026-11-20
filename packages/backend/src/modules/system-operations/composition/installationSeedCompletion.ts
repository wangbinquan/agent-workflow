import { Paths } from '@/util/paths'
import type { InstallationSeedCompletionPort } from '../application/ports/installationSeedCompletion'
import { createFileInstallationSeedCompletion } from '../infrastructure/local/fileInstallationSeedCompletion'

/** Standalone compatibility selects its marker at each boot call, not at module
 * load time (RFC-524: the only caller selects the local marker; there is no supplied one). */
export function composeLocalInstallationSeedCompletion(): InstallationSeedCompletionPort {
  return createFileInstallationSeedCompletion(Paths.demoSeedMarker)
}
