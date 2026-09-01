import { rmSync } from 'node:fs'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { compensateManagedSkillStage } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { unmarkSkillBootVerified } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { finishOperation } from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  abortStagedSkillVersion,
  publishStagedSkillVersion,
} from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { loadLegacyIntentSkillOperationState } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/legacyIntentApplyResourceParticipants'
import type { IntentJournalArtifact } from '@/services/intent/journalArtifacts'
import type { Logger } from '@/util/log'

/** Closed artifact lifecycle consumed by the SQLite apply engine and recovery. */
export interface SqliteIntentApplyArtifactLifecycle {
  compensate(artifact: IntentJournalArtifact): Promise<void>
  /** False means at least one committed tail remains retryable. */
  rollForward(artifacts: readonly IntentJournalArtifact[], log: Logger): Promise<boolean>
}

function compensate(db: DbClient, artifact: IntentJournalArtifact): void {
  switch (artifact.kind) {
    case 'legacy-plugin-install-untracked':
      // Historical rows did not record a generation path. Installer GC owns
      // any residue; recovery must not pretend the old envelope was precise.
      return
    case 'plugin-install':
      rmSync(artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage':
      compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage': {
      abortStagedSkillVersion(db, artifact.staged)
      if (artifact.staged.opId === null) return
      const operation = loadLegacyIntentSkillOperationState(db, artifact.staged.opId)
      if (operation === undefined || operation.active === 1) {
        throw new Error(
          `skill version compensation remains active for operation ${artifact.staged.opId}`,
        )
      }
    }
  }
}

function rollForward(
  db: DbClient,
  appHome: string,
  artifacts: readonly IntentJournalArtifact[],
  log: Logger,
): boolean {
  let complete = true
  const skillVersionStages = artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
  )
  const skillStages = artifacts.flatMap((artifact) =>
    artifact.kind === 'skill-stage' ? [{ skillId: artifact.skillId, opId: artifact.opId }] : [],
  )

  const pendingSkillVersions: typeof skillVersionStages = []
  for (const staged of skillVersionStages) {
    if (staged.noop !== null) continue
    if (staged.opId === null) {
      pendingSkillVersions.push(staged)
      continue
    }
    const operation = loadLegacyIntentSkillOperationState(db, staged.opId)
    if (
      operation?.active === 1 &&
      (operation.phase === 'db-committed' || operation.phase === 'fs-published')
    ) {
      pendingSkillVersions.push(staged)
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

  for (const staged of pendingSkillVersions) unmarkSkillBootVerified(staged.skillId)
  for (const staged of pendingSkillVersions) {
    try {
      publishStagedSkillVersion(db, { appHome }, staged)
    } catch (error) {
      complete = false
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const stage of skillStages) {
    const operation = loadLegacyIntentSkillOperationState(db, stage.opId)
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
      dbTxSync(db, (transaction) => finishOperation(transaction, stage.opId))
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

export function createSqliteIntentApplyArtifactLifecycle(input: {
  readonly db: DbClient
  readonly appHome: string
}): SqliteIntentApplyArtifactLifecycle {
  return Object.freeze({
    async compensate(artifact: IntentJournalArtifact) {
      compensate(input.db, artifact)
    },
    async rollForward(artifacts: readonly IntentJournalArtifact[], log: Logger) {
      return rollForward(input.db, input.appHome, artifacts, log)
    },
  })
}
