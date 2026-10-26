import {
  createAtomicApplyCodecRegistry,
  decodeAtomicApplySkillRecovery,
} from '@/platform/atomic-apply/codecRegistry'
import type {
  AtomicApplyArtifactCodec,
  AtomicApplyWriteFormat,
} from '@/platform/contracts/atomicApply'
import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import { decodeCurrentIntentArtifact } from './intentApplyCurrentCodec'

export const INTENT_APPLY_ARTIFACT_VERSION = 3 as const
const current: AtomicApplyArtifactCodec<IntentApplyArtifact> = {
  decode(value) {
    if (!Array.isArray(value)) throw new Error('intent apply journal artifacts must be an array')
    return value.map((entry: unknown) => {
      const artifact = decodeCurrentIntentArtifact(entry)
      if (artifact === null) throw new Error('intent apply journal artifact is invalid')
      const fields = Object.keys(entry as object)
      const allowed =
        artifact.kind === 'plugin-install'
          ? ['kind', 'pluginId', 'generationId', 'generationDir']
          : artifact.kind === 'skill-stage'
            ? ['kind', 'skillId', 'operationId', 'stagingDirectory', 'recovery']
            : [
                'kind',
                'skillId',
                'operationId',
                'version',
                'stagingDirectory',
                'versionDirectory',
                'recovery',
              ]
      if (fields.some((field) => !allowed.includes(field)))
        throw new Error('intent-apply-artifact-fields-invalid')
      const recovery = (entry as { recovery?: unknown }).recovery
      if (recovery === undefined) return artifact
      const decoded = decodeAtomicApplySkillRecovery(recovery)
      if (
        (artifact.kind === 'skill-stage' && decoded.kind === 'create') ||
        (artifact.kind === 'skill-version-stage' && decoded.kind === 'version')
      )
        return Object.freeze({ ...artifact, recovery: decoded })
      throw new Error('intent-apply-recovery-instructions-invalid')
    })
  },
  encode: (artifacts) => current.decode(artifacts),
}

export function createIntentApplyArtifactCodecs(
  writeFormat: AtomicApplyWriteFormat = 'versioned-envelope',
) {
  return createAtomicApplyCodecRegistry({
    writeFormat,
    scene: 'intent',
    currentVersion: INTENT_APPLY_ARTIFACT_VERSION,
    invalidJson: (cause) =>
      new Error('intent apply journal artifacts are not valid JSON', { cause }),
    versions: new Map([[INTENT_APPLY_ARTIFACT_VERSION, current]]),
  })
}
export const intentApplyArtifactCodecs = createIntentApplyArtifactCodecs()
export const decodeIntentApplyRecoveryArtifacts = intentApplyArtifactCodecs.decode
