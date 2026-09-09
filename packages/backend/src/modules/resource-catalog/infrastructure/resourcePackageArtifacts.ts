import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import {
  BundlePluginPayloadSchema,
  BundleSkillPayloadSchema,
  isProtectedSkillMainFile,
} from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'

import { ValidationError } from '@/util/errors'
import { safeJoin } from '@/util/safePath'
import { assertRegularDirectory, SKILL_MAIN } from './packageSkillTree'
import {
  cleanupOpDirs,
  opCandidateDir,
  opStagedDir,
  restoreFromBackup,
  swapInStaged,
} from './legacy/skillFsPublish'
import { hashRegularFileTree } from './legacy/skillHash'
import {
  skillFilesAbs,
  skillFilesRel,
  skillVersionAbs,
  skillVersionRelPath,
} from './legacy/skillIdentityPaths'
import type {
  PostgresqlResourcePackageApplyReceipt,
  PostgresqlResourcePackageMutationRequestContext,
  PostgresqlResourcePackagePluginArtifact,
  PostgresqlResourcePackagePluginArtifactOwner,
  PostgresqlResourcePackageSkillArtifact,
  PostgresqlResourcePackageSkillArtifactOwner,
} from './aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { SkillPackageMutation } from '../public/types'

function pathInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function assertPathInside(root: string, target: string, code: string): void {
  if (pathInside(root, target)) return
  throw new ValidationError(code, 'resource package filesystem path escaped its managed root')
}

function copyRegularTree(source: string, target: string): void {
  assertRegularDirectory(source, 'resource-package-skill-tree-invalid')
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        'resource-package-skill-tree-invalid',
        `skill tree contains a symbolic link: ${sourcePath}`,
      )
    }
    if (stat.isDirectory()) {
      copyRegularTree(sourcePath, targetPath)
      continue
    }
    if (!stat.isFile()) {
      throw new ValidationError(
        'resource-package-skill-tree-invalid',
        `skill tree contains a non-regular entry: ${sourcePath}`,
      )
    }
    writeFileSync(targetPath, readFileSync(sourcePath), { mode: 0o600 })
  }
}

