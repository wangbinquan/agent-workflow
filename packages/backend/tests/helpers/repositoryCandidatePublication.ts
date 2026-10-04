// RFC-370: complete selected receivers map opaque references to real native Git.
import type {
  RepositoryCandidateEffectsFactory,
  RepositoryCandidateSession,
  RepositoryCandidateWorkspace,
  RepositoryCandidateGitOptions,
} from '@/modules/source-control/application/ports/repositoryCandidateEffects'
import type {
  RepositoryPublicationTransport,
  RepositoryPublicationSession,
} from '@/modules/source-control/public/types'
import { createFileRepositoryCandidateEffectsFactory } from '@/modules/source-control/infrastructure/local/fileRepositoryCandidateEffects'
import { runGit } from '@/util/git'

export class CandidatePublicationStore {
  readonly locations = new Map<string, string>()
  readonly trace: string[] = []
  readonly hooks = new Map<string, () => void | Promise<void>>()
  readonly acquisitions: Array<Parameters<RepositoryCandidateEffectsFactory['acquire']>[0]> = []
  readonly baselineCommands: Array<{ reference: string; args: readonly string[] }> = []
  readonly networkCommands: Array<{ reference: string; args: readonly string[] }> = []
  workspacesCreated = 0
  publicationOpens = 0
  publicationCloses = 0
  baselineCloses = 0
  legacyReads = 0

  reference(path: string): string {
    for (const [reference, physical] of this.locations) if (physical === path) return reference
    const reference = `opaque:candidate-publication:${this.locations.size}`
    this.locations.set(reference, path)
    return reference
  }

  physical(reference: string): string {
    const path = this.locations.get(reference)
    if (path === undefined) throw new Error('candidate-reference-unmapped:' + reference)
    return path
  }

  async effect<T>(name: string, action: () => T | Promise<T>): Promise<T> {
    this.trace.push(name)
    await this.hooks.get(name)?.()
    return action()
  }

  poisonLegacy<T extends object>(input: T): T & { readonly runGit: typeof runGit } {
    return Object.defineProperty(input, 'runGit', {
      enumerable: true,
      get: () => {
        this.legacyReads += 1
        throw new Error('selected candidate read the legacy Git getter')
      },
    }) as T & { readonly runGit: typeof runGit }
  }
}

export class MappedCandidateFactory implements RepositoryCandidateEffectsFactory {
  readonly #native = createFileRepositoryCandidateEffectsFactory()
  constructor(readonly store: CandidatePublicationStore) {}

  async acquire(input: Parameters<RepositoryCandidateEffectsFactory['acquire']>[0]) {
    this.store.acquisitions.push(input)
    return this.store.effect('candidate:acquire', async () => {
      const native = await this.#native.acquire({
        baselineReference: this.store.physical(input.baselineReference),
        ...(input.overlayReference === undefined
          ? {}
          : { overlayReference: this.store.physical(input.overlayReference) }),
      })
      return Object.freeze(new MappedCandidateSession(this.store, native, input.baselineReference))
    })
  }
}

class MappedCandidateSession implements RepositoryCandidateSession {
  constructor(
    readonly store: CandidatePublicationStore,
    readonly native: RepositoryCandidateSession,
    readonly reference: string,
  ) {}

  runBaseline(args: readonly string[], options?: RepositoryCandidateGitOptions) {
    this.store.baselineCommands.push({ reference: this.reference, args: [...args] })
    return this.store.effect('candidate:baseline:' + args.join(' '), () =>
      this.native.runBaseline(args, options),
    )
  }

  createWorkspace() {
    return this.store.effect('candidate:create', async () => {
      const native = await this.native.createWorkspace()
      this.store.workspacesCreated += 1
      return Object.freeze(new MappedCandidateWorkspace(this.store, native))
    })
  }

  close() {
    this.store.baselineCloses += 1
    return this.store.effect('candidate:close', () => this.native.close())
  }
}

class MappedCandidateWorkspace implements RepositoryCandidateWorkspace {
  readonly reference: string
  constructor(
    readonly store: CandidatePublicationStore,
    readonly native: RepositoryCandidateWorkspace,
  ) {
    this.reference = store.reference(native.reference)
  }

  cloneBaseline() {
    return this.native.cloneBaseline()
  }
  run(args: readonly string[], options?: RepositoryCandidateGitOptions) {
    return this.native.run(args, options)
  }
  listCandidateRoot() {
    return this.native.listCandidateRoot()
  }
  removeCandidateEntry(path: string) {
    return this.native.removeCandidateEntry(path)
  }
  statOverlay(path: string) {
    return this.native.statOverlay(path)
  }
  listOverlay(path: string) {
    return this.native.listOverlay(path)
  }
  copyOverlayFile(path: string) {
    return this.native.copyOverlayFile(path)
  }
  statCandidate(path: string) {
    return this.native.statCandidate(path)
  }
  setCandidateMode(path: string, mode: number) {
    return this.native.setCandidateMode(path, mode)
  }
  readCandidateDigest(path: string) {
    return this.native.readCandidateDigest(path)
  }
  importCommitToBaseline(
    input: Parameters<RepositoryCandidateWorkspace['importCommitToBaseline']>[0],
  ) {
    return this.native.importCommitToBaseline(input)
  }
  close() {
    return this.native.close()
  }
}

export class MappedCandidatePublicationTransport implements RepositoryPublicationTransport {
  constructor(readonly store: CandidatePublicationStore) {}

  async open(input: Parameters<RepositoryPublicationTransport['open']>[0]) {
    this.store.publicationOpens += 1
    return this.store.effect('publication:open', () => ({
      ok: true as const,
      session: Object.freeze(new MappedCandidatePublicationSession(this.store, input.remoteUrl)),
    }))
  }
}

class MappedCandidatePublicationSession implements RepositoryPublicationSession {
  readonly receipt = Object.freeze({
    credentialSource: 'legacy' as const,
    credentialRevision: null,
    endpointSource: 'local-fixture' as const,
    endpointBindingDigest: null,
  })
  constructor(
    readonly store: CandidatePublicationStore,
    readonly endpointUrl: string,
  ) {}

  runNetwork(
    reference: string,
    args: readonly string[],
    options?: Parameters<RepositoryPublicationSession['runNetwork']>[2],
  ) {
    this.store.networkCommands.push({ reference, args: [...args] })
    return this.store.effect('publication:network:' + args[0], () =>
      runGit(
        this.store.physical(reference),
        args.map((arg) => this.store.locations.get(arg) ?? arg),
        options,
      ),
    )
  }

  async close() {
    this.store.publicationCloses += 1
    await this.store.effect('publication:close', () => undefined)
  }
}

export function completionBarrier() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((done) => {
    enter = done
  })
  const released = new Promise<void>((done) => {
    release = done
  })
  return {
    entered,
    release,
    async before() {
      enter()
      await released
    },
  }
}

export async function enteredBeforeOutcome(entered: Promise<void>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then(() => {
      throw new Error('operation completed before its selected publication effect')
    }),
  ])
}
