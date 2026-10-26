import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import { contentRefColumns } from '@/platform/content/contentStore'
import { createDatabaseSkillContent } from '../databaseSkillContent'
import { trashTreeNames } from '../databaseSkillTrees'
import { fileSkillReferencePath } from './fileSkillReferences'
import {
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { SkillDeletionContentStore } from '../../application/skills/deletionContentStore'
import {
  legacySkillRootAbs,
  rebaseSkillOperationPath,
  skillRootAbs,
} from '../legacy/skillIdentityPaths'

/** Original whole-root reversible delete, with compatible persisted trash paths. */
export function createFileSkillDeletionContentStore(
  appHome: string,
  db?: PersistenceDb,
): SkillDeletionContentStore {
  if (db) return createReferencedDeletionStore(appHome, db)
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

/** A converted skill may have file trees and a database initial snapshot.
 * The delete receipt records every moved root so rollback restores exact paths. */
function createReferencedDeletionStore(
  appHome: string,
  db: PersistenceDb,
): SkillDeletionContentStore {
  const local = createFileSkillDeletionContentStore(appHome)
  const database = createDatabaseSkillContent({ db }).deletionContent
  const journal = (backup: string) => join(backup, 'source-roots.json')
  const rootsOf = (backup: string): string[] =>
    JSON.parse(readFileSync(journal(backup), 'utf8')) as string[]
  return {
    plan: local.plan,
    async stage(plan) {
      const { skills, skillVersions } = tablesOf(db)
      const rows = [
        ...(await db.select().from(skills).where(eq(skills.id, plan.skillId))).map((row) => ({
          row,
          live: true,
        })),
        ...(
          await db.select().from(skillVersions).where(eq(skillVersions.skillId, plan.skillId))
        ).map((row) => ({ row, live: false })),
      ]
      const roots = [
        ...new Set(
          rows.flatMap(({ row, live }) => {
            const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
            if (ref?.kind !== 'local-file') return []
            const path = fileSkillReferencePath(appHome, ref)
            return [live ? dirname(path) : dirname(dirname(dirname(path)))]
          }),
        ),
      ].sort()
      mkdirSync(plan.backupRef, { recursive: true })
      if (!existsSync(journal(plan.backupRef)))
        writeFileSync(journal(plan.backupRef), JSON.stringify(roots))
      for (const [index, root] of rootsOf(plan.backupRef).entries()) {
        const backup = join(plan.backupRef, String(index))
        if (pathEntryExists(root) && !pathEntryExists(backup)) renameSync(root, backup)
      }
      await database.stage(plan)
    },
    async rollback(plan, recovery) {
      if (!existsSync(journal(plan.backupRef))) return local.rollback(plan, recovery)
      for (const [index, root] of rootsOf(plan.backupRef).entries()) {
        const backup = join(plan.backupRef, String(index))
        if (pathEntryExists(backup)) {
          if (pathEntryExists(root))
            throw new Error(`delete rollback collision for skill ${plan.skillId}`)
          mkdirSync(dirname(root), { recursive: true })
          renameSync(backup, root)
        }
      }
      if ((await trashTreeNames(db, plan.skillId, plan.operationId)).length)
        await database.rollback(plan, recovery)
      rmSync(plan.backupRef, { recursive: true, force: true })
    },
    async discard(plan) {
      await database.discard(plan)
      rmSync(plan.backupRef, { recursive: true, force: true })
    },
  }
}
