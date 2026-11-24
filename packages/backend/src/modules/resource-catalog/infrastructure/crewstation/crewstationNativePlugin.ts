import type { Plugin } from '@agent-workflow/shared'
import type { BusinessNativePlugin } from '@/platform/crewstation/nativeMaterial'
import type { createHostedPluginGenerations } from './pluginGenerations'

/** Resource Catalog resolves its own immutable manifest. Task Execution only
 * consumes the portable tree and never interprets plugin cache locators. */
export function createHostedNativePluginReader(
  generations: Pick<ReturnType<typeof createHostedPluginGenerations>, 'read'>,
) {
  // RFC-563: a plugin material as the hosted compiler hands it back, in this module's own shape — the owner is checked
  // before the reference is interpreted, so any owner's reference is accepted here.
  return async (plugin: {
    readonly declaration: Readonly<Pick<Plugin, 'id' | 'name' | 'options'>>
    readonly content: {
      readonly owner: string
      readonly reference: string
      readonly version: string | number | null
    }
  }): Promise<BusinessNativePlugin> => {
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
