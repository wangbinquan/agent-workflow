import { legacyContentRef, type ContentRef } from '@/platform/content/contentRef'
import { z } from 'zod'
import { decodeReviewBody } from '@/platform/content/locations/review'
import {
  decodeHostedObject,
  hostedObjectReferenceOwner,
} from '@/platform/content/locations/hostedObject'
import {
  decodeSkillPath,
  decodeSkillTree,
  DATABASE_SKILL_ROOT,
} from '@/platform/content/locations/skill'
import { legacyLocationToContentRef } from '@/platform/persistence/migration/conversion/content'
import {
  encodeMigrationKey,
  canonicalValue,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type {
  SourceRow,
  TargetRef,
  TargetRow,
} from '@/platform/persistence/migration/conversion/types'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { decodeLegacySkillBytes, type LegacySkillBytes } from './skillContent'
import { hostedObjectRef, hostedReviewReceipt } from './hostedObjects'
import { explodeArchiveParts } from './archiveParts'

export interface ContentSlot {
  readonly column: string
  readonly originalReference: string | null
  readonly target: TargetRef
  readonly refColumn: string
  readonly bytesColumn: string
  readonly ref: ContentRef | null
  readonly required: boolean
  readonly fallback?: ContentRef
  readonly databaseBytes?: Uint8Array
  readonly catalogLocation?: ContentRef['location']
  readonly skill?: Omit<LegacySkillBytes, 'bytes'> & {
    readonly storedSize: number
    readonly actualSize: number
    readonly strippedBom: boolean
  }
  readonly part?: { readonly ordinal: number; readonly key: string }
  readonly receiptOnly?: boolean
}
export interface ContentColumnSpec {
  readonly table: string
  readonly sourceColumns: readonly string[]
}
export const contentTableSpecs: readonly ContentColumnSpec[] = [
  { table: 'collaboration_gate_artifacts', sourceColumns: ['staged_path', 'final_path'] },
  { table: 'development_object_artifacts', sourceColumns: ['object_id'] },
  { table: 'doc_versions', sourceColumns: ['body_path'] },
  { table: 'employee_reaction_artifacts', sourceColumns: ['body'] },
  { table: 'hosted_node_event_archives', sourceColumns: ['object_id'] },
  { table: 'hosted_task_archive_entries', sourceColumns: ['parts_json'] },
  { table: 'hosted_task_artifacts', sourceColumns: ['object_id'] },
  { table: 'node_run_outputs', sourceColumns: ['content'] },
  { table: 'review_comments', sourceColumns: ['comment_text'] },
  { table: 'skill_content_entries', sourceColumns: ['encoding', 'content'] },
  { table: 'skill_versions', sourceColumns: ['files_path'] },
  { table: 'skills', sourceColumns: ['managed_path'] },
]
export const contentSourceTables = [
  ...contentTableSpecs.map((spec) => spec.table),
  'hosted_object_publications',
]

export interface ContentSourceFacts {
  readonly reviewObjects: ReadonlyMap<string, ContentRef>
  readonly reviewFallbacks?: ReadonlyMap<string, ContentRef>
  readonly databaseSkillTrees: ReadonlySet<string>
  readonly portObjects: ReadonlyMap<string, ContentRef>
}
export const skillTreeKey = (skill: string, tree: string): string =>
  canonicalSchemaJson([skill, tree])

export function textColumn(row: SourceRow, column: string): string {
  const value = row.values[column]
  if (typeof value !== 'string') throw new Error(`v2-content-text-required:${column}`)
  return value
}
function numberColumn(row: SourceRow, column: string): number {
  const value = row.values[column]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`v2-content-number-required:${column}`)
  return value
}
function slot(
  row: SourceRow,
  column: string,
  ref: ContentRef | null,
  required = true,
): ContentSlot {
  return {
    column,
    originalReference: typeof row.values[column] === 'string' ? row.values[column] : null,
    target: { table: row.table, key: row.encodedKey },
    refColumn: 'content_ref_json',
    bytesColumn: 'content_inline_bytes',
    ref,
    required,
  }
}
function inline(row: SourceRow, column: string): ContentRef {
  return legacyLocationToContentRef({
    location: { codec: 'epoch1-inline', value: { table: row.table, key: row.key, column } },
    kind: 'inline',
    bytes: new TextEncoder().encode(textColumn(row, column)),
    ...(row.table === 'employee_reaction_artifacts'
      ? {
          metadata: { sha256: textColumn(row, 'digest'), size: numberColumn(row, 'bytes') },
        }
      : {}),
  })
}
function reviewRef(reference: string, facts: ContentSourceFacts): ContentRef {
  const recorded = facts.reviewObjects.get(reference)
  if (recorded) return recorded
  const owner = hostedObjectReferenceOwner(reference)
  return owner ? decodeHostedObject(owner, reference) : decodeReviewBody(reference)
}

