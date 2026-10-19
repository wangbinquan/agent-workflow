// RFC-370 §10 V20 — `fusion-workspace`: the one task-image command that seeds or
// collects a fusion engine task's working copy inside the task's own volume.
// It runs the standalone steps (`fusionWorkspaceTree`) against the volume.
// Seeds and proposals are whole skill trees: above a command's inline budget
// they travel as volume files the control plane writes and reads through the
// platform file API, never through argv or the outcome file.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import type {
  FusionWorkspaceFile,
  FusionWorkspaceManifest,
} from '../../application/ports/fusionWorkspaceEffects'
import { collectFusionWorktree, seedFusionWorktree } from '../local/fusionWorkspaceTree'

export const FUSION_WORKSPACE_OPERATION = 'fusion-workspace'
/** The engine task's working copy: one fusion workspace per task volume. */
export const FUSION_WORKSPACE_PATH = '/work/fusion'
/** Seeds and results above this size travel as volume files. */
export const FUSION_WORKSPACE_INLINE_BYTES = 256 * 1024
/** Volume directory of those payload files (control-plane volume path). */
export const FUSION_WORKSPACE_PAYLOAD_DIRECTORY = '/work/tmp/fusion-workspace'

export interface FusionWorkspaceWireFile {
  readonly path: string
  readonly base64: string
}

export interface FusionWorkspaceWireSeed {
  readonly base: readonly FusionWorkspaceWireFile[]
  readonly overlay: readonly FusionWorkspaceWireFile[] | null
}

export interface FusionWorkspaceWireResult {
  readonly diff: string
  readonly manifest: FusionWorkspaceManifest
  readonly files: readonly FusionWorkspaceWireFile[]
}

export type FusionWorkspaceVolumeRequest =
  | {
      readonly operation: 'prepare'
      readonly path: string
      readonly seed?: FusionWorkspaceWireSeed
      readonly seedFile?: string
    }
  | { readonly operation: 'collect'; readonly path: string; readonly baseCommit: string }
  | { readonly operation: 'release-file'; readonly file: string }

export type FusionWorkspaceVolumeOutcome<T> =
  | { readonly value: T; readonly resultFile?: undefined }
  | { readonly value?: undefined; readonly resultFile: string }

export function toWireFiles(files: readonly FusionWorkspaceFile[]): FusionWorkspaceWireFile[] {
  return files.map((file) => ({
    path: file.path,
    base64: Buffer.from(file.content).toString('base64'),
  }))
}

export function fromWireFiles(files: readonly FusionWorkspaceWireFile[]): FusionWorkspaceFile[] {
  return files.map((file) => ({
    path: file.path,
    content: new Uint8Array(Buffer.from(file.base64, 'base64')),
  }))
}

/** Runs only in the task image, against the volume mounted at `root`. */
export async function runFusionWorkspaceVolumeOperation(
  value: unknown,
  root: string,
): Promise<FusionWorkspaceVolumeOutcome<unknown> | null> {
  const request = value as FusionWorkspaceVolumeRequest
  const payloadDirectory = requireWorkPath(join(root, 'tmp', 'fusion-workspace'), root)
  const payloadFile = (path: unknown): string => {
    if (typeof path !== 'string') throw new Error('hosted-fusion-workspace-file-invalid')
    const full = requireWorkPath(path, root)
    if (dirname(full) !== payloadDirectory || !full.endsWith('.json'))
      throw new Error('hosted-fusion-workspace-file-invalid')
    return full
  }
  const workPath = (path: unknown): string => {
    if (typeof path !== 'string') throw new Error('hosted-fusion-workspace-path-invalid')
    const full = requireWorkPath(path, root)
    if (full === requireWorkPath(root, root))
      throw new Error('hosted-fusion-workspace-path-invalid')
    return full
  }
  switch (request.operation) {
    case 'release-file':
      rmSync(payloadFile(request.file), { force: true })
      return null
    case 'prepare': {
      const seed =
        request.seedFile === undefined
          ? request.seed
          : (JSON.parse(
              readFileSync(payloadFile(request.seedFile), 'utf8'),
            ) as FusionWorkspaceWireSeed)
      if (seed === undefined) throw new Error('hosted-fusion-workspace-seed-missing')
      const workDir = workPath(request.path)
      rmSync(workDir, { recursive: true, force: true })
      try {
        const baseCommit = await seedFusionWorktree({
          workDir,
          base: fromWireFiles(seed.base),
          overlay: seed.overlay === null ? null : fromWireFiles(seed.overlay),
          appHome: root,
        })
        return { value: { baseCommit } }
      } catch (error) {
        rmSync(workDir, { recursive: true, force: true })
        throw error
      }
    }
    case 'collect': {
      if (typeof request.baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/.test(request.baseCommit))
        throw new Error('hosted-fusion-workspace-baseline-invalid')
      const result = await collectFusionWorktree(workPath(request.path), request.baseCommit)
      const wire: FusionWorkspaceWireResult = {
        diff: result.diff,
        manifest: result.manifest,
        files: toWireFiles(result.files),
      }
      const json = JSON.stringify(wire)
      if (Buffer.byteLength(json) <= FUSION_WORKSPACE_INLINE_BYTES) return { value: wire }
      mkdirSync(payloadDirectory, { recursive: true })
      const file = join(payloadDirectory, `${randomUUID()}.json`)
      writeFileSync(file, json)
      return { resultFile: file }
    }
    default:
      throw new Error('hosted-fusion-workspace-operation-unknown')
  }
}
