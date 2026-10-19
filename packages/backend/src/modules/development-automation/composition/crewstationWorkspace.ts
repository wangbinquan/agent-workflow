import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import type { WorkspaceHelper } from '@/platform/crewstation/workspaceProtocol'
import type {
  AutomationWorkspaceEffectsFactory,
  AutomationWorkspaceTreeOperation,
  AutomationWorkspaceTreeOperations,
} from '../application/ports/automationWorkspaceEffects'
import type { ActionWorkspaceEffects } from '../application/ports/actionWorkspaceEffects'
import type { RepositoryBaselineEffectsFactory } from '../application/ports/repositoryBaselineEffects'
import {
  DEVELOPMENT_TREE_OPERATION,
  DEVELOPMENT_TREE_INLINE_BYTES,
  DEVELOPMENT_TREE_SCRATCH,
  type DevelopmentTreeOutcome,
} from './taskImageWorkspace'

/** RFC-370 §9.2 V3 — the hosted development scene selection. Small, bounded
 * content reads/writes stay per-call; every tree walk (snapshots, validation,
 * digests) and the action scene preparation run as ONE task-image command that
 * calls the same native function against the volume. */
export function composeCrewStationDevelopmentWorkspaces(input: {
  readonly helper: WorkspaceHelper
  readonly locate: (reference: string) => { readonly taskId: string; readonly path: string }
  readonly reference: (taskId: string, path: string) => string
  readonly readFile: (reference: string) => Promise<Uint8Array>
  /** Writes a volume file; carries tree inputs larger than a command's argv. */
  readonly writeFile?: (reference: string, bytes: Uint8Array) => Promise<void>
  readonly applicationRootReference?: string
}) {
  const call = <T>(reference: string, method: string, args: unknown[] = []) => {
    const workspace = input.locate(reference)
    return input.helper.call<T>(workspace.taskId, 'development-workspace', {
      path: workspace.path,
      method,
      args,
    })
  }
  const paired = (source: string, target: string) => {
    const from = input.locate(source)
    const to = input.locate(target)
    if (from.taskId !== to.taskId) throw new Error('hosted-development-volume-mismatch')
    return to.path
  }
  /** All references of one tree operation name one volume. */
  const volume = (references: Readonly<Record<string, string>>) => {
    let owner: string | undefined
    const paths: Record<string, string> = {}
    for (const [key, reference] of Object.entries(references)) {
      const location = input.locate(reference)
      if (owner !== undefined && location.taskId !== owner)
        throw new Error('hosted-development-volume-mismatch')
      owner = location.taskId
      paths[key] = location.path
    }
    if (owner === undefined) throw new Error('hosted-development-reference-required')
    return { owner, paths }
  }
  const translate = (
    operation: AutomationWorkspaceTreeOperation,
    value: unknown,
  ): { readonly owner: string; readonly native: unknown } => {
    switch (operation) {
      case 'business-tree-snapshot':
      case 'action-tree-digest':
      case 'repository-facts-scan':
      case 'seed-tree-digest':
      case 'seed-tree-discard': {
        const { root } = value as { readonly root: string }
        const located = volume({ root })
        return { owner: located.owner, native: { root: located.paths.root } }
      }
      case 'seed-tree-publish': {
        const request = value as {
          readonly staging: string
          readonly root: string
          readonly modes: readonly { readonly path: string; readonly mode: number }[]
        }
        const located = volume({ staging: request.staging, root: request.root })
        return {
          owner: located.owner,
          native: {
            staging: located.paths.staging,
            root: located.paths.root,
            modes: request.modes,
          },
        }
      }
      case 'protected-root-snapshot': {
        const request = value as { readonly roots: Record<string, string>; readonly opts: unknown }
        const located = volume(request.roots)
        return { owner: located.owner, native: { roots: located.paths, opts: request.opts } }
      }
      case 'validate-workspace-outcome': {
        const request = value as {
          readonly workspacePath: string
          readonly protectedRoots: Record<string, string>
        }
        const workspace = input.locate(request.workspacePath)
        const roots = volume(request.protectedRoots)
        if (roots.owner !== workspace.taskId) throw new Error('hosted-development-volume-mismatch')
        return {
          owner: workspace.taskId,
          native: { ...request, workspacePath: workspace.path, protectedRoots: roots.paths },
        }
      }
      case 'action-scene-prepare': {
        const request = value as {
          readonly baselineRepoPath: string
          readonly baselineSha: string
          readonly seedRoot: string | null
        }
        const located = volume({
          baselineRepoPath: request.baselineRepoPath,
          ...(request.seedRoot === null ? {} : { seedRoot: request.seedRoot }),
        })
        // The volume layout decides where scenes live (`/work/tmp/actions`).
        return {
          owner: located.owner,
          native: {
            baselineRepoPath: located.paths.baselineRepoPath,
            baselineSha: request.baselineSha,
            seedRoot: located.paths.seedRoot ?? null,
          },
        }
      }
    }
  }
  const treeOperations: AutomationWorkspaceTreeOperations = {
    async run(operation, value) {
      const { owner, native } = translate(operation, value)
      const json = JSON.stringify(native)
      // Best effort: a leftover payload file in the volume's tmp is harmless
      // and must not mask the operation's own outcome.
      const release = (file: string) =>
        input.helper
          .call(owner, DEVELOPMENT_TREE_OPERATION, { operation: 'release', file })
          .catch(() => undefined)
      let request: unknown = { operation, input: native }
      let inputFile: string | undefined
      // A pre-state of a large tree exceeds a command's argv: it travels as a
      // volume file the handler reads.
      if (
        Buffer.byteLength(json) > DEVELOPMENT_TREE_INLINE_BYTES &&
        input.writeFile !== undefined
      ) {
        inputFile = `${DEVELOPMENT_TREE_SCRATCH}/${randomUUID()}.json`
        await input.writeFile(input.reference(owner, inputFile), Buffer.from(json))
        request = { operation, inputFile }
      }
      let outcome: DevelopmentTreeOutcome
      try {
        outcome = await input.helper.call<DevelopmentTreeOutcome>(
          owner,
          DEVELOPMENT_TREE_OPERATION,
          request,
        )
      } finally {
        if (inputFile !== undefined) await release(inputFile)
      }
      let result = outcome.value
      if (outcome.resultFile !== undefined) {
        // Large results (a whole tree snapshot) are read back with the
        // platform's versioned file API, never through the outcome file.
        try {
          result = JSON.parse(
            Buffer.from(await input.readFile(input.reference(owner, outcome.resultFile))).toString(
              'utf8',
            ),
          ) as unknown
        } finally {
          await release(outcome.resultFile)
        }
      }
      if (operation === 'action-scene-prepare')
        return {
          workspacePath: input.reference(
            owner,
            (result as { readonly workspacePath: string }).workspacePath,
          ),
        }
      return result
    },
  }
  const unsupported = (step: string) => () => {
    throw new Error(`hosted-action-scene-step-runs-in-volume: ${step}`)
  }
  const contents: AutomationWorkspaceEffectsFactory = {
    ...(input.applicationRootReference === undefined
      ? {}
      : { applicationRootReference: input.applicationRootReference }),
    resolve(reference, ...segments) {
      const workspace = input.locate(reference)
      return input.reference(workspace.taskId, posix.join(workspace.path, ...segments))
    },
    parent(reference) {
      const workspace = input.locate(reference)
      return input.reference(workspace.taskId, posix.dirname(workspace.path))
    },
    acquire() {
      return {
        exists: (reference) => call(reference, 'exists'),
        inspect: (reference, followLinks) => call(reference, 'inspect', [followLinks]),
        listNames: (reference) => call(reference, 'listNames'),
        listEntries: (reference) => call(reference, 'listEntries'),
        readBytes: input.readFile,
        readText: async (reference) =>
          Buffer.from(await input.readFile(reference)).toString('utf8'),
        readLink: (reference) => call(reference, 'readLink'),
        createDirectory: (reference, recursive) => call(reference, 'createDirectory', [recursive]),
        copyFile: (source, target, exclusive) =>
          call(source, 'copyFile', [paired(source, target), exclusive]),
        setMode: (reference, mode) => call(reference, 'setMode', [mode]),
        writeText: (reference, text) => call(reference, 'writeText', [text]),
        close() {},
      }
    },
    treeOperations,
  }
  // Scene preparation and digests run in the volume (`treeOperations`); only
  // the discard of a whole scene remains a direct command.
  const action: ActionWorkspaceEffects = {
    contents,
    allocate: unsupported('allocate'),
    cloneBaseline: unsupported('cloneBaseline'),
    run: unsupported('run'),
    installPlatformExclude: unsupported('installPlatformExclude'),
    requireEntry: unsupported('requireEntry'),
    discard: (reference) => call(reference, 'discard'),
  }
  const baselines: RepositoryBaselineEffectsFactory = {
    acquire() {
      return {
        readHead: (reference) => call(reference, 'baseline-head'),
        bindFileReader: (reference, sha) => ({
          stat: (path) => call(reference, 'baseline-stat', [sha, path]),
        }),
        close() {},
      }
    },
  }
  return {
    actionWorkspaceEffects: action,
    automationWorkspaceEffects: contents,
    repositoryBaselines: baselines,
  }
}
