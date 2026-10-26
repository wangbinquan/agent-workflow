import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import { intentApplyArtifactCodecs } from '../intentApplyArtifactCodec'
import { decodeCurrentIntentArtifact } from '../intentApplyCurrentCodec'
import { decodeLegacyIntentApplyArtifacts } from './intentApplyLegacyCodec'

export function reencodeIntentApplyArtifacts(json: string): string {
  const value: unknown = JSON.parse(json)
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'scene' in value) {
    const envelope = value as { scene: unknown; version?: unknown; artifacts?: unknown }
    if (envelope.scene === 'intent' && envelope.version === 3)
      return intentApplyArtifactCodecs.encode(intentApplyArtifactCodecs.decode(json))
    if (envelope.scene !== 'intent' || envelope.version !== 2 || !Array.isArray(envelope.artifacts))
      throw new Error('intent-source-artifact-version-unsupported')
    const artifacts = envelope.artifacts.map((entry: unknown) => {
      const artifact = decodeCurrentIntentArtifact(entry)
      if (artifact === null) throw new Error('intent-source-artifact-invalid')
      return artifact
    })
    return intentApplyArtifactCodecs.encode(artifacts)
  }
  const artifacts: IntentApplyArtifact[] = []
  for (const source of decodeLegacyIntentApplyArtifacts(value)) {
    if (source.kind === 'legacy-plugin-install-untracked') continue
    if (source.kind === 'plugin-install' || 'operationId' in source) {
      artifacts.push(source)
    } else if (source.kind === 'skill-stage') {
      artifacts.push({
        kind: 'skill-stage',
        skillId: source.skillId,
        operationId: source.opId,
        stagingDirectory: source.skillDir,
        recovery: { kind: 'create', operationId: source.opId, rootDirectory: source.skillDir },
      })
    } else {
      const staged = source.staged
      if (staged.noop !== null) continue
      artifacts.push({
        kind: 'skill-version-stage',
        skillId: staged.skillId,
        operationId: staged.publishId,
        version: staged.newVersion,
        stagingDirectory: staged.stagingDir,
        versionDirectory: staged.versionDir,
        recovery: {
          kind: 'version',
          operationId: staged.opId,
          publishId: staged.publishId,
          skillName: staged.skillName,
          contentHash: staged.newHash,
          liveDirectory: staged.filesDir,
        },
      })
    }
  }
  return intentApplyArtifactCodecs.encode(artifacts)
}

export const applyJournalRule: ConversionRule = {
  ref: { id: 'intent/apply-journal-profile', version: 3 },
  owner: 'intent',
  claims: ['intent_apply_journal'],
  codecTakeovers: [
    { table: 'intent_apply_journal', columns: ['prepared_artifacts_json', 'receipt_json'] },
  ],
  produces: [{ table: 'intent_apply_journal' }],
  lookups: [],
  unit: { kind: 'source-chunk', table: 'intent_apply_journal' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('intent_apply_journal') ?? []) {
      const archive = ctx.out.archive({
        kind: 'source-journal',
        sourceTable: row.table,
        format: 'logical-row@1',
        bytes: new TextEncoder().encode(encodeStagedValue(row)),
        rows: 1,
      })
      let preparedArtifactsJson: string
      try {
        if (row.codecTakeovers?.length) throw new Error('intent-source-journal-json-invalid')
        preparedArtifactsJson = reencodeIntentApplyArtifacts(
          String(row.values.prepared_artifacts_json),
        )
      } catch (error) {
        if (row.values.state === 'failed') {
          const values = {
            ...row.values,
            prepared_artifacts_json: intentApplyArtifactCodecs.encode([]),
            receipt_json: row.codecTakeovers?.some((failure) => failure.column === 'receipt_json')
              ? null
              : row.values.receipt_json!,
          }
          ctx.out.row(row.table, values, row)
          const disposition = {
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            sourcePhase: row.phase,
            targets: [{ table: row.table, key: ctx.target.key(row.table, values) }],
            archive,
            decision: {
              code: 'v2-intent-artifact-history-only',
              detail: {
                state: 'failed',
                error: error instanceof Error ? error.message : String(error),
              },
            },
          }
          // Codec repairs are recorded separately from the final archived disposition.
          if (row.codecTakeovers?.length)
            ctx.out.exception({
              ...disposition,
              class: 'converted',
              kind: 'conflict-resolved',
              codecColumns: row.codecTakeovers.map((failure) => failure.column),
            })
          ctx.out.exception({ ...disposition, class: 'archived', kind: 'archived' })
          continue
        }
        ctx.out.record(
          {
            kind: 'decision',
            code: 'v2-intent-artifact-source-archived',
            payload: { archive, sourceKey: row.encodedKey },
          },
          row,
        )
        ctx.out.block(
          rowBlock(
            'v2-intent-artifact-undecodable',
            row,
            { archive, error: error instanceof Error ? error.message : String(error) },
            row.codecTakeovers?.length
              ? row.codecTakeovers.map((failure) => failure.column)
              : ['prepared_artifacts_json'],
          ),
        )
        continue
      }
      const values = { ...row.values, prepared_artifacts_json: preparedArtifactsJson }
      ctx.out.row(row.table, values, row)
      ctx.out.exception({
        sourceTable: row.table,
        sourceKey: row.encodedKey,
        sourcePhase: row.phase,
        class: 'converted',
        kind: 'conflict-resolved',
        targets: [{ table: row.table, key: ctx.target.key(row.table, values) }],
        archive,
        decision: {
          code: 'v2-intent-artifact-envelope',
          detail: { version: 3, noops: 'omitted-with-source-archive' },
        },
      })
    }
  },
}
