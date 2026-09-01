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
import { dirname, join } from 'node:path'
import type { IntentSkillPayload } from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'

import type {
  PostgresqlIntentPluginArtifactLifecycle,
  PostgresqlIntentPluginInstallResult,
  PostgresqlIntentSkillArtifactLifecycle,
  PostgresqlIntentSkillStageResult,
} from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlIntentApplyResourcePorts'
import {
  cleanupOpDirs,
  opCandidateDir,
  opStagedDir,
  swapInStaged,
} from '@/modules/resource-catalog/infrastructure/legacy/skillFsPublish'
import { hashRegularFileTree } from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import {
  skillFilesAbs,
  skillFilesRel,
  skillVersionAbs,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import { installPlugin, plannedGenerationDir } from '@/services/pluginInstaller'
import { safeJoin } from '@/util/safePath'

function copyRegularTree(source: string, target: string): void {
  const sourceStat = lstatSync(source)
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error('intent-skill-source-tree-invalid')
  }
  mkdirSync(target, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) throw new Error('intent-skill-source-tree-symlink')
    if (stat.isDirectory()) {
      copyRegularTree(sourcePath, targetPath)
      continue
    }
    if (!stat.isFile()) throw new Error('intent-skill-source-tree-entry-invalid')
    writeFileSync(targetPath, readFileSync(sourcePath), { mode: 0o600 })
  }
}