function skillMarkdown(payload: ReturnType<typeof BundleSkillPayloadSchema.parse>): string {
  return `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}

function writeSkillTree(
  root: string,
  mutation: SkillPackageMutation,
  readSkillFile: (ref: string) => Uint8Array,
): void {
  const payload = BundleSkillPayloadSchema.parse(mutation.payload)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, SKILL_MAIN), skillMarkdown(payload), { mode: 0o600 })
  for (const file of payload.files) {
    if (isProtectedSkillMainFile(file.path)) {
      throw new ValidationError(
        'package-invalid',
        'a resource package skill file cannot replace its generated SKILL.md',
      )
    }
    const absolute = safeJoin(root, file.path)
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
    writeFileSync(absolute, readSkillFile(file.ref), { mode: 0o600 })
  }
}

function candidateVersionDirectory(
  appHome: string,
  skillId: string,
  version: number,
  operationId: string,
): string {
  return opCandidateDir(skillVersionAbs(appHome, skillId, version), operationId)
}

interface SkillPlanState {
  readonly artifact: PostgresqlResourcePackageSkillArtifact
  readonly version: number
  readonly liveDirectory: string
  readonly versionDirectory: string
  readonly candidateDirectory: string
  publication?: Readonly<{
    managedPath: string
    filesPath: string
    contentHash: string
  }>
  finalized: boolean
}

function contextPlans<T>(
  plans: WeakMap<PostgresqlResourcePackageMutationRequestContext, Map<string, T>>,
  context: PostgresqlResourcePackageMutationRequestContext,
): Map<string, T> {
  const existing = plans.get(context)
  if (existing !== undefined) return existing
  const created = new Map<string, T>()
  plans.set(context, created)
  return created
}

function verifyReceiptArtifact(
  receipt: PostgresqlResourcePackageApplyReceipt,
  artifact: PostgresqlResourcePackageSkillArtifact | PostgresqlResourcePackagePluginArtifact,
): void {
  if (receipt.applied.some((entry) => entry.operationId === artifact.operationId)) return
  throw new Error(`resource-package-artifact-receipt-missing:${artifact.operationId}`)
}

function publishImmutableVersion(state: SkillPlanState): void {
  const publication = state.publication
  if (publication === undefined) throw new Error('resource-package-skill-publication-missing')
  if (existsSync(state.versionDirectory)) {
    if (hashRegularFileTree(state.versionDirectory) !== publication.contentHash) {
      throw new Error('resource-package-skill-version-collision')
    }
    rmSync(state.candidateDirectory, { recursive: true, force: true })
    return
  }
  if (!existsSync(state.candidateDirectory)) {
    throw new Error('resource-package-skill-version-candidate-missing')
  }
  mkdirSync(dirname(state.versionDirectory), { recursive: true, mode: 0o700 })
  renameSync(state.candidateDirectory, state.versionDirectory)
}

function finalizeSkillPlan(state: SkillPlanState): void {
  if (state.finalized) return
  const publication = state.publication
  if (publication === undefined) throw new Error('resource-package-skill-publication-missing')
  publishImmutableVersion(state)
  swapInStaged(state.liveDirectory, state.artifact.operationId)
  if (hashRegularFileTree(state.liveDirectory) !== publication.contentHash) {
    throw new Error('resource-package-skill-live-hash-mismatch')
  }
  cleanupOpDirs(state.liveDirectory, state.artifact.operationId)
  state.finalized = true
}

/**
 * Filesystem owner for PostgreSQL package skill mutations. It stages both the
 * live tree and an immutable version candidate before the database transaction,
 * then performs only idempotent rename/verification work after commit.
 */
export function createPostgresqlResourcePackageSkillArtifactOwner(input: {
  readonly appHome: string
}): PostgresqlResourcePackageSkillArtifactOwner {
  const plans = new WeakMap<
    PostgresqlResourcePackageMutationRequestContext,
    Map<string, SkillPlanState>
  >()

  const plan = (
    context: PostgresqlResourcePackageMutationRequestContext,
    mutation: SkillPackageMutation,
    skillId: string,
    version: number,
    artifact: PostgresqlResourcePackageSkillArtifact,
    copyCurrent: boolean,
  ) => {
    BundleSkillPayloadSchema.parse(mutation.payload)
    const liveDirectory = skillFilesAbs(input.appHome, skillId)
    const versionDirectory = skillVersionAbs(input.appHome, skillId, version)
    const candidateDirectory = candidateVersionDirectory(
      input.appHome,
      skillId,
      version,
      mutation.opId,
    )
    assertPathInside(input.appHome, liveDirectory, 'resource-package-skill-path-invalid')
    assertPathInside(input.appHome, versionDirectory, 'resource-package-skill-path-invalid')
    const state: SkillPlanState = {
      artifact,
      version,
      liveDirectory,
      versionDirectory,
      candidateDirectory,
      finalized: false,
    }
    const byOperation = contextPlans(plans, context)
    if (byOperation.has(mutation.opId)) {
      throw new Error(`resource-package-skill-operation-duplicate:${mutation.opId}`)
    }
    byOperation.set(mutation.opId, state)
    return Object.freeze({
      artifact,
      async stage() {
        if (state.publication !== undefined) {
          throw new Error('resource-package-skill-already-staged')
        }
        const readSkillFile = context.readSkillFile
        if (readSkillFile === undefined) {
          throw new Error('resource-package-skill-file-reader-missing')
        }
        const stagingDirectory = opStagedDir(liveDirectory, mutation.opId)
        rmSync(stagingDirectory, { recursive: true, force: true })
        rmSync(candidateDirectory, { recursive: true, force: true })
        try {
          if (copyCurrent) copyRegularTree(liveDirectory, stagingDirectory)
          else mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 })
          writeSkillTree(stagingDirectory, mutation, readSkillFile)
          copyRegularTree(stagingDirectory, candidateDirectory)
          const contentHash = hashRegularFileTree(candidateDirectory)
          state.publication = Object.freeze({
            managedPath: skillFilesRel(skillId),
            filesPath: skillVersionRelPath(skillId, version),
            contentHash,
          })
          return state.publication
        } catch (error) {
          rmSync(stagingDirectory, { recursive: true, force: true })
          rmSync(candidateDirectory, { recursive: true, force: true })
          throw error
        }
      },
    })
  }

  const owner: PostgresqlResourcePackageSkillArtifactOwner = {
    planCreate(context, request) {
      const liveDirectory = skillFilesAbs(input.appHome, request.skillId)
      return plan(
        context,
        request.mutation,
        request.skillId,
        1,
        Object.freeze({
          kind: 'skill-stage',
          operationId: request.mutation.opId,
          skillId: request.skillId,
          stagingDirectory: opStagedDir(liveDirectory, request.mutation.opId),
          targetDirectory: liveDirectory,
        }),
        false,
      )
    },
    planUpdate(context, request) {
      const liveDirectory = skillFilesAbs(input.appHome, request.skillId)
      return plan(
        context,
        request.mutation,
        request.skillId,
        request.version,
        Object.freeze({
          kind: 'skill-version-stage',
          operationId: request.mutation.opId,
          skillId: request.skillId,
          publishId: request.publishId,
          version: request.version,
          stagingDirectory: opStagedDir(liveDirectory, request.mutation.opId),
          versionDirectory: skillVersionAbs(input.appHome, request.skillId, request.version),
        }),
        true,
      )
    },
    async compensate(context, request) {
      const state = plans.get(context)?.get(request.artifact.operationId)
      if (state === undefined) {
        throw new Error(`resource-package-skill-plan-missing:${request.artifact.operationId}`)
      }
      if (request.databaseCommitted) {
        finalizeSkillPlan(state)
        return
      }
      restoreFromBackup(state.liveDirectory, request.artifact.operationId)
      cleanupOpDirs(state.liveDirectory, request.artifact.operationId)
      rmSync(state.candidateDirectory, { recursive: true, force: true })
      plans.get(context)?.delete(request.artifact.operationId)
    },
    async rollForward(context, request) {
      verifyReceiptArtifact(request.receipt, request.artifact)
      const state = plans.get(context)?.get(request.artifact.operationId)
      if (state === undefined) {
        throw new Error(`resource-package-skill-plan-missing:${request.artifact.operationId}`)
      }
      finalizeSkillPlan(state)
    },
    async afterCommitted(context) {
      const outstanding = [...(plans.get(context)?.values() ?? [])].filter(
        (state) => !state.finalized,
      )
      if (outstanding.length > 0) {
        throw new Error('resource-package-skill-roll-forward-incomplete')
      }
      plans.delete(context)
    },
  }
  return Object.freeze(owner)
}

export interface PostgresqlResourcePackagePluginInstallResult {
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly sourceKind: 'file' | 'npm' | 'git'
  readonly generationDirectory: string | null
}

export interface PostgresqlResourcePackagePluginInstaller {
  plannedGenerationDirectory(input: {
    readonly pluginId: string
    readonly spec: string
    readonly generationId: string
    readonly pluginsDir: string
  }): string | null
  install(input: {
    readonly pluginId: string
    readonly spec: string
    readonly generationId: string
    readonly pluginsDir: string
  }): Promise<PostgresqlResourcePackagePluginInstallResult>
}

interface PluginPlanState {
  readonly artifact: PostgresqlResourcePackagePluginArtifact
  readonly spec: string
  readonly managedGeneration: boolean
  publication?: PostgresqlResourcePackagePluginInstallResult
  finalized: boolean
}

/** Record-before-act plugin generation owner for the PostgreSQL package writer. */
export function createPostgresqlResourcePackagePluginArtifactOwner(input: {
  readonly pluginsDir: string
  readonly installer: PostgresqlResourcePackagePluginInstaller
}): PostgresqlResourcePackagePluginArtifactOwner {
  const plans = new WeakMap<
    PostgresqlResourcePackageMutationRequestContext,
    Map<string, PluginPlanState>
  >()
  const owner: PostgresqlResourcePackagePluginArtifactOwner = {
    planInstall(context, request) {
      const payload = BundlePluginPayloadSchema.parse(request.mutation.payload)
      const planned = input.installer.plannedGenerationDirectory({
        pluginId: request.pluginId,
        spec: payload.spec,
        generationId: request.generationId,
        pluginsDir: input.pluginsDir,
      })
      const artifactDirectory =
        planned ??
        join(input.pluginsDir, request.pluginId, 'external-references', request.generationId)
      assertPathInside(
        input.pluginsDir,
        artifactDirectory,
        'resource-package-plugin-generation-path-invalid',
      )
      const artifact = Object.freeze({
        kind: 'plugin-install' as const,
        operationId: request.mutation.opId,
        pluginId: request.pluginId,
        generationId: request.generationId,
        generationDirectory: artifactDirectory,
      })
      const state: PluginPlanState = {
        artifact,
        spec: payload.spec,
        managedGeneration: planned !== null,
        finalized: false,
      }
      const byOperation = contextPlans(plans, context)
      if (byOperation.has(request.mutation.opId)) {
        throw new Error(`resource-package-plugin-operation-duplicate:${request.mutation.opId}`)
      }
      byOperation.set(request.mutation.opId, state)
      return Object.freeze({
        artifact,
        async install() {
          if (state.publication !== undefined) {
            throw new Error('resource-package-plugin-already-installed')
          }
          const installed = await input.installer.install({
            pluginId: request.pluginId,
            spec: payload.spec,
            generationId: request.generationId,
            pluginsDir: input.pluginsDir,
          })
          if (
            state.managedGeneration &&
            installed.generationDirectory !== artifact.generationDirectory
          ) {
            if (installed.generationDirectory !== null) {
              assertPathInside(
                input.pluginsDir,
                installed.generationDirectory,
                'resource-package-plugin-generation-path-invalid',
              )
              rmSync(installed.generationDirectory, { recursive: true, force: true })
            }
            throw new Error('resource-package-plugin-generation-mismatch')
          }
          if (!state.managedGeneration && installed.generationDirectory !== null) {
            throw new Error('resource-package-plugin-external-generation-mismatch')
          }
          state.publication = installed
          return Object.freeze({
            sourceKind: installed.sourceKind,
            cachedPath: installed.cachedPath,
            resolvedVersion: installed.resolvedVersion,
          })
        },
      })
    },
    async compensate(context, request) {
      const state = plans.get(context)?.get(request.artifact.operationId)
      if (state === undefined) {
        throw new Error(`resource-package-plugin-plan-missing:${request.artifact.operationId}`)
      }
      if (request.databaseCommitted) {
        const publication = state.publication
        if (publication === undefined || !existsSync(publication.cachedPath)) {
          throw new Error('resource-package-plugin-publication-missing')
        }
        state.finalized = true
        return
      }
      if (state.managedGeneration) {
        rmSync(request.artifact.generationDirectory, { recursive: true, force: true })
      }
      plans.get(context)?.delete(request.artifact.operationId)
    },
    async rollForward(context, request) {
      verifyReceiptArtifact(request.receipt, request.artifact)
      const state = plans.get(context)?.get(request.artifact.operationId)
      const publication = state?.publication
      if (state === undefined || publication === undefined) {
        throw new Error(`resource-package-plugin-plan-missing:${request.artifact.operationId}`)
      }
      if (!existsSync(publication.cachedPath)) {
        throw new Error('resource-package-plugin-publication-missing')
      }
      state.finalized = true
    },
    async afterCommitted(context) {
      const outstanding = [...(plans.get(context)?.values() ?? [])].filter(
        (state) => !state.finalized,
      )
      if (outstanding.length > 0) {
        throw new Error('resource-package-plugin-roll-forward-incomplete')
      }
      plans.delete(context)
    },
  }
  return Object.freeze(owner)
}
