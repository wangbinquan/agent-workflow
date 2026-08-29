import { z } from 'zod'
import type { StagedSkillVersion } from '@/services/skillVersion'

/**
 * Persisted Intent apply side effects.  The envelope is versioned because these
 * rows outlive the process which wrote them and boot/hourly convergence must be
 * able to distinguish a complete recovery oracle from an older, lossy shape.
 */
export const INTENT_JOURNAL_ARTIFACT_VERSION = 1 as const

export type IntentJournalArtifactV1 =
  | {
      kind: 'plugin-install'
      pluginId: string
      generationId: string
      generationDir: string
    }
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  | { kind: 'skill-version-stage'; staged: StagedSkillVersion }

export type IntentJournalArtifact =
  | IntentJournalArtifactV1
  | {
      /** Pre-RFC-271 rows recorded only pluginId. They remain readable, but
       * have no precise generation path to compensate. */
      kind: 'legacy-plugin-install-untracked'
      pluginId: string
    }

const NonEmptyString = z.string().min(1)

const StagedSkillVersionSchema = z
  .object({
    skillId: NonEmptyString,
    skillName: NonEmptyString,
    opId: NonEmptyString.nullable(),
    publishId: NonEmptyString,
    newVersion: z.number().int().positive(),
    newHash: z.string(),
    filesDir: NonEmptyString,
    versionDir: NonEmptyString,
    stagingDir: NonEmptyString,
    noop: z.union([z.null(), z.record(z.string(), z.unknown())]),
  })
  .strict()

const IntentJournalArtifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plugin-install'),
      pluginId: NonEmptyString,
      generationId: NonEmptyString,
      generationDir: NonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-stage'),
      skillId: NonEmptyString,
      opId: NonEmptyString,
      skillDir: NonEmptyString,
    })
    .strict(),
  z
    .object({
      kind: z.literal('skill-version-stage'),
      staged: StagedSkillVersionSchema,
    })
    .strict(),
])

const IntentJournalArtifactEnvelopeSchema = z
  .object({
    version: z.literal(INTENT_JOURNAL_ARTIFACT_VERSION),
    artifacts: z.array(IntentJournalArtifactSchema),
  })
  .strict()

const LegacyIntentJournalArtifactSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('plugin-install'),
      pluginId: NonEmptyString,
      generationId: NonEmptyString.optional(),
      generationDir: NonEmptyString.optional(),
    })
    .passthrough(),
  z
    .object({
      kind: z.literal('skill-stage'),
      skillId: NonEmptyString,
      opId: NonEmptyString,
      skillDir: NonEmptyString,
    })
    .passthrough(),
])

export class IntentJournalArtifactCodecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IntentJournalArtifactCodecError'
  }
}

export function encodeIntentJournalArtifacts(
  artifacts: readonly IntentJournalArtifactV1[],
): string {
  return JSON.stringify({
    version: INTENT_JOURNAL_ARTIFACT_VERSION,
    artifacts,
  })
}

/**
 * Legacy empty/plugin/skill-create arrays remain recoverable.  The old
 * skill-version shape is deliberately rejected: it only stored three fields,
 * which is not enough to publish a committed version or precisely abort its
 * operation.  Treating it as complete would turn data corruption into a false
 * terminal `failed` result.
 */
export function decodeIntentJournalArtifacts(json: string): IntentJournalArtifact[] {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (cause) {
    throw new IntentJournalArtifactCodecError('intent journal artifacts are not valid JSON', {
      cause,
    })
  }

  if (Array.isArray(value)) {
    const decoded: IntentJournalArtifact[] = []
    for (const raw of value) {
      if (
        typeof raw === 'object' &&
        raw !== null &&
        (raw as { kind?: unknown }).kind === 'skill-version-stage'
      ) {
        throw new IntentJournalArtifactCodecError(
          'legacy skill-version-stage artifact is incomplete and cannot be converged safely',
        )
      }
      const artifact = LegacyIntentJournalArtifactSchema.safeParse(raw)
      if (!artifact.success) {
        throw new IntentJournalArtifactCodecError(
          `legacy intent journal artifact is invalid: ${artifact.error.message}`,
          { cause: artifact.error },
        )
      }
      if (artifact.data.kind === 'plugin-install') {
        if (artifact.data.generationDir === undefined) {
          decoded.push({
            kind: 'legacy-plugin-install-untracked',
            pluginId: artifact.data.pluginId,
          })
        } else {
          decoded.push({
            kind: 'plugin-install',
            pluginId: artifact.data.pluginId,
            generationId: artifact.data.generationId ?? 'legacy',
            generationDir: artifact.data.generationDir,
          })
        }
      } else {
        decoded.push(artifact.data)
      }
    }
    return decoded
  }

  const envelope = IntentJournalArtifactEnvelopeSchema.safeParse(value)
  if (!envelope.success) {
    throw new IntentJournalArtifactCodecError(
      `intent journal artifact envelope is invalid: ${envelope.error.message}`,
      { cause: envelope.error },
    )
  }
  return envelope.data.artifacts as IntentJournalArtifact[]
}
