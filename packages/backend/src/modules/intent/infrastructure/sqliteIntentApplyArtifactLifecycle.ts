import { rmSync } from 'node:fs'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import type { IntentJournalArtifact } from '@/services/intent/journalArtifacts'
import type { SqliteSkillArtifactCompensation } from '../ports/skillArtifactCompensation'
import type { Logger } from '@/util/log'

/** Closed artifact lifecycle consumed by the SQLite apply engine and recovery. */
export interface SqliteIntentApplyArtifactLifecycle {
  compensate(artifact: IntentJournalArtifact): Promise<void>
  /** False means at least one committed tail remains retryable. */
  rollForward(artifacts: readonly IntentJournalArtifact[], log: Logger): Promise<boolean>
}

function compensate(
  rc: SqliteSkillArtifactCompensation,
  db: DbClient,
  artifact: IntentJournalArtifact,
): void {
  switch (artifact.kind) {
    case 'legacy-plugin-install-untracked':
      // Historical rows did not record a generation path. Installer GC owns
      // any residue; recovery must not pretend the old envelope was precise.
      return
    case 'plugin-install':
      rmSync(artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage':
      rc.compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage': {
      rc.abortStagedSkillVersion(db, artifact.staged)
      if (artifact.staged.opId === null) return
      const operation = rc.loadSkillOperationState(db, artifact.staged.opId)
      if (operation === undefined || operation.active === 1) {
        throw new Error(
          `skill version compensation remains active for operation ${artifact.staged.opId}`,
        )
      }
    }
  }
}

function rollForward(
  rc: SqliteSkillArtifactCompensation,
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
    const operation = rc.loadSkillOperationState(db, staged.opId)
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

  for (const staged of pendingSkillVersions) rc.unmarkSkillBootVerified(staged.skillId)
  for (const staged of pendingSkillVersions) {
    try {
      rc.publishStagedSkillVersion(db, { appHome }, staged)
    } catch (error) {
      complete = false
      log.warn('intent-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const stage of skillStages) {
    const operation = rc.loadSkillOperationState(db, stage.opId)
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
      dbTxSync(db, (transaction) => rc.finishOperation(transaction, stage.opId))
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
  /** RFC-355 T6：技能工件的补偿原语由 resource-catalog 提供、bootstrap 注入。 */
  readonly skillArtifacts: SqliteSkillArtifactCompensation
}): SqliteIntentApplyArtifactLifecycle {
  return Object.freeze({
    async compensate(artifact: IntentJournalArtifact) {
      compensate(input.skillArtifacts, input.db, artifact)
    },
    async rollForward(artifacts: readonly IntentJournalArtifact[], log: Logger) {
      return rollForward(input.skillArtifacts, input.db, input.appHome, artifacts, log)
    },
  })
}
