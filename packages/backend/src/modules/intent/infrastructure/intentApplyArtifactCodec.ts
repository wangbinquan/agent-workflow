import { createAtomicApplyCodecRegistry } from '@/platform/atomic-apply/codecRegistry'
import type {
  AtomicApplyArtifactCodec,
  AtomicApplyWriteFormat,
} from '@/platform/contracts/atomicApply'
import type { IntentApplyRecoveryArtifact } from './intentApplyEngine'
import { decodeCurrentIntentArtifact } from './intentApplyCurrentCodec'
import { decodeLegacyIntentApplyArtifacts } from './intentApplyLegacyCodec'

const current: AtomicApplyArtifactCodec<IntentApplyRecoveryArtifact> = {
  decode(value) {
    if (!Array.isArray(value)) throw new Error('intent apply journal artifacts must be an array')
    return value.map((entry) => {
      const artifact = decodeCurrentIntentArtifact(entry)
      if (artifact === null) throw new Error('intent apply journal artifact is invalid')
      return artifact
    })
  },
  encode: (artifacts) => artifacts,
}

export function createIntentApplyArtifactCodecs(
  writeFormat: AtomicApplyWriteFormat = 'head-array',
) {
  return createAtomicApplyCodecRegistry({
    writeFormat,
    scene: 'intent',
    currentVersion: 2,
    invalidJson: (cause) =>
      new Error('intent apply journal artifacts are not valid JSON', { cause }),
    versions: new Map<number | 'legacy', AtomicApplyArtifactCodec<IntentApplyRecoveryArtifact>>([
      [2, current],
      [
        'legacy',
        {
          decode: decodeLegacyIntentApplyArtifacts,
          encode() {
            throw new Error('intent-legacy-codec-read-only')
          },
        },
      ],
    ]),
  })
}

// RFC-395 II-a A6：II-b 激活时才切为 versioned-envelope；当前逐字保留旧数组写法。
export const intentApplyArtifactCodecs = createIntentApplyArtifactCodecs()

export const decodeIntentApplyRecoveryArtifacts = intentApplyArtifactCodecs.decode
