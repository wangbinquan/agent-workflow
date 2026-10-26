import { sha256Hex } from '@/util/hash'
import { legacyContentRef, type ContentRef } from '../contentRef'

export function isHostedPluginReference(reference: string): boolean {
  return reference.startsWith('cs-plugin:')
}

export const pluginGenerationReference = (pluginId: string, generationId: string) => {
  if (![pluginId, generationId].every((id) => /^[A-Za-z0-9_-]+$/.test(id)))
    throw new Error('hosted-plugin-identity-invalid')
  return `cs-plugin:${pluginId}/${generationId}`
}
export function parsePluginReference(reference: string) {
  const match = /^cs-plugin:([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)(?:\/([^/]+))?$/.exec(reference)
  if (!match) throw new Error('hosted-plugin-reference-invalid')
  return {
    pluginId: match[1]!,
    generationId: match[2]!,
    root: pluginGenerationReference(match[1]!, match[2]!),
    entry: match[3] === undefined ? null : decodeURIComponent(match[3]),
  }
}
export const pluginFileKey = (reference: string, path: string) =>
  `${reference}/file/${sha256Hex(path)}`
export const pluginManifestKey = (reference: string) => `${reference}/manifest`
export const pluginCachedReference = (reference: string, entry: string) =>
  `${reference}/${encodeURIComponent(entry)}`

export function decodePlugin(reference: string): ContentRef<string> {
  parsePluginReference(reference)
  return legacyContentRef('cs-plugin', 'object', reference)
}

/** The publication lookup historically checks the root without decoding entry bytes. */
export function pluginPublicationRoot(
  reference: string,
): { root: string; pluginId: string } | null {
  const match = /^(cs-plugin:([A-Za-z0-9_-]+)\/[A-Za-z0-9_-]+)(?:\/[^/]+)?$/.exec(reference)
  return match === null ? null : { root: match[1]!, pluginId: match[2]! }
}

export { encodeLegacyContent as encodeLegacyPlugin } from '../contentRef'
