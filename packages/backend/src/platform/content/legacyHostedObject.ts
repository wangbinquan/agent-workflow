import { legacyContentRef, type ContentRef } from './contentRef'

interface HostedStoredObject {
  readonly id: string
  readonly size: number
  readonly sha256: string
}

/** Immutable byte location; the containing domain record remains the owner of
 * its reference, version and retention policy. No shared metadata registry. */
export function hostedObjectReference(owner: string, object: HostedStoredObject): string {
  const reference = `aw-object:v2:${owner}:${object.id}:${object.size}:${object.sha256}`
  parseLegacyHostedObject(owner, reference)
  return reference
}

/** The owner segment of a complete reference, without trusting the rest. */
export function hostedObjectReferenceOwner(reference: string): string | null {
  const parts = reference.split(':')
  return parts.length === 6 && parts[0] === 'aw-object' && parts[1] === 'v2' ? parts[2]! : null
}

export function parseLegacyHostedObject(owner: string, reference: string): HostedStoredObject {
  const parts = reference.split(':')
  if (
    parts.length !== 6 ||
    parts[0] !== 'aw-object' ||
    parts[1] !== 'v2' ||
    parts[2] !== owner ||
    !/^[a-z][a-z-]*$/.test(owner) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parts[3]!) ||
    !/^(0|[1-9][0-9]*)$/.test(parts[4]!) ||
    !/^[a-f0-9]{64}$/.test(parts[5]!)
  )
    throw new Error('hosted-object-reference-invalid')
  const size = Number(parts[4])
  if (!Number.isSafeInteger(size)) throw new Error('hosted-object-reference-invalid')
  return { id: parts[3]!, size, sha256: parts[5]! }
}

export function decodeLegacyHostedObject(owner: string, reference: string): ContentRef<string> {
  const object = parseLegacyHostedObject(owner, reference)
  return legacyContentRef('aw-object:v2', 'object', reference, {
    sha256: object.sha256,
    size: object.size,
  })
}

export { encodeLegacyContent as encodeLegacyHostedObject } from './contentRef'
