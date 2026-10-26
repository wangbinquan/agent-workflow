import { z } from 'zod'
import type { ContentRef } from './contentRef'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { createSha256DigestBuilder } from '@/util/hash'

const envelope = z.strictObject({
  version: z.literal(1),
  kind: z.enum(['inline', 'local-file', 'database-bytes', 'object']),
  location: z.strictObject({ codec: z.string().min(1), value: z.json() }),
  contentId: z.string().nullable(),
  contentVersion: z.number().int().nonnegative().nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  size: z.number().int().nonnegative().nullable(),
  mediaType: z.string().nullable(),
})
export function decodeContentRefColumns(
  json: string | null,
  inlineBytes: Uint8Array | null,
): ContentRef | null {
  if (json === null) {
    if (inlineBytes !== null) throw new Error('content-ref-bytes-without-reference')
    return null
  }
  const ref = envelope.parse(JSON.parse(json))
  if (ref.kind !== 'inline') {
    if (inlineBytes !== null) throw new Error('content-ref-external-inline-bytes')
    return ref as ContentRef
  }
  if (!(inlineBytes instanceof Uint8Array)) throw new Error('content-ref-inline-bytes-missing')
  if (ref.size !== null && ref.size !== inlineBytes.byteLength)
    throw new Error('content-ref-size-mismatch')
  if (ref.sha256 !== null) {
    const hash = createSha256DigestBuilder()
    hash.update(inlineBytes)
    if (ref.sha256 !== hash.digestHex()) throw new Error('content-ref-digest-mismatch')
  }
  return { ...ref, kind: 'inline', bytes: Uint8Array.from(inlineBytes) }
}
export function encodeContentRefColumns(ref: ContentRef): {
  json: string
  inlineBytes: Uint8Array | null
} {
  const inlineBytes = ref.kind === 'inline' ? Uint8Array.from(ref.bytes) : null
  const json = canonicalSchemaJson(
    envelope.parse({
      version: ref.version,
      kind: ref.kind,
      location: ref.location,
      contentId: ref.contentId,
      contentVersion: ref.contentVersion,
      sha256: ref.sha256,
      size: ref.size,
      mediaType: ref.mediaType,
    }),
  )
  decodeContentRefColumns(json, inlineBytes)
  return { json, inlineBytes }
}
