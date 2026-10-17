import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { IsolationConflict, IsolationWorkspace } from '../application/ports/isolationWorkspace'
import { mergeLocalIsolationWorkspace } from '../infrastructure/local/localIsolationWorkspace'
import { assertTargetDirInsideWorktree } from '@/platform/content/local/uploadPaths'
import { sha256Hex } from '@/util/hash'

interface MergeCheckpoint {
  version: 1
  scene: string
  commits: Record<string, string>
}

/** Each command can finish while a remote Agent works. Confirmed resolutions
 * remain on the task volume across command or control-plane restarts. */
export async function executeTaskImageIsolationMergeStep(
  workspace: IsolationWorkspace,
  trees: Record<string, string>,
  answers: readonly [string, boolean][],
  volumeRoot: string,
) {
  const scene = sha256Hex(
    JSON.stringify([
      workspace.taskId,
      workspace.key,
      workspace.dbNodeRunId,
      workspace.workspaceRef,
      workspace.repositories.map((repo) => [
        repo.repositoryRef,
        repo.baseSnapshot,
        repo.submoduleBases,
      ]),
      Object.entries(trees).sort(([a], [b]) => a.localeCompare(b)),
    ]),
  )
  const directory = join(volumeRoot, 'tmp', 'merge-checkpoints')
  assertTargetDirInsideWorktree(volumeRoot, directory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, `${scene}.json`)
  const checkpoint: MergeCheckpoint = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as MergeCheckpoint)
    : { version: 1, scene, commits: {} }
  if (
    checkpoint.version !== 1 ||
    checkpoint.scene !== scene ||
    checkpoint.commits === null ||
    typeof checkpoint.commits !== 'object' ||
    Object.entries(checkpoint.commits).some(
      ([key, value]) =>
        !/^[a-f0-9]{64}$/.test(key) ||
        typeof value !== 'string' ||
        !/^[a-f0-9]{40,64}$/.test(value),
    )
  )
    throw new Error('hosted-merge-checkpoint-invalid')
  // A failed answer belongs to this merge invocation. Persist only published
  // commits so a later user retry can attempt an unresolved conflict again.
  const decisions = new Map<string, boolean>()
  for (const [key, value] of answers) {
    if (!/^[a-f0-9]{64}$/.test(key) || typeof value !== 'boolean')
      throw new Error('hosted-merge-answer-invalid')
    if (decisions.has(key) && decisions.get(key) !== value)
      throw new Error('hosted-merge-answer-conflict')
    decisions.set(key, value)
  }
  const retain = async () => {
    const temporary = `${file}.${randomUUID()}.tmp`
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(checkpoint))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, file)
    // The task image is Linux. Sync the directory entry as well as file bytes.
    if (process.platform !== 'win32') {
      const dirFd = openSync(dirname(file), 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    }
  }
  await retain()
  let pending: { key: string; conflict: IsolationConflict } | null = null
  const result = await mergeLocalIsolationWorkspace(
    workspace,
    trees,
    undefined,
    async (conflict) => {
      const key = sha256Hex(JSON.stringify(conflict))
      if (decisions.has(key)) return { resolved: decisions.get(key)! }
      pending ??= { key, conflict }
      return { resolved: false }
    },
    { commits: checkpoint.commits, retain },
  )
  return { result, pending }
}
