import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentRef } from './contentRef'

export function isLegacyHostedPluginReference(reference: string): boolean {
  return reference.startsWith('cs-plugin:')
}

export const legacyPluginGenerationReference = (pluginId: string, generationId: string) => {
  if (![pluginId, generationId].every((id) => /^[A-Za-z0-9_-]+$/.test(id)))
    throw new Error('hosted-plugin-identity-invalid')
  return `cs-plugin:${pluginId}/${generationId}`
}
export function parseLegacyPluginReference(reference: string) {
  const match = /^cs-plugin:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/.exec(reference)
  if (!match) throw new Error('hosted-plugin-reference-invalid')
  return {
    pluginId: match[1]!,
    generationId: match[2]!,
    root: legacyPluginGenerationReference(match[1]!, match[2]!),
    entry: match[3] === undefined ? null : decodeURIComponent(match[3]),
  }
}
export const legacyPluginFileKey = (reference: string, path: string) =>
  `${reference}/file/${sha256Hex(path)}`
export const legacyPluginManifestKey = (reference: string) => `${reference}/manifest`
export const legacyPluginCachedReference = (reference: string, entry: string) =>
  `${reference}/${encodeURIComponent(entry)}`

export function decodeLegacyPlugin(reference: string): ContentRef<string> {
  parseLegacyPluginReference(reference)
  return legacyContentRef('cs-plugin', 'object', reference)
}

/** The publication lookup historically checks the root without decoding entry bytes. */
export function legacyPluginPublicationRoot(
  reference: string,
): { root: string; pluginId: string } | null {
  const match = /^(cs-plugin:([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+)(?:\/[^/]+)?$/.exec(reference)
  return match === null ? null : { root: match[1]!, pluginId: match[2]! }
}

export { encodeLegacyContent as encodeLegacyPlugin } from './contentRef'
