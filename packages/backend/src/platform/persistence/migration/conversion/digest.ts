import { createSha256DigestBuilder } from '@/util/hash'
import { canonicalSchemaJson } from '../../schema/canonical'
import type { TargetRow } from './types'
import { canonicalValue } from './migrationKey'

export function bytesDigest(bytes: string | Uint8Array): string {
  const builder = createSha256DigestBuilder()
  builder.update(bytes)
  return `sha256:${builder.digestHex()}`
}
export function valueDigest(value: unknown): string {
  return bytesDigest(canonicalSchemaJson(value))
}
/** Sorted, length-framed multiset: duplicate rows remain significant. */
export function orderedDigest(values: Iterable<string>): string {
  const builder = createSha256DigestBuilder()
  for (const value of values) {
    builder.update(`${Buffer.byteLength(value)}:`)
    builder.update(value)
  }
  return `sha256:${builder.digestHex()}`
}
export function unorderedDigest(values: Iterable<string>): string {
  return orderedDigest([...values].sort())
}
export function targetRowJson(row: TargetRow): string {
  return canonicalSchemaJson(
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, canonicalValue(value)])),
  )
}
export function targetRowsDigest(rows: readonly TargetRow[]): string {
  return unorderedDigest(rows.map(targetRowJson))
}
