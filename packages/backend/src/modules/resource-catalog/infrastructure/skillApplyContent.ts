// RFC-401 T5 —— skill 写入场景的内容存储选择：写入沿用调用方选定的存储（缺省为本地文件），恢复按工件记录的内容种类选取。
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import type { SkillContentKind } from '../application/ports/skillMutation'
import type { SkillCreationContentStore } from '../application/skills/creationContentStore'
import type { SkillDeletionContentStore } from '../application/skills/deletionContentStore'
import type { SkillTreeContentStore } from '../application/skills/treeContentStore'
import type { SkillVersionContentStore } from '../application/skills/versionContentStore'
import { createDatabaseSkillContent } from './databaseSkillContent'
import { createFileSkillCreationContentStore } from './local/fileSkillCreationContentStore'
import { createFileSkillDeletionContentStore } from './local/fileSkillDeletionContentStore'
import { createFileSkillTreeContentStore } from './local/fileSkillTreeContentStore'
import { createFileSkillVersionContentStore } from './local/fileSkillVersionContentStore'
import { createFileSkillVersionRecoveryContentStore } from './local/fileSkillVersionRecoveryContentStore'
import type { SkillApplyContent } from './skillAtomicApply'
import type { SkillApplyRecoveryContent } from './skillApplyRecovery'

export interface SkillApplyContentSelection {
  readonly appHome: string
  readonly contentKind?: SkillContentKind
  readonly versionContent?: SkillVersionContentStore
  readonly creationContent?: SkillCreationContentStore
  readonly deletionContent?: SkillDeletionContentStore
  readonly treeContent?: SkillTreeContentStore
}

/**
 * 调用方选定的存储；缺省为 `appHome` 下的本地文件。`legacyProducer` 只服务旧本地 API 的回调形态（测试用），中立调用方用声明式
 * 变更。
 */
export function skillApplyContentFor(
  db: PersistenceDb,
  selection: SkillApplyContentSelection,
  legacyProducer?: (directory: string) => void,
): SkillApplyContent {
  if (legacyProducer !== undefined && selection.versionContent !== undefined)
    throw new Error('legacy skill producer requires the local file content store')
  const versionContent =
    selection.versionContent ??
    createFileSkillVersionContentStore(selection.appHome, legacyProducer, db)
  const declared = (versionContent as { readonly contentKind?: SkillContentKind }).contentKind
  return Object.freeze({
    contentKind: selection.contentKind ?? declared ?? 'local-file',
    versionContent,
    creationContent:
      selection.creationContent ?? createFileSkillCreationContentStore(selection.appHome),
    deletionContent:
      selection.deletionContent ?? createFileSkillDeletionContentStore(selection.appHome, db),
    treeContent: selection.treeContent ?? createFileSkillTreeContentStore(selection.appHome, db),
  })
}

/** 恢复：本地文件在 `appHome` 下，数据库字节在 `skill_content_entries`。 */
export function skillApplyRecoveryContentFor(
  db: PersistenceDb,
  appHome: string,
): (kind: SkillContentKind) => SkillApplyRecoveryContent {
  let database: SkillApplyRecoveryContent | undefined
  let local: SkillApplyRecoveryContent | undefined
  return (kind) => {
    if (kind === 'database-bytes') {
      if (database === undefined) {
        const binding = createDatabaseSkillContent({ db })
        database = Object.freeze({
          contentKind: 'database-bytes' as const,
          versionContent: binding.versionContent,
          creationContent: binding.creationContent,
          deletionContent: binding.deletionContent,
          treeContent: binding.treeContent,
          versionRecovery: binding.versionRecovery,
        })
      }
      return database
    }
    if (local === undefined)
      local = Object.freeze({
        ...skillApplyContentFor(db, { appHome, contentKind: 'local-file' }),
        versionRecovery: createFileSkillVersionRecoveryContentStore(appHome),
      })
    return local
  }
}
