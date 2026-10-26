import {
  legacyContentRef,
  type ContentLocation,
  type ContentMetadata,
  type ContentRef,
} from '@/platform/content/contentRef'
import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import type { ArtifactReceipt, SourceRow, TargetRef } from './types'
import { bytesDigest } from './digest'

export type ContentStat =
  | { readonly state: 'present'; readonly size: number; readonly sha256: string }
  | {
      readonly state: 'absent'
      readonly cause: 'originally-absent' | 'missing-at-freeze'
      readonly evidence: string
    }
export interface ContentInventory {
  stat(location: ContentLocation): Promise<ContentStat>
  read(location: ContentLocation): Promise<Uint8Array>
}
export function legacyLocationToContentRef<T>(input: {
  readonly location: ContentLocation<T>
  readonly kind: ContentRef['kind']
  readonly bytes?: Uint8Array
  readonly metadata?: Partial<ContentMetadata>
}): ContentRef<T> {
  const base = legacyContentRef(
    input.location.codec,
    input.kind === 'inline' ? 'local-file' : input.kind,
    input.location.value,
    input.metadata,
  )
  if (input.kind !== 'inline') {
    encodeContentRefColumns(base)
    return base
  }
  if (!input.bytes) throw new Error('v2-inline-bytes-required')
  const digest = bytesDigest(input.bytes).slice(7)
  if (base.size !== null && base.size !== input.bytes.byteLength)
    throw new Error('v2-content-size-mismatch')
  if (base.sha256 !== null && base.sha256 !== digest) throw new Error('v2-content-digest-mismatch')
  const ref: ContentRef<T> = {
    ...base,
    kind: 'inline',
    bytes: Uint8Array.from(input.bytes),
    size: input.bytes.byteLength,
    sha256: digest,
  }
  encodeContentRefColumns(ref)
  return ref
}
export function artifactReceipt(input: {
  readonly source: SourceRow
  readonly column: string
  readonly originalReference: string | null
  readonly target: TargetRef
  readonly ref: ContentRef
  readonly stat?: ContentStat
  readonly publication?: ArtifactReceipt['publication']
}): ArtifactReceipt {
  const ref = input.ref
  const stat =
    input.stat ??
    (ref.kind === 'inline'
      ? {
          state: 'present' as const,
          size: ref.bytes.byteLength,
          sha256: bytesDigest(ref.bytes).slice(7),
        }
      : undefined)
  if (!stat) throw new Error('v2-content-inventory-required')
  if (
    stat.state === 'present' &&
    ((ref.size !== null && ref.size !== stat.size) ||
      (ref.sha256 !== null && ref.sha256 !== stat.sha256))
  )
    throw new Error('v2-content-inventory-mismatch')
  return {
    sourceTable: input.source.table,
    sourceKey: input.source.encodedKey,
    sourceColumn: input.column,
    originalReference: input.originalReference,
    target: { ...input.target, contentId: ref.contentId, backend: ref.kind },
    bytes: stat.state === 'present' ? { sha256: stat.sha256, size: stat.size } : null,
    publication: input.publication ?? 'not-required',
    missing: stat.state === 'absent' ? { state: stat.cause, evidence: stat.evidence } : null,
  }
}
