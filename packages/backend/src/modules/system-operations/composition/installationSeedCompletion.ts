import { Paths } from '@/util/paths'
import type { InstallationSeedCompletionPort } from '../application/ports/installationSeedCompletion'
import { createFileInstallationSeedCompletion } from '../infrastructure/local/fileInstallationSeedCompletion'

/** Standalone compatibility selects its marker at each boot call, not at module
 * load time. A supplied installation never reads the machine's marker. */
export function composeInstallationSeedCompletion(
  selected?: InstallationSeedCompletionPort,
): InstallationSeedCompletionPort {
  return selected ?? createFileInstallationSeedCompletion(Paths.demoSeedMarker)
}
