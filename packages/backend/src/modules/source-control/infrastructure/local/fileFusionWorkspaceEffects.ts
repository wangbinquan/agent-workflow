import { rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type {
  FusionWorkspaceEffects,
  FusionWorkspacePreparation,
} from '../../application/ports/fusionWorkspaceEffects'
import {
  collectFusionWorktree,
  seedFusionWorktree,
  type FusionWorkspaceGit,
} from './fusionWorkspaceTree'

const FUSION_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** The standalone layout: one Git working copy per fusion iteration under the app home. */
export function fusionWorkDirectory(appHome: string, fusionId: string, iteration: number): string {
  if (!FUSION_ID.test(fusionId) || !Number.isSafeInteger(iteration) || iteration < 1)
    throw new Error('fusion-workspace-identity-invalid')
  return join(appHome, 'fusions', fusionId, `iter${iteration}`, 'work')
}

/**
 * RFC-370 §10 V20 — standalone fusion workspaces, exactly as the fusion
 * orchestration kept them before: `fusions/<id>/iter<n>/work` stays after the
 * engine task settles (`finished` keeps it), and only a never-admitted task's
 * directory is removed (`abandon`).
 */
export function createFileFusionWorkspaceEffects(input: {
  readonly appHome: string
  /** Deterministic seed-git failure injection for ownership regression tests. */
  readonly git?: FusionWorkspaceGit
}): FusionWorkspaceEffects {
  const fusionsRoot = resolve(input.appHome, 'fusions') + sep
  return Object.freeze({
    async prepare(request: Parameters<FusionWorkspaceEffects['prepare']>[0]) {
      const workDir = fusionWorkDirectory(input.appHome, request.fusionId, request.iteration)
      rmSync(workDir, { recursive: true, force: true })
      try {
        const baseCommit = await seedFusionWorktree({
          workDir,
          base: request.base,
          overlay: request.overlay,
          appHome: input.appHome,
          ...(input.git === undefined ? {} : { git: input.git }),
        })
        return { worktreePath: workDir, baseCommit } satisfies FusionWorkspacePreparation
      } catch (error) {
        rmSync(workDir, { recursive: true, force: true })
        throw error
      }
    },
    async collect(request: Parameters<FusionWorkspaceEffects['collect']>[0]) {
      return await collectFusionWorktree(request.worktreePath, request.baseCommit)
    },
    async release(request: Parameters<FusionWorkspaceEffects['release']>[0]) {
      if (request.mode !== 'abandon' || !resolve(request.worktreePath).startsWith(fusionsRoot))
        return
      rmSync(request.worktreePath, { recursive: true, force: true })
    },
  } satisfies FusionWorkspaceEffects)
}
