// Complete, restartable logical workspace transport for actual Task mechanics.
import type {
  IsolationConflict,
  IsolationWorkspace,
  IsolationWorkspaceBinding,
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
} from '@/modules/source-control/application/ports/isolationWorkspace'

export interface IsolationCall {
  readonly method: keyof IsolationWorkspaceScope | 'bind'
  readonly binding: IsolationWorkspaceBinding
  readonly args: readonly unknown[]
}

export class MemoryIsolationStore {
  readonly calls: IsolationCall[] = []
  readonly changed = new Map<string, string[]>()
  readonly hashes = new Map<string, Record<string, string>>()
  readonly submodules = new Set<string>()
  readonly merged: IsolationWorkspace[] = []
  readonly discarded: IsolationWorkspace[] = []
  readonly undoOutcomes: Array<{ workspaceRef: string; result: boolean }> = []
  before: (call: IsolationCall) => void | Promise<void> = () => {}
  progress = 2
  conflicts: IsolationConflict[] = []
  invokeResolver = false
}

class MemoryIsolationScope implements IsolationWorkspaceScope {
  #binding: IsolationWorkspaceBinding
  #store: MemoryIsolationStore
  constructor(binding: IsolationWorkspaceBinding, store: MemoryIsolationStore) {
    this.#binding = binding
    this.#store = store
  }
  async #enter(method: keyof IsolationWorkspaceScope, ...args: unknown[]) {
    const call = { method, binding: this.#binding, args }
    this.#store.calls.push(call)
    await this.#store.before(call)
  }
  #workspace(input: {
    key: string
    dbNodeRunId: string
    workspaceRef?: string | null
    baseSnapshots?: Record<string, string>
    taskBaseHeads?: Record<string, string>
    forcedContainerPaths?: string[]
    submodules?: Parameters<IsolationWorkspaceScope['restore']>[0]['submodules']
  }): IsolationWorkspace {
    const reference = input.workspaceRef ?? `memory:workspace:${input.key}`
    return {
      taskId: this.#binding.taskId,
      key: input.key,
      dbNodeRunId: input.dbNodeRunId,
      isolationRef: reference,
      workspaceRef: reference,
      passthrough: false,
      repositories: this.#binding.repositories.map((repo) => ({
        repositoryRef: repo.repositoryRef,
        canonicalRef: repo.workspaceRef,
        workspaceRef: repo.mount === '' ? reference : `${reference}:${repo.mount}`,
        mount: repo.mount,
        baseBranch: repo.baseBranch,
        baseSnapshot: input.baseSnapshots?.[repo.mount] ?? `base@${repo.workspaceRef}`,
        taskBaseHead: input.taskBaseHeads?.[repo.mount] ?? `head@${repo.workspaceRef}`,
        forcedRelativePaths: (input.forcedContainerPaths ?? [])
          .filter((path) => repo.mount === '' || path.startsWith(repo.mount + '/'))
          .map((path) => (repo.mount === '' ? path : path.slice(repo.mount.length + 1))),
        submoduleBases: input.submodules?.[repo.mount]?.submoduleBases ?? {},
        poolRefs: input.submodules?.[repo.mount]?.poolRefs ?? {},
        pendingSubResolutions: input.submodules?.[repo.mount]?.pendingSubResolutions ?? [],
      })),
    }
  }
  async recoverKey(reference: string | null, rowId: string) {
    await this.#enter('recoverKey', reference, rowId)
    return reference === null ? rowId : reference.slice('memory:workspace:'.length)
  }
  async chooseGeneration(
    baseKey: string,
    log?: Parameters<IsolationWorkspaceScope['chooseGeneration']>[1],
  ) {
    await this.#enter('chooseGeneration', baseKey, log)
    return { key: baseKey + '-2', generation: 1, reclaimed: 2 }
  }
  async create(input: Parameters<IsolationWorkspaceScope['create']>[0]) {
    await this.#enter('create', input)
    return this.#workspace(input)
  }
  async restore(input: Parameters<IsolationWorkspaceScope['restore']>[0]) {
    await this.#enter('restore', input)
    return this.#workspace(input)
  }
  async head(reference: string) {
    await this.#enter('head', reference)
    return { stdout: `head@${reference}\n`, stderr: 'native diagnostic retained', exitCode: 0 }
  }
  async submodulePresence(reference: string) {
    await this.#enter('submodulePresence', reference)
    return this.#store.submodules.has(reference)
  }
  async changedFiles(reference: string, baseline: string) {
    await this.#enter('changedFiles', reference, baseline)
    return this.#store.changed.get(reference) ?? []
  }
  async blobHashes(reference: string, paths: string[]) {
    await this.#enter('blobHashes', reference, paths)
    const values = this.#store.hashes.get(reference) ?? {}
    return Object.fromEntries(paths.map((path) => [path, values[path] ?? 'deleted']))
  }
  async snapshot(
    workspace: IsolationWorkspace,
    log?: Parameters<IsolationWorkspaceScope['snapshot']>[1],
    extra?: string[],
  ) {
    await this.#enter('snapshot', workspace, log, extra)
    return {
      trees: Object.fromEntries(
        workspace.repositories.map((repo) => [repo.mount, `tree@${workspace.key}:${repo.mount}`]),
      ),
      workspace,
    }
  }
  async merge(
    workspace: IsolationWorkspace,
    trees: Record<string, string>,
    log?: Parameters<IsolationWorkspaceScope['merge']>[2],
    resolve?: Parameters<IsolationWorkspaceScope['merge']>[3],
  ) {
    await this.#enter('merge', workspace, trees, log, resolve)
    this.#store.merged.push(workspace)
    if (resolve !== undefined && this.#store.invokeResolver) {
      for (const conflict of this.#store.conflicts) await resolve(conflict)
    }
    return {
      clean: this.#store.conflicts.length === 0,
      conflicts: this.#store.conflicts,
      workspace,
    }
  }
  async undoShard(input: Parameters<IsolationWorkspaceScope['undoShard']>[0]) {
    await this.#enter('undoShard', input)
    const result = input.priorNodeCommit !== undefined && input.priorBaseCommit !== undefined
    this.#store.undoOutcomes.push({ workspaceRef: input.workspaceRef, result })
    return result
  }
  async discard(
    workspace: IsolationWorkspace,
    log?: Parameters<IsolationWorkspaceScope['discard']>[1],
    writeWindow?: Parameters<IsolationWorkspaceScope['discard']>[2],
    onProgress?: Parameters<IsolationWorkspaceScope['discard']>[3],
  ) {
    onProgress?.(this.#store.progress)
    await this.#enter('discard', workspace, log, writeWindow)
    this.#store.discarded.push(workspace)
  }
  async resolveConflict(
    conflict: IsolationConflict,
    input: Parameters<IsolationWorkspaceScope['resolveConflict']>[1],
  ) {
    await this.#enter('resolveConflict', conflict, input)
    const reference = `memory:resolve:${conflict.mount}`
    if (this.#store.invokeResolver) {
      await input.runAgent(
        'same resolver callback',
        reference,
        conflict.paths.map((path) => ({
          worktreeDirName: conflict.mount,
          path,
          type: 'content' as const,
        })),
      )
    }
    return { resolved: true, unresolved: [], resolveWorkspaceRef: reference }
  }
  async completeHumanConflict(
    workspace: IsolationWorkspace,
    trees: Record<string, string>,
    log?: Parameters<IsolationWorkspaceScope['completeHumanConflict']>[2],
  ) {
    await this.#enter('completeHumanConflict', workspace, trees, log)
    return { allResolved: true, unresolvedRepos: [] }
  }
}

/** Frozen prototype receivers with private fields catch accidental method extraction. */
export class MemoryIsolationFactory implements IsolationWorkspaceFactory {
  #store: MemoryIsolationStore
  constructor(store: MemoryIsolationStore) {
    this.#store = store
  }
  async bind(binding: IsolationWorkspaceBinding): Promise<IsolationWorkspaceScope> {
    const call: IsolationCall = { method: 'bind', binding, args: [] }
    this.#store.calls.push(call)
    await this.#store.before(call)
    return Object.freeze(new MemoryIsolationScope(binding, this.#store))
  }
}

export function unprintableErrors(): unknown[] {
  return [
    Object.create(null),
    {
      [Symbol.toPrimitive]() {
        throw new Error('conversion rejected')
      },
    },
    Object.defineProperty(new Error('hidden'), 'message', {
      get() {
        throw new Error('message rejected')
      },
    }),
  ]
}
