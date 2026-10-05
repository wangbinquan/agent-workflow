import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { ulid } from 'ulid'
import type {
  AgentMaterialSeedFile,
  AgentMaterialWorkspace,
} from '../../application/ports/agentMaterialWorkspace'
import { isLexicallyInsideForHost } from '@/util/platformExec'

/** Only the explicit native compatibility binding owns physical locations. */
export type NativeAgentMaterialWorkspaceInput =
  | {
      readonly kind: 'task'
      readonly appHome: string
      readonly taskId: string
      readonly nodeRunId: string
      readonly workingDirectory: () => string
    }
  | {
      readonly kind: 'system'
      readonly parent: () => string
      readonly feature: () => string
      readonly scratchName: () => string | undefined
      readonly seedFiles?: () => readonly AgentMaterialSeedFile[] | undefined
    }
  | {
      readonly kind: 'smoke'
      readonly appHome: string
    }

/** Keep the original seed interpretation used by the standalone system API. */
export function assertSafeSeedPath(worktreeDir: string, relPath: string): string {
  if (relPath.length === 0 || isAbsolute(relPath)) {
    throw new Error(`unsafe seed path: ${relPath}`)
  }
  // RFC-254 T1: `resolve()` yields `\`-separated paths on Windows, so the old
  // `${worktreeDir}/` prefix test rejected every legitimate seed path there.
  const abs = resolve(worktreeDir, relPath)
  if (!isLexicallyInsideForHost(worktreeDir, abs)) {
    throw new Error(`unsafe seed path: ${relPath}`)
  }
  return abs
}

/** Native legacy retained-scratch API; its original result policy is unchanged. */
export function releaseSystemAgentScratch(input: {
  scratchDir: string
  expectedParent: string
  expectedName: string
}): { removed: boolean; reason?: 'unsafe-path' | 'remove-failed' } {
  if (
    !isAbsolute(input.expectedParent) ||
    resolve(input.expectedParent) !== input.expectedParent ||
    input.expectedName.length === 0 ||
    input.expectedName.includes('\0') ||
    input.expectedName.includes('/') ||
    input.expectedName.includes('\\') ||
    !isAbsolute(input.scratchDir) ||
    resolve(input.scratchDir) !== input.scratchDir ||
    input.scratchDir !== join(input.expectedParent, input.expectedName)
  ) {
    return { removed: false, reason: 'unsafe-path' }
  }
  try {
    const metadata = lstatSync(input.scratchDir)
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return { removed: false, reason: 'unsafe-path' }
    }
    rmSync(input.scratchDir, { recursive: true, force: true })
    return { removed: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: true }
    return { removed: false, reason: 'remove-failed' }
  }
}

/** Directory creation and removal are independent of the process outcome.
 * They run only when the original entry invokes the corresponding operation;
 * in particular, constructing a binding performs no filesystem operation. */
export function bindNativeAgentMaterialWorkspace(input: NativeAgentMaterialWorkspaceInput) {
  const scratchName =
    input.kind === 'system'
      ? (input.scratchName() ?? `${input.feature()}-${randomBytes(8).toString('hex')}`)
      : undefined
  const root =
    input.kind === 'task'
      ? join(input.appHome, 'runs', input.taskId, input.nodeRunId)
      : input.kind === 'system'
        ? join(input.parent(), scratchName!)
        : join(input.appHome, 'scratch', `runtime-smoke-${randomBytes(8).toString('hex')}`)
  const runDirectory = input.kind === 'task' ? root : join(root, 'run')
  const scratchWorkingDirectory = input.kind === 'task' ? undefined : join(root, 'worktree')
  const reference = `aw-agent-workspace:${ulid()}`
  const workspace: AgentMaterialWorkspace = {
    workspace: { owner: 'source-control', reference: `${reference}:working`, version: null },
    runContent: { owner: 'runtime-management', reference: `${reference}:run`, version: null },
    retainedRef: reference,
    prepare(seeds?: readonly AgentMaterialSeedFile[]) {
      // Task materialization owns its existing mkdir. Do not add an earlier
      // creation or move a native builder failure out of its original catch.
      if (input.kind === 'task') return
      if (input.kind === 'system') mkdirSync(input.parent(), { recursive: true, mode: 0o700 })
      const worktreeDir = scratchWorkingDirectory!
      mkdirSync(worktreeDir, { recursive: true, mode: 0o700 })
      mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
      if (input.kind === 'system') {
        for (const seed of seeds ?? input.seedFiles?.() ?? []) {
          const abs = assertSafeSeedPath(worktreeDir, seed.path)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, seed.content)
        }
      }
    },
    discard() {
      rmSync(root, { recursive: true, force: true })
    },
  }
  return {
    workspace,
    /** Existing raw native services alone consume this compatibility view. */
    locations: {
      root,
      runDirectory,
      get workingDirectory() {
        return input.kind === 'task' ? input.workingDirectory() : scratchWorkingDirectory!
      },
    },
  }
}
