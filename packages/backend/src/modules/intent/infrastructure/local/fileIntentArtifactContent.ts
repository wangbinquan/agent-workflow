import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { safeJoin } from '@/util/safePath'
import type { IntentApplyArtifact } from '@/modules/resource-catalog/public/types'
import type { IntentJournalArtifact } from '../../domain/journalArtifacts'
import type { PostgresqlSkillArtifactCompensation } from '../../ports/skillArtifactCompensation'
import type {
  IntentArtifactContentPort,
  IntentSkillArtifactPublication,
} from '../../application/ports/intentArtifactContent'

// Original file publication and compensation effects, independent of DB policy.
function pathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertManagedPath(root: string, target: string): void {
  if (pathInside(root, target)) return
  throw new Error('intent-apply-maintenance-path-outside-managed-root')
}

function publishSkill(
  input: IntentSkillArtifactPublication & {
    readonly rc: PostgresqlSkillArtifactCompensation
    readonly appHome: string
  },
): void {
  const version = input.version
  const skill = { managedPath: input.managedPath }
  const snapshot = { filesPath: input.filesPath, contentHash: input.contentHash }
  const liveDirectory = safeJoin(input.appHome, skill.managedPath)
  const expectedLiveDirectory = input.rc.skillFilesAbs(input.appHome, input.artifact.skillId)
  const versionDirectory = safeJoin(input.appHome, snapshot.filesPath)
  const expectedVersionDirectory = input.rc.skillVersionAbs(
    input.appHome,
    input.artifact.skillId,
    version,
  )
  const expectedStagingDirectory = input.rc.opStagedDir(liveDirectory, input.artifact.operationId)
  if (
    resolve(liveDirectory) !== resolve(expectedLiveDirectory) ||
    resolve(versionDirectory) !== resolve(expectedVersionDirectory) ||
    resolve(input.artifact.stagingDirectory) !== resolve(expectedStagingDirectory) ||
    (input.artifact.kind === 'skill-version-stage' &&
      resolve(input.artifact.versionDirectory) !== resolve(versionDirectory))
  ) {
    throw new Error('intent-apply-skill-artifact-path-mismatch')
  }

  const candidateDirectory = input.rc.opCandidateDir(versionDirectory, input.artifact.operationId)
  assertManagedPath(input.appHome, candidateDirectory)
  if (input.disposition === 'superseded') {
    input.rc.cleanupOpDirs(liveDirectory, input.artifact.operationId)
    rmSync(candidateDirectory, { recursive: true, force: true })
    return
  }
  if (existsSync(versionDirectory)) {
    if (input.rc.hashRegularFileTree(versionDirectory) !== snapshot.contentHash) {
      throw new Error('intent-apply-skill-version-hash-mismatch')
    }
    rmSync(candidateDirectory, { recursive: true, force: true })
  } else {
    if (!existsSync(candidateDirectory)) {
      throw new Error('intent-apply-skill-version-candidate-missing')
    }
    mkdirSync(dirname(versionDirectory), { recursive: true, mode: 0o700 })
    renameSync(candidateDirectory, versionDirectory)
  }

  if (existsSync(input.artifact.stagingDirectory)) {
    input.rc.swapInStaged(liveDirectory, input.artifact.operationId)
  }
  if (
    !existsSync(liveDirectory) ||
    input.rc.hashRegularFileTree(liveDirectory) !== snapshot.contentHash
  ) {
    throw new Error('intent-apply-skill-live-hash-mismatch')
  }
  input.rc.cleanupOpDirs(liveDirectory, input.artifact.operationId)
  input.rc.markSkillBootVerified(input.artifact.skillId)
}

function compensatePostgresqlSkill(input: {
  readonly rc: PostgresqlSkillArtifactCompensation
  readonly appHome: string
  readonly artifact: Extract<IntentApplyArtifact, { kind: 'skill-stage' | 'skill-version-stage' }>
  readonly version: number
}): void {
  const version = input.version
  const liveDirectory = input.rc.skillFilesAbs(input.appHome, input.artifact.skillId)
  const versionDirectory = input.rc.skillVersionAbs(input.appHome, input.artifact.skillId, version)
  if (
    resolve(input.artifact.stagingDirectory) !==
      resolve(input.rc.opStagedDir(liveDirectory, input.artifact.operationId)) ||
    (input.artifact.kind === 'skill-version-stage' &&
      resolve(input.artifact.versionDirectory) !== resolve(versionDirectory))
  ) {
    throw new Error('intent-apply-skill-artifact-path-mismatch')
  }
  input.rc.cleanupOpDirs(liveDirectory, input.artifact.operationId)
  rmSync(input.rc.opCandidateDir(versionDirectory, input.artifact.operationId), {
    recursive: true,
    force: true,
  })
}

function compensateLegacyArtifact(input: {
  readonly rc: PostgresqlSkillArtifactCompensation
  readonly appHome: string
  readonly pluginsDir: string
  readonly artifact: IntentJournalArtifact
}): void {
  switch (input.artifact.kind) {
    case 'legacy-plugin-install-untracked':
      return
    case 'plugin-install':
      assertManagedPath(input.pluginsDir, input.artifact.generationDir)
      rmSync(input.artifact.generationDir, { recursive: true, force: true })
      return
    case 'skill-stage':
      assertManagedPath(input.appHome, input.artifact.skillDir)
      rmSync(input.artifact.skillDir, { recursive: true, force: true })
      return
    case 'skill-version-stage': {
      const staged = input.artifact.staged
      assertManagedPath(input.appHome, staged.filesDir)
      assertManagedPath(input.appHome, staged.versionDir)
      input.rc.cleanupOpDirs(staged.filesDir, staged.publishId)
      rmSync(staged.versionDir, { recursive: true, force: true })
    }
  }
}

export function createFileIntentArtifactContent(input: {
  readonly appHome: string
  readonly pluginsDir: string
  readonly skillArtifacts: PostgresqlSkillArtifactCompensation
}): IntentArtifactContentPort {
  return Object.freeze({
    pluginExists: (reference: string) => existsSync(reference),
    discardPlugin(reference: string) {
      assertManagedPath(input.pluginsDir, reference)
      rmSync(reference, { recursive: true, force: true })
    },
    publishSkill(publication: IntentSkillArtifactPublication) {
      publishSkill({ ...publication, rc: input.skillArtifacts, appHome: input.appHome })
    },
    discardSkill(request: Parameters<IntentArtifactContentPort['discardSkill']>[0]) {
      compensatePostgresqlSkill({ ...request, rc: input.skillArtifacts, appHome: input.appHome })
    },
    discardLegacy(artifact: IntentJournalArtifact) {
      compensateLegacyArtifact({
        rc: input.skillArtifacts,
        appHome: input.appHome,
        pluginsDir: input.pluginsDir,
        artifact,
      })
    },
  })
}
