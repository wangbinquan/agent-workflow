import { z } from 'zod'
import type {
  AtomicApplyArtifactCodec,
  AtomicApplyArtifactRegistry,
  AtomicApplySkillRecovery,
  AtomicApplyWriteFormat,
} from '@/platform/contracts/atomicApply'

const skillRecovery = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('create'),
    operationId: z.string().min(1),
    rootDirectory: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('version'),
    operationId: z.string().min(1).nullable(),
    publishId: z.string().min(1),
    skillName: z.string(),
    contentHash: z.string(),
    liveDirectory: z.string().min(1),
  }),
])

export function decodeAtomicApplySkillRecovery(value: unknown): AtomicApplySkillRecovery {
  return skillRecovery.parse(value)
}

/** Epoch 2 accepts explicit scene/version envelopes only. Source decoders live in migration. */
export function createAtomicApplyCodecRegistry<Artifact>(input: {
  readonly scene: string
  readonly writeFormat: AtomicApplyWriteFormat
  readonly currentVersion: number
  readonly invalidJson?: (cause: unknown) => Error
  readonly versions: ReadonlyMap<number, AtomicApplyArtifactCodec<Artifact>>
}): AtomicApplyArtifactRegistry<Artifact> {
  const codecs = new Map(input.versions)
  const current = codecs.get(input.currentVersion)
  if (current === undefined) throw new Error(`atomic-apply-current-codec-missing:${input.scene}`)
  if (input.writeFormat !== 'versioned-envelope')
    throw new Error(`atomic-apply-write-format-unsupported:${input.scene}`)
  return Object.freeze({
    encode: (artifacts: readonly Artifact[]) =>
      JSON.stringify({
        scene: input.scene,
        version: input.currentVersion,
        artifacts: current.encode(artifacts),
      }),
    decode(json: string) {
      let value: unknown
      try {
        value = JSON.parse(json)
      } catch (cause) {
        throw input.invalidJson?.(cause) ?? cause
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`atomic-apply-artifact-envelope-invalid:${input.scene}`)
      const envelope = value as { scene?: unknown; version?: unknown; artifacts?: unknown }
      if (envelope.scene !== input.scene || !Number.isInteger(envelope.version))
        throw new Error(`atomic-apply-artifact-envelope-invalid:${input.scene}`)
      const codec = codecs.get(envelope.version as number)
      if (codec === undefined)
        throw new Error(
          `atomic-apply-artifact-version-unsupported:${input.scene}:${String(envelope.version)}`,
        )
      return Object.freeze([...codec.decode(envelope.artifacts)])
    },
  })
}