function skillMarkdown(payload: IntentSkillPayload): string {
  return `---\n${stringifyYaml(
    {
      name: payload.name,
      description: payload.description,
      ...(payload.frontmatterExtra ?? {}),
    },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
}

function writeSkillTree(root: string, payload: IntentSkillPayload): void {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'SKILL.md'), skillMarkdown(payload), { mode: 0o600 })
  for (const file of payload.files) {
    const target = safeJoin(root, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    writeFileSync(target, file.content, { mode: 0o600 })
  }
}

interface SkillStageState {
  readonly liveDirectory: string
  readonly versionDirectory: string
  readonly stagingDirectory: string
  readonly candidateDirectory: string
  readonly operationId: string
  staged: PostgresqlIntentSkillStageResult | null
  published: boolean
}

function publishSkillStage(state: SkillStageState): void {
  if (state.published) return
  const staged = state.staged
  if (staged === null) throw new Error('intent-skill-stage-missing')
  if (existsSync(state.versionDirectory)) {
    if (hashRegularFileTree(state.versionDirectory) !== staged.contentHash) {
      throw new Error('intent-skill-version-hash-collision')
    }
    rmSync(state.candidateDirectory, { recursive: true, force: true })
  } else {
    if (!existsSync(state.candidateDirectory)) {
      throw new Error('intent-skill-version-candidate-missing')
    }
    mkdirSync(dirname(state.versionDirectory), { recursive: true, mode: 0o700 })
    renameSync(state.candidateDirectory, state.versionDirectory)
  }
  swapInStaged(state.liveDirectory, state.operationId)
  if (hashRegularFileTree(state.liveDirectory) !== staged.contentHash) {
    throw new Error('intent-skill-live-hash-mismatch')
  }
  cleanupOpDirs(state.liveDirectory, state.operationId)
  state.published = true
}

function createSkillStage(input: {
  readonly appHome: string
  readonly skillId: string
  readonly operationId: string
  readonly version: number
  readonly payload: IntentSkillPayload
  readonly copyCurrent: boolean
}): Awaited<ReturnType<PostgresqlIntentSkillArtifactLifecycle['planCreate']>> {
  const liveDirectory = skillFilesAbs(input.appHome, input.skillId)
  const versionDirectory = skillVersionAbs(input.appHome, input.skillId, input.version)
  const stagingDirectory = opStagedDir(liveDirectory, input.operationId)
  const candidateDirectory = opCandidateDir(versionDirectory, input.operationId)
  const artifact =
    input.version === 1
      ? Object.freeze({
          kind: 'skill-stage' as const,
          skillId: input.skillId,
          operationId: input.operationId,
          stagingDirectory,
        })
      : Object.freeze({
          kind: 'skill-version-stage' as const,
          skillId: input.skillId,
          operationId: input.operationId,
          version: input.version,
          stagingDirectory,
          versionDirectory,
        })
  const state: SkillStageState = {
    liveDirectory,
    versionDirectory,
    stagingDirectory,
    candidateDirectory,
    operationId: input.operationId,
    staged: null,
    published: false,
  }
  return Object.freeze({
    artifact,
    async stage() {
      if (state.staged !== null) throw new Error('intent-skill-already-staged')
      rmSync(stagingDirectory, { recursive: true, force: true })
      rmSync(candidateDirectory, { recursive: true, force: true })
      try {
        if (input.copyCurrent) copyRegularTree(liveDirectory, stagingDirectory)
        else mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 })
        writeSkillTree(stagingDirectory, input.payload)
        copyRegularTree(stagingDirectory, candidateDirectory)
        const contentHash = hashRegularFileTree(candidateDirectory)
        const result: PostgresqlIntentSkillStageResult = Object.freeze({
          managedPath: skillFilesRel(input.skillId),
          filesPath: skillVersionRelPath(input.skillId, input.version),
          contentHash,
          async commitInTransaction() {
            if (
              !existsSync(candidateDirectory) ||
              hashRegularFileTree(candidateDirectory) !== contentHash
            ) {
              throw new Error('intent-skill-transaction-candidate-mismatch')
            }
          },
        })
        state.staged = result
        return result
      } catch (error) {
        cleanupOpDirs(liveDirectory, input.operationId)
        rmSync(candidateDirectory, { recursive: true, force: true })
        throw error
      }
    },
    async compensate() {
      cleanupOpDirs(liveDirectory, input.operationId)
      rmSync(candidateDirectory, { recursive: true, force: true })
    },
    async rollForward() {
      publishSkillStage(state)
    },
    async complete() {
      publishSkillStage(state)
    },
  })
}

/** Filesystem owner used by the PostgreSQL Intent resource session. */
export function createPostgresqlIntentSkillArtifactLifecycle(input: {
  readonly appHome: string
}): PostgresqlIntentSkillArtifactLifecycle {
  const lifecycle: PostgresqlIntentSkillArtifactLifecycle = {
    async planCreate(request) {
      return createSkillStage({
        appHome: input.appHome,
        skillId: request.skillId,
        operationId: request.operationId,
        version: 1,
        payload: request.payload,
        copyCurrent: false,
      })
    },
    async planUpdate(request) {
      return createSkillStage({
        appHome: input.appHome,
        skillId: request.current.id,
        operationId: request.operationId,
        version: request.current.contentVersion + 1,
        payload: request.payload,
        copyCurrent: true,
      })
    },
  }
  return Object.freeze(lifecycle)
}

/** Plugin-generation owner used by the PostgreSQL Intent resource session. */
export function createPostgresqlIntentPluginArtifactLifecycle(input: {
  readonly pluginsDir: string
}): PostgresqlIntentPluginArtifactLifecycle {
  const lifecycle: PostgresqlIntentPluginArtifactLifecycle = {
    async planInstall(request) {
      const generationId = request.operationId
      const managedDirectory = plannedGenerationDir(
        request.pluginId,
        request.spec,
        generationId,
        input.pluginsDir,
      )
      const generationDir =
        managedDirectory ??
        join(input.pluginsDir, request.pluginId, 'external-references', generationId)
      let installed: PostgresqlIntentPluginInstallResult | null = null
      return Object.freeze({
        artifact: Object.freeze({
          kind: 'plugin-install' as const,
          pluginId: request.pluginId,
          generationId,
          generationDir,
        }),
        async stage() {
          if (installed !== null) throw new Error('intent-plugin-already-staged')
          const result = await installPlugin(request.pluginId, request.spec, {
            generationId,
            pluginsDir: input.pluginsDir,
          })
          if (managedDirectory !== null && result.generationDir !== managedDirectory) {
            if (result.generationDir !== null) {
              rmSync(result.generationDir, { recursive: true, force: true })
            }
            throw new Error('intent-plugin-generation-mismatch')
          }
          installed = Object.freeze({
            sourceKind: result.sourceKind,
            cachedPath: result.cachedPath,
            resolvedVersion: result.resolvedVersion,
          })
          return installed
        },
        async compensate() {
          if (managedDirectory !== null) {
            rmSync(managedDirectory, { recursive: true, force: true })
          }
        },
        async rollForward() {
          if (installed === null || !existsSync(installed.cachedPath)) {
            throw new Error('intent-plugin-publication-missing')
          }
        },
        async complete() {
          if (installed === null || !existsSync(installed.cachedPath)) {
            throw new Error('intent-plugin-publication-missing')
          }
        },
      })
    },
  }
  return Object.freeze(lifecycle)
}
