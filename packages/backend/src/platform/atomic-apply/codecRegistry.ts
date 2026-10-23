import type {
  AtomicApplyArtifactCodec,
  AtomicApplyArtifactRegistry,
  AtomicApplyWriteFormat,
} from '@/platform/contracts/atomicApply'

/** 旧信封与无版本数组只交给场景的 legacy codec；显式未知版本不能回落。 */
export function createAtomicApplyCodecRegistry<Artifact>(input: {
  readonly scene: string
  readonly writeFormat: AtomicApplyWriteFormat
  readonly currentVersion: number
  readonly invalidJson?: (cause: unknown) => Error
  readonly versions: ReadonlyMap<number | 'legacy', AtomicApplyArtifactCodec<Artifact>>
}): AtomicApplyArtifactRegistry<Artifact> {
  const codecs = new Map(input.versions)
  function parse(json: string): unknown {
    try {
      return JSON.parse(json)
    } catch (cause) {
      throw input.invalidJson?.(cause) ?? cause
    }
  }
  function select(value: unknown) {
    if (value !== null && typeof value === 'object' && 'scene' in value) {
      const envelope = value as { scene: unknown; version?: unknown; artifacts?: unknown }
      if (envelope.scene !== input.scene || typeof envelope.version !== 'number') {
        throw new Error(`atomic-apply-artifact-envelope-invalid:${input.scene}`)
      }
      const codec = codecs.get(envelope.version)
      if (codec === undefined) {
        throw new Error(
          `atomic-apply-artifact-version-unsupported:${input.scene}:${envelope.version}`,
        )
      }
      return { codec, version: envelope.version, value: envelope.artifacts }
    }
    const codec = codecs.get('legacy')
    if (codec === undefined) throw new Error(`atomic-apply-legacy-codec-missing:${input.scene}`)
    return { codec, version: 'legacy' as const, value }
  }
  const current = codecs.get(input.currentVersion)
  if (current === undefined) throw new Error(`atomic-apply-current-codec-missing:${input.scene}`)
  return Object.freeze({
    encode: (artifacts: readonly Artifact[]) =>
      input.writeFormat === 'head-array'
        ? JSON.stringify(artifacts)
        : JSON.stringify({
            scene: input.scene,
            version: input.currentVersion,
            artifacts: current.encode(artifacts),
          }),
    decode(json: string) {
      const selected = select(parse(json))
      return selected.codec.decode(selected.value)
    },
  })
}
