import { valueDigest } from './digest'
import type { EncodedKey } from './types'

export function deterministicChildId(
  namespace: string,
  parent: EncodedKey,
  discriminator: string | number = '',
): string {
  return `mc1_${valueDigest(['mc1', namespace, parent, discriminator]).slice(7)}`
}
