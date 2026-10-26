import type { ContentLocation, ContentRef } from '@/platform/content/contentRef'
import { legacyContentRef } from '@/platform/content/contentRef'
import { decodeReviewBody } from '@/platform/content/locations/review'
import {
  parseHostedObject,
  hostedObjectReferenceOwner,
} from '@/platform/content/locations/hostedObject'
import { lookupKey, type LookupBuilder } from '@/platform/persistence/migration/conversion/lookups'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { EncodedKey, SourceRow } from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import {
  contentSourceTables,
  decodeContentSlots,
  skillTreeKey,
  textColumn,
  type ContentSlot,
} from './specs'
import { hostedReviewReceipt } from './hostedObjects'

export interface CatalogObject {
  readonly id: string
  readonly location: ContentLocation
  readonly kind: 'object' | 'database-bytes'
  readonly ownerKey: EncodedKey
  readonly ownerSlot: string
  readonly sha256: string | null
  readonly size: number | null
  readonly mediaType: string | null
  readonly shared: boolean
  readonly conflict: boolean
}
export type CatalogSlot = ContentSlot & { readonly catalog?: CatalogObject }
export interface ContentCatalogRow {
  readonly slots: readonly CatalogSlot[]
  readonly error: string | null
}
export const CONTENT_CATALOG = lookupKey<ContentCatalogRow>('content/catalog', 4)
export function contentSlotKey(slot: ContentSlot): string {
  return canonicalSchemaJson([slot.column, slot.part?.ordinal ?? null])
}
function objectLocation(slot: ContentSlot): ContentLocation | null {
  if (slot.catalogLocation) return slot.catalogLocation
  const ref = slot.ref
  if (!ref) return null
  if (slot.databaseBytes) return ref.location
  if (ref.kind !== 'object') return null
  if (ref.location.codec === 'review-object') {
    const value = ref.location.value as { objectId: string }
    return { codec: 'hosted-object-id', value: value.objectId }
  }
  if (ref.location.codec === 'aw-object:v2' && typeof ref.location.value === 'string') {
    const owner = hostedObjectReferenceOwner(ref.location.value)!
    return {
      codec: 'hosted-object-id',
      value: parseHostedObject(owner, ref.location.value).id,
    }
  }
  return ref.location
}

