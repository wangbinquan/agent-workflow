import { checkForUpdate, cleanupInstallGeneration, installPlugin } from '@/services/pluginInstaller'
import type { PluginInstallerPort } from '../../application/plugins/ports'

/** Local npm/git/file mechanics; AW's catalog owns publication and compensation. */
export function createLocalPluginInstaller(
  options: NonNullable<Parameters<typeof installPlugin>[2]> = {},
): PluginInstallerPort {
  return Object.freeze({
    async install(pluginId: string, spec: string) {
      const installed = await installPlugin(pluginId, spec, options)
      return Object.freeze({
        sourceKind: installed.sourceKind,
        cachedPath: installed.cachedPath,
        resolvedVersion: installed.resolvedVersion,
        cleanup: () => cleanupInstallGeneration(installed),
      })
    },
    checkForUpdate: (pluginId: string, spec: string, currentCachedPath: string) =>
      checkForUpdate(pluginId, spec, currentCachedPath, options),
  })
}
