// RFC-395 II-a A6 — 旧载荷的唯一读者；II-b 随转换器迁出运行路径。
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { Logger } from '@/util/log'
import type { LegacyIntentSkillArtifactCompat } from '../ports/skillArtifactCompensation'
import type { IntentApplyRecoveryArtifact } from './intentApplyEngine'
import { decodeCurrentIntentArtifact } from './intentApplyCurrentCodec'
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
} from '../domain/journalArtifacts'

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
    const current = decodeCurrentIntentArtifact(entry)
    if (current !== null) return current
    const [old] = decodeIntentJournalArtifacts(JSON.stringify([entry]))
    if (old === undefined) throw new Error('intent apply journal artifact is missing')
    return old
  })
}

/**
 * RFC-359 —— 合一之前由 SQLite 那台引擎写下的技能工件的前滚。
 *
 * 这段逻辑逐字来自被退役的 `sqliteIntentApplyArtifactLifecycle.ts`：先按 `skill_operations`
 * 的 `(active, phase)` 判断哪些暂存版本还能重放，整批 `unmarkSkillBootVerified` 之后逐条
 * `publishStagedSkillVersion`，最后把 `db-committed` 的 `skill-stage` 操作行收尾。
 * 判据：`rfc343-intent-apply-correctness` 的「committed skill-version convergence」。
 */
export async function rollForwardLegacySkillArtifacts(input: {
  readonly recovery: LegacyIntentSkillArtifactCompat
  readonly db: PersistenceDb
  readonly appHome: string
  readonly artifacts: readonly IntentJournalArtifact[]
  readonly log: Logger
}): Promise<boolean> {
  const { recovery, db, log } = input
  let complete = true

  const stagedVersions = input.artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
  )
  const stages = input.artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-stage' ? [{ skillId: artifact.skillId, opId: artifact.opId }] : [],
  )

  const pending: typeof stagedVersions = []
  for (const staged of stagedVersions) {
    if (staged.noop !== null) continue
    if (staged.opId === null) {
      pending.push(staged)
      continue
    }
    const operation = await recovery.loadSkillOperationState(db, staged.opId)
    if (
      operation?.active === 1 &&
      (operation.phase === 'db-committed' || operation.phase === 'fs-published')
    ) {
      pending.push(staged)
      continue
    }
    if (operation?.phase !== 'done') {
      complete = false
      log.warn('intent-skill-publish-op-not-replayable', {
        skillId: staged.skillId,
        opId: staged.opId,
        phase: operation?.phase ?? 'missing',
      })
    }
  }

  for (const staged of pending) recovery.unmarkSkillBootVerified(staged.skillId)
  for (const staged of pending) {
    try {
      await recovery.publishStagedSkillVersion(db, { appHome: input.appHome }, staged)
    } catch (error) {
      complete = false
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  for (const stage of stages) {
    const operation = await recovery.loadSkillOperationState(db, stage.opId)
    if (operation?.active === 0 && operation.phase === 'done') continue
    if (operation?.active !== 1 || operation.phase !== 'db-committed') {
      complete = false
      log.warn('intent-skill-finish-op-not-replayable', {
        skillId: stage.skillId,
        opId: stage.opId,
        phase: operation?.phase ?? 'missing',
      })
      continue
    }
    try {
      await databaseSessionFor(db).transaction(
        async (transaction) => await recovery.finishOperation(transaction, stage.opId),
      )
    } catch (error) {
      complete = false
      log.warn('intent-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return complete
}

export type {
  IntentJournalArtifact,
  IntentJournalArtifactV1,
  StagedSkillVersionRecord,
} from '../domain/journalArtifacts'
