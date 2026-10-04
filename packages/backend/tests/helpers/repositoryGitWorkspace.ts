import type { RepositoryGit } from '@/modules/source-control/application/repositoryCommit'
import type {
  RepositoryGitOptions,
  RepositoryGitWorkspaceBinding,
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
  RepositoryPublicationTransport,
} from '@/modules/source-control/public/types'
import type { RepositoryPreviewIndexScope } from '@/modules/source-control/application/ports/repositoryPreviewIndex'
import { selectRepositoryGitWorkspaceFactory } from '@/modules/source-control/public/participants'
import { runGit } from '@/util/git'

export interface GitWorkspaceCall {
  readonly workspaceRef: string
  readonly method:
    | 'run'
    | 'hasSubmodules'
    | 'effectiveSubmodules'
    | 'withPreviewIndex'
    | 'subrepository'
  readonly args?: readonly string[]
  readonly options?: RepositoryGitOptions
}

/** The consumer sees only references; this adapter owns the native test mapping. */
export class GitWorkspaceStore {
  readonly locations = new Map<string, string>()
  readonly bindings: RepositoryGitWorkspaceBinding[] = []
  readonly calls: GitWorkspaceCall[] = []
  readonly nativeCalls: Array<{
    readonly cwd: string
    readonly args: readonly string[]
    readonly options?: RepositoryGitOptions
  }> = []
  readonly networkCalls: Array<{
    readonly workspaceRef: string
    readonly args: readonly string[]
  }> = []
  opened = 0
  closed = 0
  before: (call: GitWorkspaceCall) => void | Promise<void> = () => {}
  after: (call: GitWorkspaceCall) => void | Promise<void> = () => {}

  physical(ref: string): string {
    const value = this.locations.get(ref)
    if (value === undefined) throw new Error('test-workspace-reference-unmapped:' + ref)
    return value
  }

  async effect<T>(call: GitWorkspaceCall, operation: () => Promise<T> | T): Promise<T> {
    this.calls.push(call)
    await this.before(call)
    const result = await operation()
    await this.after(call)
    return result
  }

  transport(original: RepositoryPublicationTransport): RepositoryPublicationTransport {
    return Object.freeze({
      open: async (input) => {
        this.opened += 1
        const result = await original.open(input)
        if (!result.ok) return result
        const session = result.session
        return {
          ok: true,
          session: Object.freeze({
            endpointUrl: session.endpointUrl,
            receipt: session.receipt,
            runNetwork: (workspaceRef, args, options) => {
              this.networkCalls.push({ workspaceRef, args: [...args] })
              return session.runNetwork(this.physical(workspaceRef), args, options)
            },
            close: () => {
              this.closed += 1
              session.close()
            },
          }),
        }
      },
    } satisfies RepositoryPublicationTransport)
  }
}

export class MappedGitWorkspaceFactory implements RepositoryGitWorkspaceFactory {
  readonly #native: RepositoryGitWorkspaceFactory

  constructor(
    readonly store: GitWorkspaceStore,
    git: RepositoryGit = runGit,
  ) {
    this.#native = selectRepositoryGitWorkspaceFactory(undefined, (cwd, args, options) => {
      store.nativeCalls.push({ cwd, args: [...args], options })
      return git(cwd, args, options)
    })
  }

  bind(binding: RepositoryGitWorkspaceBinding): RepositoryGitWorkspaceScope {
    this.store.bindings.push({ ...binding })
    return Object.freeze(
      new MappedGitWorkspaceScope(
        this.store,
        binding.workspaceRef,
        this.#native.bind({ ...binding, workspaceRef: this.store.physical(binding.workspaceRef) }),
      ),
    )
  }
}

class MappedGitWorkspaceScope implements RepositoryGitWorkspaceScope {
  constructor(
    readonly store: GitWorkspaceStore,
    readonly workspaceRef: string,
    readonly native: RepositoryGitWorkspaceScope,
  ) {}

  run(args: readonly string[], options?: RepositoryGitOptions) {
    return this.store.effect(
      { workspaceRef: this.workspaceRef, method: 'run', args, options },
      () => this.native.run(args, options),
    )
  }

  hasSubmodules() {
    return this.store.effect({ workspaceRef: this.workspaceRef, method: 'hasSubmodules' }, () =>
      this.native.hasSubmodules(),
    )
  }

  effectiveSubmodules() {
    return this.store.effect(
      { workspaceRef: this.workspaceRef, method: 'effectiveSubmodules' },
      () => this.native.effectiveSubmodules(),
    )
  }

  withPreviewIndex<Result>(
    operation: (index: RepositoryPreviewIndexScope) => Promise<Result>,
    options?: RepositoryGitOptions,
  ): Promise<Result> {
    return this.store.effect(
      { workspaceRef: this.workspaceRef, method: 'withPreviewIndex', options },
      () => this.native.withPreviewIndex(operation, options),
    )
  }

  subrepository(relativePath: string): RepositoryGitWorkspaceScope {
    this.store.calls.push({
      workspaceRef: this.workspaceRef,
      method: 'subrepository',
      args: [relativePath],
    })
    const native = this.native.subrepository(relativePath)
    const workspaceRef =
      'opaque-child:' + encodeURIComponent(this.workspaceRef + '\0' + relativePath)
    this.store.locations.set(workspaceRef, native.workspaceRef)
    return Object.freeze(new MappedGitWorkspaceScope(this.store, workspaceRef, native))
  }
}
