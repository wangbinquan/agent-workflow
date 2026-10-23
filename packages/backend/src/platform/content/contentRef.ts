/** RFC-395 II-a: locations are adapter data, never a domain identity.
 * Null metadata means the legacy reference did not record that fact. Decoders
 * must not invent a digest, byte length or content id without reading bytes. */
export interface ContentMetadata {
  readonly contentId: string | null
  readonly contentVersion: number | null
  readonly sha256: string | null
  readonly size: number | null
  readonly mediaType: string | null
}

export interface ContentLocation<T = unknown> {
  readonly codec: string
  readonly value: T
}

type ContentBase<T> = ContentMetadata & {
  readonly version: 1
  readonly location: ContentLocation<T>
}

export type ContentRef<T = unknown> = ContentBase<T> &
  (
    | { readonly kind: 'inline'; readonly bytes: Uint8Array }
    | { readonly kind: 'local-file' }
    | { readonly kind: 'database-bytes' }
    | { readonly kind: 'object' }
  )

export function legacyContentRef<T>(
  codec: string,
  kind: Exclude<ContentRef['kind'], 'inline'>,
  value: T,
  metadata: Partial<ContentMetadata> = {},
): ContentRef<T> {
  return {
    version: 1,
    kind,
    location: { codec, value },
    contentId: null,
    contentVersion: null,
    sha256: null,
    size: null,
    mediaType: null,
    ...metadata,
  }
}

/** Re-encoding a decoded legacy value never normalizes or serializes it again. */
export function encodeLegacyContent<T>(ref: ContentRef<T>): T {
  return ref.location.value
}
