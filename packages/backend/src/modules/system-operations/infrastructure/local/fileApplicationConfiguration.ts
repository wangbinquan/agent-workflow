import {
  applyConfigPatch,
  loadConfig,
  previewConfigPatch,
} from '@/platform/configuration/fileConfiguration'
import type { ApplicationConfigurationPersistencePort } from '../../application/ports/applicationConfiguration'

export function createFileApplicationConfiguration(
  path: string,
): ApplicationConfigurationPersistencePort {
  return Object.freeze({
    load: () => loadConfig(path),
    previewPatch: (patch: unknown) => previewConfigPatch(path, patch),
    applyPatch: (patch: unknown) => applyConfigPatch(path, patch),
  })
}
