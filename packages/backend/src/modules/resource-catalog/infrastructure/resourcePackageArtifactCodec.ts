import { z } from 'zod'
import {
  createAtomicApplyCodecRegistry,
  decodeAtomicApplySkillRecovery,
} from '@/platform/atomic-apply/codecRegistry'
import type {
  AtomicApplyArtifactCodec,
  AtomicApplySkillRecovery,
  AtomicApplyWriteFormat,
} from '@/platform/contracts/atomicApply'
import {
  ResourcePackageArtifactSchema,
  ResourcePackageReceiptSchema,
  type ResourcePackageCurrentArtifact,
} from './resourcePackageCurrentCodec'
import { assertCommittedApplyReceipt } from '../domain/resourcePackageApplyReceipt'

export const RESOURCE_PACKAGE_ARTIFACT_VERSION = 2 as const
export type ResourcePackageRecoveryArtifact = ResourcePackageCurrentArtifact & {
  readonly recovery?: AtomicApplySkillRecovery
}
const current: AtomicApplyArtifactCodec<ResourcePackageRecoveryArtifact> = {
  decode(value) {
    return z
      .array(z.unknown())
      .parse(value)
      .map((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
          throw new Error('resource-package-artifact-invalid')
        const { recovery, ...fields } = entry as Record<string, unknown>
        const artifact = ResourcePackageArtifactSchema.parse(fields)
        if (recovery === undefined) return artifact
        const decoded = decodeAtomicApplySkillRecovery(recovery)
        if (
          (artifact.kind === 'skill-stage' && decoded.kind === 'create') ||
          (artifact.kind === 'skill-version-stage' && decoded.kind === 'version')
        )
          return Object.freeze({ ...artifact, recovery: decoded })
        throw new Error('resource-package-recovery-instructions-invalid')
      })
  },
  encode: (artifacts) => current.decode(artifacts),
}
export function createResourcePackageArtifactCodecs(
  writeFormat: AtomicApplyWriteFormat = 'versioned-envelope',
) {
  return createAtomicApplyCodecRegistry({
    writeFormat,
    scene: 'resource-package',
    currentVersion: RESOURCE_PACKAGE_ARTIFACT_VERSION,
    versions: new Map([[RESOURCE_PACKAGE_ARTIFACT_VERSION, current]]),
  })
}
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
  return artifact.recovery === undefined
}

/** Validate the complete row before any storage effect. */
export function decodeResourcePackageRecoveryRow(
  journal: {
    readonly id: string
    readonly preparedArtifactsJson: string
    readonly receiptJson: string | null
  },
  operation: 'rollForward' | 'compensate',
) {
  const artifacts = resourcePackageArtifactCodecs.decode(journal.preparedArtifactsJson)
  if (operation === 'rollForward') decodeResourcePackageReceipt(journal)
  return { format: 'current' as const, artifacts }
}
