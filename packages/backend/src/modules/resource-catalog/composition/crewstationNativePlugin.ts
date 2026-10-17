import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import type { BusinessNativePlugin } from '@/platform/crewstation/nativeMaterial'
import type { createHostedPluginGenerations } from '../infrastructure/crewstation/pluginGenerations'

/** Resource Catalog resolves its own immutable manifest. Task Execution only
 * consumes the portable tree and never interprets plugin cache locators. */
export function createHostedNativePluginReader(
  generations: Pick<ReturnType<typeof createHostedPluginGenerations>, 'read'>,
) {
  return async (
    plugin: NonNullable<AgentMaterialIntent['injection']['plugins']>[number],
  ): Promise<BusinessNativePlugin> => {
    if (plugin.content.owner !== 'resource-catalog')
      throw new Error('hosted-plugin-content-owner-mismatch')
    const manifest = await generations.read(plugin.content.reference)
    if (
      manifest.pluginId !== plugin.declaration.id ||
      manifest.resolvedVersion !== plugin.content.version
    )
      throw new Error('hosted-plugin-content-generation-mismatch')
    return {
      name: plugin.declaration.name,
      entry: manifest.entry === '.' ? 'package' : `package/${manifest.entry}`,
      files: manifest.files.map((file) =>
        file.kind === 'symlink'
          ? { kind: 'symlink', path: `package/${file.path}`, target: file.target }
          : {
              kind: 'file',
              path: `package/${file.path}`,
              mode: file.mode,
              object: {
                objectId: file.object.id,
                sha256: file.object.sha256,
                size: file.object.size,
              },
            },
      ),
      ...(Object.keys(plugin.declaration.options ?? {}).length
        ? { options: plugin.declaration.options }
        : {}),
    }
  }
}
