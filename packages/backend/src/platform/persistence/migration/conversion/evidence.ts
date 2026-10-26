import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { canonicalSchemaJson } from '../../schema/canonical'
import type { JsonValue, SourceRow, TargetRow } from './types'
import { legacyLocationToContentRef } from './content'

export interface LegacyEvidence {
  readonly origin: SourceRow
  readonly taskId: string | null
  readonly recordKind: 'task' | 'task-repo' | 'node-run'
  readonly recordId: string
  readonly quality: 'recorded' | 'legacy-derived' | 'unknown'
  readonly missingFields: readonly string[]
  readonly detail: JsonValue
}
export function legacyEvidenceRow(evidence: LegacyEvidence, sourceContract: string): TargetRow {
  if (!['task', 'task-repo', 'node-run'].includes(evidence.recordKind))
    throw new Error('v2-evidence-record-kind')
  const bytes = Buffer.from(
    canonicalSchemaJson({
      source: evidence.origin.canonical,
      raw: evidence.origin.raw ?? null,
      detail: evidence.detail,
    }),
  )
  const columns = encodeContentRefColumns(
    legacyLocationToContentRef({
      kind: 'inline',
      location: { codec: 'execution-legacy-evidence@1', value: evidence.origin.encodedKey },
      bytes,
      metadata: { mediaType: 'application/json' },
    }),
  )
  return {
    task_id: evidence.taskId,
    record_kind: evidence.recordKind,
    record_id: evidence.recordId,
    source_contract: sourceContract,
    provenance_quality: evidence.quality,
    missing_fields_json: canonicalSchemaJson(evidence.missingFields),
    content_ref_json: columns.json,
    content_inline_bytes: columns.inlineBytes,
  }
}
