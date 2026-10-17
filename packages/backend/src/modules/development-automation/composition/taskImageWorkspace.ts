import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { createFileActionWorkspaceEffects } from '../infrastructure/local/fileActionWorkspaceEffects'
import { createFileRepositoryBaselineEffectsFactory } from '../infrastructure/local/fileRepositoryBaselineEffects'
import { actionTreeDigest, prepareActionScene } from '../application/actionWorkspace'
import {
  serializeProtectedRootSnapshot,
  snapshotProtectedRoots,
} from '../infrastructure/protectedSnapshot'
import {
  businessTreeSnapshot,
  reviveWorkspaceValidationInput,
  validateWorkspaceOutcome,
  type SerializedWorkspaceValidationInput,
} from '../infrastructure/workspaceValidator'

/** RFC-370 §9.2 V3 — one whole-tree operation per command. */
export const DEVELOPMENT_TREE_OPERATION = 'development-tree'
/** Inputs and results above this size travel as volume files. */
export const DEVELOPMENT_TREE_INLINE_BYTES = 256 * 1024
/** Volume directory of those payload files (control-plane volume path). */
export const DEVELOPMENT_TREE_SCRATCH = '/work/tmp/development-tree'

export type DevelopmentTreeOutcome =
  | { readonly value: unknown; readonly resultFile?: undefined }
  | { readonly value?: undefined; readonly resultFile: string }

export const TASK_IMAGE_DEVELOPMENT_OPERATIONS = [
  'development-workspace',
  DEVELOPMENT_TREE_OPERATION,
] as const

/** Native effects run only inside the task image, under their original domain owner. */
export async function executeTaskImageDevelopmentOperation(
  operation: string,
  value: unknown,
  root: string,
): Promise<unknown> {
  const workPath = (path: unknown) => {
    if (typeof path !== 'string') throw new Error('hosted-development-path-invalid')
    return requireWorkPath(path, root)
  }
  const actionRoot = workPath(join(root, 'tmp', 'actions'))
  if (operation === DEVELOPMENT_TREE_OPERATION) return executeDevelopmentTree(value, root, workPath)
  if (operation !== 'development-workspace') throw new Error('hosted-development-operation-unknown')
  const action = createFileActionWorkspaceEffects()
  const input = value as { path: string; method: string; args: unknown[] }
  const path = workPath(input.path)
  const scope = await action.contents.acquire()
  try {
    switch (input.method) {
      case 'exists':
        return scope.exists(path)
      case 'inspect':
        return scope.inspect(path, input.args[0] as boolean)
      case 'listNames':
        return scope.listNames(path)
      case 'listEntries':
        return scope.listEntries(path)
      case 'readLink':
        return scope.readLink(path)
      case 'createDirectory':
        return scope.createDirectory(path, input.args[0] as boolean)
      case 'copyFile':
        return scope.copyFile(path, workPath(input.args[0]), input.args[1] as boolean)
      case 'setMode':
        return scope.setMode(path, input.args[0] as number)
      case 'writeText':
        return scope.writeText(path, input.args[0] as string)
      case 'discard': {
        const parts = relative(actionRoot, path).split(sep)
        if (parts.length !== 2 || parts[0] === '..' || !parts[0] || parts[1] !== 'ws')
          throw new Error('hosted-action-cleanup-owner-mismatch')
        return action.discard(path)
      }
      case 'baseline-head':
      case 'baseline-stat': {
        const baseline = await createFileRepositoryBaselineEffectsFactory().acquire()
        try {
          if (input.method === 'baseline-head') return await baseline.readHead(path)
          return await (
            await baseline.bindFileReader(path, input.args[0] as string)
          ).stat(input.args[1] as string)
        } finally {
          await baseline.close()
        }
      }
      default:
        throw new Error('hosted-development-operation-unknown')
    }
  } finally {
    await scope.close()
  }
}

async function executeDevelopmentTree(
  value: unknown,
  root: string,
  workPath: (path: unknown) => string,
): Promise<DevelopmentTreeOutcome | null> {
  const request = value as {
    readonly operation: string
    readonly input?: unknown
    readonly inputFile?: string
    readonly file?: string
  }
  const scratch = workPath(join(root, 'tmp', 'development-tree'))
  const payloadFile = (path: unknown) => {
    const full = workPath(path)
    if (dirname(full) !== scratch || !full.endsWith('.json'))
      throw new Error('hosted-development-tree-file-invalid')
    return full
  }
  if (request.operation === 'release') {
    rmSync(payloadFile(request.file), { force: true })
    return null
  }
  const payload =
    request.inputFile === undefined
      ? request.input
      : (JSON.parse(readFileSync(payloadFile(request.inputFile), 'utf8')) as unknown)
  const result = (await runTreeOperation(request.operation, payload, root, workPath)) ?? null
  const json = JSON.stringify(result)
  if (Buffer.byteLength(json) <= DEVELOPMENT_TREE_INLINE_BYTES) return { value: result }
  // Results are control data in the outcome file; a whole tree goes through
  // a volume file the control plane reads with the platform file API.
  mkdirSync(scratch, { recursive: true })
  const file = join(scratch, `${randomUUID()}.json`)
  writeFileSync(file, json)
  return { resultFile: file }
}

async function runTreeOperation(
  operation: string,
  payload: unknown,
  root: string,
  workPath: (path: unknown) => string,
): Promise<unknown> {
  const roots = (value: unknown) =>
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([label, path]) => [
        label,
        workPath(path),
      ]),
    )
  switch (operation) {
    case 'business-tree-snapshot':
      return [...(await businessTreeSnapshot(workPath((payload as { root: unknown }).root)))]
    case 'protected-root-snapshot': {
      const request = payload as {
        roots: unknown
        opts?: Parameters<typeof snapshotProtectedRoots>[1]
      }
      return serializeProtectedRootSnapshot(
        await snapshotProtectedRoots(roots(request.roots), request.opts ?? {}),
      )
    }
    case 'validate-workspace-outcome': {
      const request = payload as SerializedWorkspaceValidationInput
      return validateWorkspaceOutcome(
        reviveWorkspaceValidationInput({
          ...request,
          workspacePath: workPath(request.workspacePath),
          protectedRoots: roots(request.protectedRoots),
        }),
      )
    }
    case 'action-scene-prepare': {
      const request = payload as {
        baselineRepoPath: unknown
        baselineSha: unknown
        seedRoot: unknown
      }
      if (typeof request.baselineSha !== 'string')
        throw new Error('hosted-development-tree-input-invalid')
      return {
        workspacePath: await prepareActionScene(
          {
            storageRoot: workPath(join(root, 'tmp', 'actions')),
            baselineRepoPath: workPath(request.baselineRepoPath),
            baselineSha: request.baselineSha,
            seedRoot: request.seedRoot === null ? null : workPath(request.seedRoot),
          },
          createFileActionWorkspaceEffects(),
        ),
      }
    }
    case 'action-tree-digest':
      return actionTreeDigest(
        workPath((payload as { root: unknown }).root),
        createFileActionWorkspaceEffects(),
      )
    default:
      throw new Error('hosted-development-tree-operation-unknown')
  }
}
