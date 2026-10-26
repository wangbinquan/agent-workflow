import { z } from 'zod'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import {
  resourcePackageArtifactCodecs,
  type ResourcePackageRecoveryArtifact,
} from '../resourcePackageArtifactCodec'
import {
  ResourcePackageArtifactSchema,
  ResourcePackageReceiptSchema,
  type ResourcePackageCurrentReceipt,
} from '../resourcePackageCurrentCodec'
import { decodeLegacyResourcePackageArtifacts } from './resourcePackageLegacyCodec'

export function reencodeBundleApplyReceipt(json: string | null): string | null {
  if (json === null) return null
  const value = z.record(z.string(), z.unknown()).parse(JSON.parse(json))
  let changed = false
  const applied = z
    .array(z.record(z.string(), z.unknown()))
    .parse(value.applied)
    .map((entry) => {
      if (!Object.hasOwn(entry, 'opId')) return entry
      const { opId, ...rest } = entry
      if (rest.operationId !== undefined && rest.operationId !== opId)
        throw new Error('resource-package-source-operation-identity-conflict')
      changed = true
      return { ...rest, operationId: opId }
    })
  const receipt = ResourcePackageReceiptSchema.parse({ ...value, applied })
  return changed ? JSON.stringify(receipt) : json
}

export function reencodeBundleApplyArtifacts(json: string, receiptJson: string | null): string {
  const value: unknown = JSON.parse(json)
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'scene' in value) {
    const envelope = value as { scene: unknown; version?: unknown; artifacts?: unknown }
    if (envelope.scene === 'resource-package' && envelope.version === 2)
      return resourcePackageArtifactCodecs.encode(resourcePackageArtifactCodecs.decode(json))
    if (envelope.scene !== 'resource-package' || envelope.version !== 1)
      throw new Error('resource-package-source-artifact-version-unsupported')
    return resourcePackageArtifactCodecs.encode(
      z.array(ResourcePackageArtifactSchema).parse(envelope.artifacts),
    )
  }
  const receipt: ResourcePackageCurrentReceipt | null =
    receiptJson === null ? null : ResourcePackageReceiptSchema.parse(JSON.parse(receiptJson))
  const operationId = (resourceType: 'skill' | 'plugin', resourceId: string, persisted: string) => {
    const matches =
      receipt?.applied.filter(
        (entry) => entry.resourceType === resourceType && entry.resourceId === resourceId,
      ) ?? []
    if (matches.length > 1) throw new Error('resource-package-source-operation-identity-ambiguous')
    if (receipt !== null && matches.length === 0)
      throw new Error('resource-package-source-operation-identity-missing')
    // Before commit there is no receipt; preserve the recorded effect identity.
    return matches[0]?.operationId ?? persisted
  }
  const artifacts: ResourcePackageRecoveryArtifact[] = []
  for (const source of decodeLegacyResourcePackageArtifacts(value)) {
    if ('operationId' in source) {
      artifacts.push(source)
      continue
    }
    if (source.kind === 'plugin-install') {
      artifacts.push({
        kind: source.kind,
        pluginId: source.pluginId,
        generationId: source.generationId,
        generationDirectory: source.generationDir,
        operationId: operationId('plugin', source.pluginId, source.generationId),
      })
    } else if (source.kind === 'skill-stage') {
      artifacts.push({
        kind: source.kind,
        skillId: source.skillId,
        operationId: operationId('skill', source.skillId, source.opId),
        stagingDirectory: source.skillDir,
        targetDirectory: source.skillDir,
        recovery: { kind: 'create', operationId: source.opId, rootDirectory: source.skillDir },
      })
    } else {
      const staged = source.staged
      if (staged.noop !== null) continue
      artifacts.push({
        kind: source.kind,
        skillId: staged.skillId,
        operationId: operationId('skill', staged.skillId, staged.publishId),
        publishId: staged.publishId,
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
  return resourcePackageArtifactCodecs.encode(artifacts)
}

export const bundleAppliesRule: ConversionRule = {
  ref: { id: 'resource-catalog/bundle-applies-profile', version: 3 },
  owner: 'resource-catalog',
  claims: ['resource_bundle_applies'],
  codecTakeovers: [
    { table: 'resource_bundle_applies', columns: ['prepared_artifacts_json', 'receipt_json'] },
  ],
  produces: [{ table: 'resource_bundle_applies' }],
  lookups: [],
  unit: { kind: 'source-chunk', table: 'resource_bundle_applies' },
  convert(unit, ctx) {
    for (const row of unit.rows.get('resource_bundle_applies') ?? []) {
      const archive = ctx.out.archive({
        kind: 'source-journal',
        sourceTable: row.table,
        format: 'logical-row@1',
        bytes: new TextEncoder().encode(encodeStagedValue(row)),
        rows: 1,
      })
      let receiptJson: string | null
      let preparedArtifactsJson: string
      try {
        if (row.codecTakeovers?.length)
          throw new Error('resource-package-source-journal-json-invalid')
        receiptJson = reencodeBundleApplyReceipt(
          row.values.receipt_json === null ? null : String(row.values.receipt_json),
        )
        if (row.values.state === 'committed') {
          if (
            receiptJson === null ||
            ResourcePackageReceiptSchema.parse(JSON.parse(receiptJson)).journalId !== row.values.id
          )
            throw new Error('resource-package-source-receipt-mismatch')
        }
        preparedArtifactsJson = reencodeBundleApplyArtifacts(
          String(row.values.prepared_artifacts_json),
          receiptJson,
        )
      } catch (error) {
        if (row.values.state === 'failed') {
          const values = {
            ...row.values,
            prepared_artifacts_json: resourcePackageArtifactCodecs.encode([]),
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
              code: 'v2-bundle-artifact-history-only',
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
            code: 'v2-bundle-artifact-source-archived',
            payload: { archive, sourceKey: row.encodedKey },
          },
          row,
        )
        ctx.out.block(
          rowBlock(
            'v2-bundle-artifact-undecodable',
            row,
            { archive, error: error instanceof Error ? error.message : String(error) },
            ['prepared_artifacts_json', 'receipt_json'],
          ),
        )
        continue
      }
      const values = {
        ...row.values,
        prepared_artifacts_json: preparedArtifactsJson,
        receipt_json: receiptJson,
      }
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
          code: 'v2-bundle-artifact-envelope',
          detail: {
            version: 2,
            identity: 'persisted-effect-and-receipt',
            noops: 'omitted-with-source-archive',
          },
        },
      })
    }
  },
}
