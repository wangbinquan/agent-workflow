import { sha256Hex } from './hash'

/**
 * Map an arbitrary business identity to one Git-ref-safe path component.
 * Readable legacy identifiers remain readable; every other identity gets a
 * full digest so delimiters such as `:` can never change refspec semantics.
 */
export function stableIdentityComponent(identity: string): string {
  const normalized = identity.toLowerCase()
  return /^[0-9a-z][0-9a-z-]{0,159}$/.test(normalized) ? normalized : `x${sha256Hex(normalized)}`
}

export function stableGitRefComponent(identity: string): string {
  return stableIdentityComponent(identity)
}