export function decodeContentSlots(
  row: SourceRow,
  facts: ContentSourceFacts,
): readonly ContentSlot[] {
  switch (row.table) {
    case 'node_run_outputs': {
      const slots: ContentSlot[] = [
        slot(row, 'content', inline(row, 'content'), row.values.active === true),
      ]
      if (row.values.archive_json !== null && row.values.archive_json !== '') {
        const archive = z
          .object({
            v: z.literal(1),
            items: z.array(
              z
                .object({
                  path: z.string(),
                  file: z.string().nullable(),
                  size: z.number(),
                  truncated: z.boolean(),
                })
                .passthrough(),
            ),
          })
          .passthrough()
          .parse(JSON.parse(textColumn(row, 'archive_json')))
        for (const [ordinal, item] of archive.items.entries())
          if (item.file !== null) {
            const object = facts.portObjects.get(item.file)
            slots.push({
              ...slot(
                row,
                `archive_json.items[${ordinal}].file`,
                object
                  ? legacyContentRef('port-archive-file', 'object', item.file, {
                      sha256: object.sha256,
                      size: object.size,
                    })
                  : legacyContentRef('port-archive-file', 'local-file', item.file),
                row.values.active === true,
              ),
              originalReference: item.file,
              receiptOnly: true,
              ...(object ? { catalogLocation: object.location } : {}),
            })
          }
      }
      return slots
    }
    case 'review_comments':
      return [slot(row, 'comment_text', inline(row, 'comment_text'))]
    case 'employee_reaction_artifacts':
      return [slot(row, 'body', inline(row, 'body'))]
    case 'doc_versions': {
      const reference = textColumn(row, 'body_path')
      return [
        {
          ...slot(row, 'body_path', reviewRef(reference, facts)),
          fallback: facts.reviewFallbacks?.get(reference),
        },
      ]
    }
    case 'collaboration_gate_artifacts': {
      const receipt = hostedReviewReceipt(row)
      return ['staged_path', 'final_path'].map((column) => {
        const reference = textColumn(row, column)
        const ref = receipt
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
              size: numberColumn(row, 'byte_size'),
            })
        const required =
          column === 'staged_path'
            ? row.values.state === 'staged'
            : row.values.state === 'consumed' || row.values.state === 'finalized'
        return {
          ...slot(row, column, ref, required),
          ...(column === 'final_path' ? { fallback: facts.reviewFallbacks?.get(reference) } : {}),
          ...(receipt
            ? { catalogLocation: { codec: 'hosted-object-id', value: receipt.object.id } }
            : {}),
          ...(column === 'staged_path'
            ? { refColumn: 'staged_content_ref_json', bytesColumn: 'staged_inline_bytes' }
            : {}),
        }
      })
    }
    case 'development_object_artifacts':
    case 'hosted_task_artifacts':
    case 'hosted_node_event_archives':
    case 'hosted_object_publications': {
      const publication = row.table === 'hosted_object_publications'
      const ref =
        row.values.object_id === null
          ? null
          : hostedObjectRef(
              textColumn(row, 'object_id'),
              textColumn(row, publication ? 'sha256' : 'digest'),
              numberColumn(row, 'size'),
              row.table === 'hosted_node_event_archives' ? 'application/x-ndjson' : null,
            )
      return [
        {
          ...slot(
            row,
            'object_id',
            ref,
            row.table === 'hosted_task_artifacts' ||
              row.table === 'development_object_artifacts' ||
              (publication && row.values.state === 'ready'),
          ),
          ...(publication
            ? {
                target: {
                  table: 'content_publications',
                  key: encodeMigrationKey('content_publications', row.key),
                },
              }
            : {}),
        },
      ]
    }
    case 'hosted_task_archive_entries':
      return explodeArchiveParts(row).map((part) => ({
        ...slot(row, 'parts_json', part.ref, false),
        originalReference: canonicalSchemaJson({
          key: part.key,
          id: part.ref.location.value,
          sha256: part.ref.sha256,
          size: part.ref.size,
        }),
        target: {
          table: 'hosted_task_archive_entry_parts',
          key: encodeMigrationKey('hosted_task_archive_entry_parts', [
            canonicalValue(row.values.path!),
            canonicalValue(part.ordinal),
          ]),
        },
        part: { ordinal: part.ordinal, key: part.key },
      }))
    case 'skill_content_entries': {
      const { bytes, ...skill } = decodeLegacySkillBytes(
        textColumn(row, 'encoding'),
        textColumn(row, 'content'),
      )
      const storedSize = numberColumn(row, 'size')
      const strippedBom =
        row.values.encoding === 'utf8' && !skill.bom && storedSize === bytes.byteLength + 3
      if (bytes.byteLength !== storedSize && !strippedBom) throw new Error('v2-skill-size-mismatch')
      return [
        {
          ...slot(
            row,
            'content',
            decodeSkillTree(
              textColumn(row, 'skill_id'),
              textColumn(row, 'tree'),
              textColumn(row, 'path'),
            ),
          ),
          databaseBytes: bytes,
          skill: { ...skill, storedSize, actualSize: bytes.byteLength, strippedBom },
        },
      ]
    }
    case 'skills':
    case 'skill_versions': {
      const live = row.table === 'skills'
      const column = live ? 'managed_path' : 'files_path'
      if (row.values[column] === null) return [slot(row, column, null, false)]
      const path = textColumn(row, column)
      const skill = textColumn(row, live ? 'id' : 'skill_id')
      const tree = live ? 'live' : `version:${numberColumn(row, 'version_index')}`
      const database =
        path === DATABASE_SKILL_ROOT || facts.databaseSkillTrees.has(skillTreeKey(skill, tree))
      return [
        slot(
          row,
          column,
          database
            ? legacyContentRef('skill-tree', 'database-bytes', { skillId: skill, tree })
            : decodeSkillPath(path),
        ),
      ]
    }
    default:
      throw new Error(`v2-content-table-unknown:${row.table}`)
  }
}

export function contentBaseRow(row: SourceRow): TargetRow {
  const omitted =
    row.table === 'hosted_object_publications'
      ? ['object_id']
      : contentTableSpecs.find((spec) => spec.table === row.table)!.sourceColumns
  return Object.fromEntries(
    Object.entries(row.values).filter(([column]) => !omitted.includes(column)),
  )
}
