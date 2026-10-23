import { z } from 'zod'
import { createAtomicApplyCodecRegistry } from '@/platform/atomic-apply/codecRegistry'
import type {
  AtomicApplyArtifactCodec,
  AtomicApplyWriteFormat,
} from '@/platform/contracts/atomicApply'
import {
  ResourcePackageArtifactSchema,
  ResourcePackageReceiptSchema,
  type ResourcePackageCurrentArtifact,
} from './resourcePackageCurrentCodec'
import {
  decodeLegacyResourcePackageArtifacts,
  decodeLegacyResourcePackageArtifactArray,
  type LegacyArtifact,
} from './resourcePackageLegacyCodec'
import { assertCommittedApplyReceipt } from '../domain/resourcePackageApplyReceipt'

export type ResourcePackageRecoveryArtifact = ResourcePackageCurrentArtifact | LegacyArtifact
export function createResourcePackageArtifactCodecs(
  writeFormat: AtomicApplyWriteFormat = 'head-array',
) {
  return createAtomicApplyCodecRegistry({
    writeFormat,
    scene: 'resource-package',
    currentVersion: 1,
    versions: new Map<number | 'legacy', AtomicApplyArtifactCodec<ResourcePackageRecoveryArtifact>>(
      [
        [
          1,
          {
            decode: (value) => z.array(ResourcePackageArtifactSchema).parse(value),
            encode: (value) => value,
          },
        ],
        [
          'legacy',
          {
            decode: decodeLegacyResourcePackageArtifacts,
            encode() {
              throw new Error('resource-package-legacy-codec-read-only')
            },
          },
        ],
      ],
    ),
  })
}

// RFC-395 II-a A6：II-b 激活时才切为 versioned-envelope；当前逐字保留旧数组写法。
export const resourcePackageArtifactCodecs = createResourcePackageArtifactCodecs()

export const decodeResourcePackageArtifacts = resourcePackageArtifactCodecs.decode
export function decodeResourcePackageReceiptJson(json: string) {
  return ResourcePackageReceiptSchema.parse(JSON.parse(json))
}
export function decodeResourcePackageReceipt(journal: {
  readonly id: string
  readonly receiptJson: string | null
}) {
  return decodeResourcePackageReceiptJson(assertCommittedApplyReceipt(journal))
}
export function isCurrentResourcePackageArtifact(
  artifact: ResourcePackageRecoveryArtifact,
): artifact is ResourcePackageCurrentArtifact {
  return 'operationId' in artifact
}

/** 在任何 effect 前选整行格式；保留旧 SQLite 对 artifacts + receipt 的配对语义。 */
export function decodeResourcePackageRecoveryRow(
  journal: {
    readonly id: string
    readonly preparedArtifactsJson: string
    readonly receiptJson: string | null
  },
  operation: 'rollForward' | 'compensate',
) {
  const receipt =
    operation === 'rollForward'
      ? (JSON.parse(assertCommittedApplyReceipt(journal)) as unknown)
      : undefined
  const value: unknown = JSON.parse(journal.preparedArtifactsJson)
  if (Array.isArray(value)) {
    const current = z.array(ResourcePackageArtifactSchema).safeParse(value)
    if (
      current.success &&
      (operation === 'compensate' || ResourcePackageReceiptSchema.safeParse(receipt).success)
    )
      return { format: 'current' as const, artifacts: current.data }
    return { format: 'legacy' as const, artifacts: decodeLegacyResourcePackageArtifactArray(value) }
  }
  const artifacts = resourcePackageArtifactCodecs.decode(journal.preparedArtifactsJson)
  if (operation === 'rollForward') ResourcePackageReceiptSchema.parse(receipt)
  return { format: 'current' as const, artifacts }
}
