import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { safeJoin } from '@/util/safePath'
import type { ResourcePackageRecoveryEffectsFactory } from '../../application/package/recoveryContentEffects'
import { assertManagedPath } from '../resourcePackageMaintenancePaths'
import {
  cleanupOpDirs,
  opCandidateDir,
  opStagedDir,
  restoreFromBackup,
  swapInStaged,
} from '../legacy/skillFsPublish'
import { hashRegularFileTree } from '../legacy/skillHash'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
} from '../legacy/skillIdentityPaths'

/** Original native mechanisms, selected as a complete factory only at composition. */
export function createFileResourcePackageRecoveryEffectsFactory(
  appHome: string,
): ResourcePackageRecoveryEffectsFactory {
  return Object.freeze({
    root(skillId: string) {
      return skillRootAbs(appHome, skillId)
    },
    live(skillId: string) {
      return skillFilesAbs(appHome, skillId)
    },
    version(skillId: string, version: number) {
      return skillVersionAbs(appHome, skillId, version)
    },
    staged(liveReference: string, publicationId: string) {
      return opStagedDir(liveReference, publicationId)
    },
    candidate(versionReference: string, publicationId: string) {
      return opCandidateDir(versionReference, publicationId)
    },
    normalize(reference: string) {
      return resolve(reference)
    },
    parent(reference: string) {
      return dirname(reference)
    },
    storedReference(reference: string) {
      return safeJoin(appHome, reference)
    },
    assertManaged(rootReference: string, reference: string) {
      assertManagedPath(rootReference, reference)
    },
    acquire() {
      return Object.freeze({
        exists(reference: string) {
          return existsSync(reference)
        },
        createDirectory(reference: string, mode?: number) {
          mkdirSync(reference, { recursive: true, ...(mode === undefined ? {} : { mode }) })
        },
        removeDirectory(reference: string) {
          rmSync(reference, { recursive: true, force: true })
        },
        move(sourceReference: string, targetReference: string) {
          renameSync(sourceReference, targetReference)
        },
        cleanupOperation(liveReference: string, publicationId: string) {
          cleanupOpDirs(liveReference, publicationId)
        },
        swapStaged(liveReference: string, publicationId: string) {
          return swapInStaged(liveReference, publicationId)
        },
        restoreBackup(liveReference: string, publicationId: string) {
          return restoreFromBackup(liveReference, publicationId)
        },
        directoryChainState(rootReference: string, reference: string) {
          return realDirectoryChainState(rootReference, reference)
        },
        hashRegularTree(reference: string) {
          return hashRegularFileTree(reference)
        },
        close() {},
      })
    },
  })
}
