import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillContentBinding } from '../../composition/skillContentBinding'
import { createFileSkillContentReader } from './fileSkillContentReader'
import { createFileSkillVersionContentReader } from './fileSkillVersionContentReader'
import { createFileSkillVersionPresenceQueries } from './fileSkillVersionPresenceQueries'
import { createFileSkillSnapshotInspector } from './fileSkillSnapshotInspector'
import { createFileSkillLifecycleContentStore } from './fileSkillLifecycleContentStore'
import { createFileSkillVersionContentStore } from './fileSkillVersionContentStore'
import { createFileSkillCreationContentStore } from './fileSkillCreationContentStore'
import { createFileSkillDeletionContentStore } from './fileSkillDeletionContentStore'
import { createFileSkillVersionRecoveryContentStore } from './fileSkillVersionRecoveryContentStore'
import { createFileSkillIdentityContentStore } from './fileSkillIdentityContentStore'
import { createFileSkillIdentityInspector } from './fileSkillIdentityInspector'
import { createFileSkillTreeContentStore } from './fileSkillTreeContentStore'
import { createFileSkillPackageContentReader } from './fileSkillPackageContentReader'

/** A selects this complete local profile binding, including converted references. */
export function createFileSkillContentBinding(db: PersistenceDb, appHome: string) {
  return Object.freeze({
    rootReference: appHome,
    content: createFileSkillContentReader(appHome, db),
    versionReader: createFileSkillVersionContentReader(appHome, db),
    versionPresence: createFileSkillVersionPresenceQueries(appHome, db),
    snapshotInspector: createFileSkillSnapshotInspector(appHome, db),
    lifecycleContent: createFileSkillLifecycleContentStore(appHome, db),
    versionContent: createFileSkillVersionContentStore(appHome, undefined, db),
    creationContent: createFileSkillCreationContentStore(appHome),
    deletionContent: createFileSkillDeletionContentStore(appHome, db),
    versionRecovery: createFileSkillVersionRecoveryContentStore(appHome),
    identityContent: createFileSkillIdentityContentStore(appHome),
    identityInspector: createFileSkillIdentityInspector(appHome),
    treeContent: createFileSkillTreeContentStore(appHome, db),
    ...{ packageContent: createFileSkillPackageContentReader(appHome, db) },
  } satisfies SkillContentBinding)
}
