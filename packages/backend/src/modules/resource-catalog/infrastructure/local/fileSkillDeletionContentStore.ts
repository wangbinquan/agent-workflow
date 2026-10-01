import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { SkillDeletionContentStore } from '../../application/skills/deletionContentStore'
import {
  legacySkillRootAbs,
  rebaseSkillOperationPath,
  skillRootAbs,
} from '../legacy/skillIdentityPaths'

/** Original whole-root reversible delete, with compatible persisted trash paths. */
export function createFileSkillDeletionContentStore(appHome: string): SkillDeletionContentStore {
  return Object.freeze({
    plan(input) {
      const rootRef =
        input.legacyName === undefined
          ? skillRootAbs(appHome, input.skillId)
          : legacySkillRootAbs(appHome, input.legacyName)
      const backupRef = trashPath(appHome, input.skillId, input.operationId)
      if (
        input.recordedBackupRef != null &&
        rebaseSkillOperationPath(appHome, input.recordedBackupRef, '.trash') !== backupRef
      ) {
        throw new Error(
          `delete operation ${input.operationId} backup path does not match its op identity`,
        )
      }
      return { ...input, rootRef, backupRef, backupJournalRef: relative(appHome, backupRef) }
    },
    stage(plan) {
      if (pathEntryExists(plan.rootRef)) {
        mkdirSync(dirname(plan.backupRef), { recursive: true })
        renameSync(plan.rootRef, plan.backupRef)
      }
    },
    rollback(plan, recovery) {
      const label = recovery ? 'delete recovery' : 'delete rollback'
      const rootExists = pathEntryExists(plan.rootRef)
      const backupExists = pathEntryExists(plan.backupRef)
      if (rootExists && backupExists)
        throw new Error(`${label} collision for skill ${plan.skillId}`)
      if (!rootExists && !backupExists)
        throw new Error(`${label} lost both root and trash for skill ${plan.skillId}`)
      if (backupExists) renameSync(plan.backupRef, plan.rootRef)
    },
    discard(plan) {
      rmSync(plan.backupRef, { recursive: true, force: true })
    },
  } satisfies SkillDeletionContentStore)
}

function trashPath(appHome: string, skillId: string, opId: string): string {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(opId)) {
    throw new Error(`delete operation has invalid op_id: ${opId}`)
  }
  return join(appHome, 'skills', '.trash', `${skillId}-${opId}`)
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}