export const contentCatalogLookup: LookupBuilder<ContentCatalogRow> = {
  key: CONTENT_CATALOG,
  sources: [...contentSourceTables, 'collaboration_gate_operations'],
  build(staged, put) {
    const rows = contentSourceTables
      .flatMap((table) => [...staged.rows(table)])
      .filter((row) => !row.codecFailure)
      .sort((a, b) => (a.encodedKey < b.encodedKey ? -1 : a.encodedKey > b.encodedKey ? 1 : 0))
    const reviewObjects = new Map<string, ContentRef>()
    const reviewFallbacks = new Map<string, ContentRef>()
    const committedOperations = new Set(
      [...staged.rows('collaboration_gate_operations')]
        .filter(
          (row) =>
            !row.codecFailure && ['committed', 'completed'].includes(String(row.values.state)),
        )
        .map((row) => row.values.id),
    )
    const invalidReviewPaths = new Set<string>()
    const databaseSkillTrees = new Set<string>()
    const portObjects = new Map<string, ContentRef>()
    for (const row of rows) {
      if (row.table === 'skill_content_entries')
        databaseSkillTrees.add(skillTreeKey(textColumn(row, 'skill_id'), textColumn(row, 'tree')))
      if (row.table === 'hosted_task_artifacts' && typeof row.values.object_id === 'string')
        portObjects.set(
          textColumn(row, 'reference'),
          legacyContentRef('hosted-object-id', 'object', row.values.object_id, {
            sha256: textColumn(row, 'digest'),
            size: row.values.size as number,
          }),
        )
      if (row.table !== 'collaboration_gate_artifacts') continue
      try {
        const receipt = hostedReviewReceipt(row)
        if (
          committedOperations.has(row.values.operation_id) &&
          ['consumed', 'finalized'].includes(String(row.values.state))
        ) {
          const reference = textColumn(row, 'staged_path')
          const fallback = receipt
            ? legacyContentRef(
                'review-object',
                'object',
                { reference, objectId: receipt.object.id },
                {
                  sha256: receipt.object.sha256,
                  size: receipt.object.size,
                  mediaType: 'text/markdown',
                },
              )
            : decodeReviewBody(reference, {
                sha256: textColumn(row, 'sha256'),
                size: row.values.byte_size as number,
              })
          reviewFallbacks.set(textColumn(row, 'final_path'), fallback)
        }
        if (!receipt) continue
        for (const reference of [receipt.stagedPath, receipt.finalPath]) {
          const ref = legacyContentRef(
            'review-object',
            'object',
            { reference, objectId: receipt.object.id },
            {
              sha256: receipt.object.sha256,
              size: receipt.object.size,
              mediaType: 'text/markdown',
            },
          )
          const previous = reviewObjects.get(reference)
          if (previous && canonicalSchemaJson(previous) !== canonicalSchemaJson(ref))
            invalidReviewPaths.add(reference)
          reviewObjects.set(reference, ref)
        }
      } catch {
        for (const column of ['staged_path', 'final_path'])
          if (typeof row.values[column] === 'string') invalidReviewPaths.add(row.values[column])
      }
    }
    const decoded = new Map<EncodedKey, ContentCatalogRow>()
    const objects = new Map<string, { row: SourceRow; slot: ContentSlot }[]>()
    for (const row of rows) {
      try {
        if (row.table === 'doc_versions' && invalidReviewPaths.has(textColumn(row, 'body_path')))
          throw new Error('v2-review-object-ambiguous')
        const slots = decodeContentSlots(row, {
          reviewObjects,
          reviewFallbacks,
          databaseSkillTrees,
          portObjects,
        })
        decoded.set(row.encodedKey, { slots, error: null })
        for (const slot of slots) {
          const location = objectLocation(slot)
          if (!location) continue
          const key = canonicalSchemaJson(location)
          const entries = objects.get(key) ?? []
          entries.push({ row, slot })
          objects.set(key, entries)
        }
      } catch (error) {
        decoded.set(row.encodedKey, {
          slots: [],
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const catalogs = new Map<string, CatalogObject>()
    for (const [key, entries] of objects) {
      const first = entries[0]!
      const digests = new Set(
        entries
          .map(({ slot }) =>
            slot.databaseBytes ? bytesDigest(slot.databaseBytes).slice(7) : slot.ref!.sha256,
          )
          .filter((value) => value !== null),
      )
      const sizes = new Set(
        entries
          .map(({ slot }) => slot.databaseBytes?.byteLength ?? slot.ref!.size)
          .filter((value) => value !== null),
      )
      const types = new Set(entries.map(({ slot }) => slot.ref!.mediaType))
      catalogs.set(key, {
        id: deterministicChildId(
          'content-object',
          encodeMigrationKey('content-location', [canonicalValue(key)]),
        ),
        location: objectLocation(first.slot)!,
        kind: first.slot.databaseBytes ? 'database-bytes' : 'object',
        ownerKey: first.row.encodedKey,
        ownerSlot: contentSlotKey(first.slot),
        sha256: [...digests][0] ?? null,
        size: [...sizes][0] ?? null,
        mediaType: types.size === 1 ? [...types][0]! : null,
        shared: entries.length > 1,
        conflict: digests.size > 1 || sizes.size > 1,
      })
    }
    for (const [key, value] of decoded)
      put(key, {
        ...value,
        slots: value.slots.map((slot) => {
          const location = objectLocation(slot)
          return location
            ? { ...slot, catalog: catalogs.get(canonicalSchemaJson(location))! }
            : slot
        }),
      })
  },
}
