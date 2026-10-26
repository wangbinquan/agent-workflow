import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { sha256Hex } from '@/util/hash'

export interface SkillTreeEntry {
  readonly path: string
  readonly size: number
  readonly sha256: string
}
export function skillTreeManifestBytes(entries: readonly SkillTreeEntry[]): Uint8Array {
  const sorted = [...entries].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)),
  )
  if (new Set(sorted.map((entry) => entry.path)).size !== sorted.length)
    throw new Error('skill-tree-duplicate-path')
  return new TextEncoder().encode(
    canonicalSchemaJson({ format: 'skill-tree-manifest@1', entries: sorted }),
  )
}
export function contentByteFacts(bytes: Uint8Array): {
  readonly size: number
  readonly sha256: string
} {
  return { size: bytes.byteLength, sha256: sha256Hex(bytes) }
}
