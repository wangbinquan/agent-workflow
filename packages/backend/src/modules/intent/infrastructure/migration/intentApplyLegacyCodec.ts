// RFC-395 II-a A6 — 旧载荷的唯一读者；II-b 随转换器迁出运行路径。
import type { IntentApplyRecoveryArtifact } from '../intentApplyEngine'
import { decodeCurrentIntentArtifact } from '../intentApplyCurrentCodec'
import { z } from 'zod'

/**
 * Persisted Intent apply side effects.  The envelope is versioned because these
 * rows outlive the process which wrote them and boot/hourly convergence must be
 * able to distinguish a complete recovery oracle from an older, lossy shape.
 */
export const INTENT_JOURNAL_ARTIFACT_VERSION = 1 as const

import {
  StagedSkillVersionSchema,
  type IntentJournalArtifact,
  type IntentJournalArtifactV1,
} from '../../domain/journalArtifacts'

const NonEmptyString = z.string().min(1)

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

export function decodeLegacyIntentApplyArtifacts(
  value: unknown,
): readonly IntentApplyRecoveryArtifact[] {
  if (!Array.isArray(value)) return decodeIntentJournalArtifacts(JSON.stringify(value))
  return value.map((entry) => {
    const legacyPlugin =
      entry !== null &&
      typeof entry === 'object' &&
      (entry as { kind?: unknown }).kind === 'plugin-install' &&
      (!('generationId' in entry) || !('generationDir' in entry))
    const current = legacyPlugin ? null : decodeCurrentIntentArtifact(entry)
    if (current !== null) return current
    const [old] = decodeIntentJournalArtifacts(JSON.stringify([entry]))
    if (old === undefined) throw new Error('intent apply journal artifact is missing')
    return old
  })
}

export type {
  IntentJournalArtifact,
  IntentJournalArtifactV1,
  StagedSkillVersionRecord,
} from '../../domain/journalArtifacts'
