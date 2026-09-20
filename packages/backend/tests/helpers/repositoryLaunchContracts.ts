/** RFC-362 test composition only. Maps are process-local characterization state,
 * never a durable seal/journal implementation or a production admission writer. */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { decodeRepositoryLaunchRef } from '@/modules/source-control/domain/repositoryLaunchRef'
import type { ProviderNeutralDatabase } from '@/db/query'
import { cachedRepos, repoGroups } from '@/db/schema'
import type { DatabaseSession } from '@/platform/persistence/databaseTransaction'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import {
  createRepositoryScopeAuthorizationInTx,
  repositoryScopeExistenceReads,
  type RepositoryLaunchSnapshotInTx,
  type RepositoryPreparationEffectCapability,
  type RepositoryPreparationParticipant,
  type PublicRepositorySourceSealPort,
  type WorkspaceContentParticipant,
} from '@/modules/source-control/public/participants'
import type {
  AuthorizedWorkspaceSnapshotRef,
  FrozenRepositoryPreparationRef,
  RepositoryPreparationOperationRef,
  RepositoryPreparationReceiptRef,
  RepositoryPreparationDiagnosticsRef,
  SealedPublicRepositorySourceRef,
  WorkspacePreparationExecutionOutcome,
} from '@/modules/source-control/public/types'
import type {
  TaskWorkspaceReadPort,
  WorkspaceReadCapability,
} from '@/modules/task-execution/application/ports/workspaceLaunch'
import { composeRepositoryWorkspaceStore } from '@/modules/source-control/composition'
import { ensureCachedRepoIdentity } from '@/services/gitRepoCache'
import { listWorktreeDir, readWorktreeFile } from '@/services/worktreeFiles'
import {
  cleanupCreatedWorktree,
  createWorktree,
  type CreatedWorktree,
  type CreateWorktreeOptions,
} from '@/util/git'

type RepositoryRow = typeof cachedRepos.$inferSelect
export function repositoryRevision(row: RepositoryRow): string {
  // Characterization digest only. lastFetchedAt is not a durable revision.
  return createHash('sha256').update(JSON.stringify(row)).digest('hex')
}
export function repositoryLaunchContracts(input: {
  db: ProviderNeutralDatabase
  session: DatabaseSession
  appHome: string
  authority: RequestAuthority
}) {
  const scope = createRepositoryScopeAuthorizationInTx(repositoryScopeExistenceReads)
  const sealed = new Map<
    SealedPublicRepositorySourceRef,
    { cachedRepoId: string; requestedRef?: string }
  >()
  const sealRequests = new Map<string, { input: string; ref: SealedPublicRepositorySourceRef }>()
  const frozen = new Map<FrozenRepositoryPreparationRef, { row: RepositoryRow; base: string }>()
  const effects = new WeakMap<
    RepositoryPreparationEffectCapability,
    {
      operation: RepositoryPreparationOperationRef
      options: Omit<CreateWorktreeOptions, 'repoPath' | 'appHome'>
    }
  >()
  const operations = new Map<
    RepositoryPreparationOperationRef,
    {
      source: FrozenRepositoryPreparationRef
      result: Promise<WorkspacePreparationExecutionOutcome>
    }
  >()
  const receipts = new Map<RepositoryPreparationReceiptRef, CreatedWorktree>()
  const diagnostics = new Map<RepositoryPreparationDiagnosticsRef, unknown>()
  const snapshots = new Map<AuthorizedWorkspaceSnapshotRef, string>()
  const taskReads = new WeakMap<WorkspaceReadCapability, AuthorizedWorkspaceSnapshotRef>()
  let transactionDepth = 0
  function outsideTransaction() {
    if (transactionDepth !== 0) throw new Error('repository-effect-inside-snapshot-transaction')
  }
  const seal: PublicRepositorySourceSealPort = {
    async seal(context, source) {
      outsideTransaction()
      if (context.authority !== input.authority) throw new Error('test-authority-mismatch')
      const request = JSON.stringify(source)
      const old = sealRequests.get(context.idempotencyKey)
      if (old) {
        if (old.input !== request) throw new Error('test-seal-request-mismatch')
        return old.ref
      }
      const identity = await ensureCachedRepoIdentity(
        {
          store: composeRepositoryWorkspaceStore(input.db),
          appHome: input.appHome,
        },
        { url: source.url },
      )
      const ref = decodeRepositoryLaunchRef('source', `sc:source:v1:${ulid()}`)
      sealed.set(ref, {
        cachedRepoId: identity.cachedRepoId,
        ...(source.requestedRef === undefined ? {} : { requestedRef: source.requestedRef }),
      })
      sealRequests.set(context.idempotencyKey, { input: request, ref })
      return ref
    },
  }
  async function withSnapshot<T>(
    work: (
      snapshot: RepositoryLaunchSnapshotInTx,
      tx: Parameters<Parameters<DatabaseSession['transaction']>[0]>[0],
    ) => Promise<T>,
  ): Promise<T> {
    const pending = new Map<FrozenRepositoryPreparationRef, { row: RepositoryRow; base: string }>()
    const result = await input.session.transaction(async (tx) => {
      transactionDepth += 1
      let active = true
      const participant = Object.freeze({
        async resolveAuthorized(
          authority: RequestAuthority,
          source: Parameters<RepositoryLaunchSnapshotInTx['resolveAuthorized']>[1],
        ) {
          if (!active) throw new Error('snapshot-scope-ended')
          if (authority !== input.authority) throw new Error('test-authority-mismatch')
          if (source.kind === 'repository-group') {
            if (!(await scope.exists(tx, { kind: 'repo_group', id: source.group.id })))
              throw new Error('repo-group-not-found')
            const row = (
              await tx.select().from(repoGroups).where(eq(repoGroups.id, source.group.id))
            )[0]
            if (row?.version !== source.group.version) throw new Error('repository-version-changed')
            // No frozen group preparation journal exists. Do not synthesize a successful receipt.
            throw new Error('group-frozen-preparation-unavailable')
          }
          const sealedSource =
            source.kind === 'sealed-public-repository' ? sealed.get(source.source) : undefined
          if (source.kind === 'sealed-public-repository' && !sealedSource)
            throw new Error('seal-replay-unavailable')
          const id =
            source.kind === 'repository' ? source.repository.id : sealedSource!.cachedRepoId
          if (!(await scope.exists(tx, { kind: 'repo', id })))
            throw new Error('cached-repo-not-found')
          const row = (await tx.select().from(cachedRepos).where(eq(cachedRepos.id, id)))[0]
          if (!row) throw new Error('cached-repo-not-found')
          if (
            source.kind === 'repository' &&
            repositoryRevision(row) !== source.repository.revision
          )
            throw new Error('repository-version-changed')
          if (!active) throw new Error('snapshot-scope-ended')
          const ref = decodeRepositoryLaunchRef('preparation', `sc:preparation:v1:${ulid()}`)
          pending.set(ref, {
            row: structuredClone(row),
            base:
              source.kind === 'repository'
                ? source.base
                : (sealedSource?.requestedRef ?? row.defaultBranch ?? 'HEAD'),
          })
          return ref
        },
      }) as RepositoryLaunchSnapshotInTx
      try {
        return await work(participant, tx)
      } finally {
        active = false
        transactionDepth -= 1
      }
    })
    for (const [ref, value] of pending) frozen.set(ref, value)
    return result
  }
  function failure(
    safeCode: 'preparation-failed' | 'replay-unavailable',
    error: unknown,
  ): WorkspacePreparationExecutionOutcome {
    const ref = decodeRepositoryLaunchRef('diagnostics', `sc:diagnostics:v1:${ulid()}`)
    diagnostics.set(ref, error)
    return { kind: 'failed', safeCode, diagnostics: ref }
  }
  const preparation: RepositoryPreparationParticipant = {
    async prepare(capability, operation, source) {
      outsideTransaction()
      const effect = effects.get(capability)
      if (!effect || effect.operation !== operation)
        throw new Error('test-preparation-binding-mismatch')
      const previous = operations.get(operation)
      if (previous) {
        if (previous.source !== source) throw new Error('test-operation-source-mismatch')
        return previous.result
      }
      const snapshot = frozen.get(source)
      if (!snapshot)
        return failure('replay-unavailable', new Error('frozen-source-not-in-this-process'))
      const result = (async (): Promise<WorkspacePreparationExecutionOutcome> => {
        try {
          const workspace = await createWorktree({
            ...effect.options,
            repoPath: snapshot.row.localPath,
            baseBranch: snapshot.base,
            appHome: input.appHome,
          })
          const receipt = decodeRepositoryLaunchRef('receipt', `sc:receipt:v1:${ulid()}`)
          receipts.set(receipt, workspace)
          return { kind: 'prepared', receipt }
        } catch (error) {
          if (effect.options.signal?.aborted)
            return {
              kind: 'stopped',
              receipt: decodeRepositoryLaunchRef('stopped', `sc:stopped:v1:${ulid()}`),
            }
          return failure('preparation-failed', error)
        }
      })()
      operations.set(operation, { source, result })
      return result
    },
  }
  function pathFor(snapshot: AuthorizedWorkspaceSnapshotRef): string {
    outsideTransaction()
    const path = snapshots.get(snapshot)
    if (!path) throw new Error('workspace-snapshot-unavailable')
    return path
  }
  function bound(value: number, minimum: number) {
    if (!Number.isSafeInteger(value) || value < minimum)
      throw new Error('invalid-workspace-read-bound')
  }
  const content: WorkspaceContentParticipant = {
    async list(snapshot, request) {
      bound(request.page.offset, 0)
      bound(request.maxEntries, 1)
      const page = await listWorktreeDir(pathFor(snapshot), request.relativeDirectory)
      const end = Math.min(page.entries.length, request.page.offset + request.maxEntries)
      return {
        entries: page.entries.slice(request.page.offset, end),
        nextOffset: end < page.entries.length ? end : null,
        truncated: page.truncated,
      }
    },
    async read(snapshot, request) {
      bound(request.offset, 0)
      bound(request.maxBytes, 1)
      const read = await readWorktreeFile(pathFor(snapshot), request.relativeFile)
      // Existing reader returns UTF-8 display text, not arbitrary binary bytes.
      const bytes = Buffer.from(read.content, 'utf8')
      const end = Math.min(bytes.length, request.offset + request.maxBytes)
      return {
        encoding: 'base64',
        content: bytes.subarray(request.offset, end).toString('base64'),
        size: read.size,
        offset: request.offset,
        nextOffset: end < bytes.length ? end : null,
        oversized: read.oversized,
      }
    },
  }
  function snapshotFor(capability: WorkspaceReadCapability): AuthorizedWorkspaceSnapshotRef {
    const snapshot = taskReads.get(capability)
    if (!snapshot) throw new Error('task-workspace-binding-unavailable')
    return snapshot
  }
  const taskWorkspace: TaskWorkspaceReadPort = {
    list: (capability, request) => content.list(snapshotFor(capability), request),
    read: (capability, request) => content.read(snapshotFor(capability), request),
  }
  return {
    seal,
    withSnapshot,
    preparation,
    content,
    taskWorkspace,
    effect(options: Omit<CreateWorktreeOptions, 'repoPath' | 'appHome'>) {
      const operation = decodeRepositoryLaunchRef('operation', `sc:operation:v1:${ulid()}`)
      const capability = Object.freeze({}) as RepositoryPreparationEffectCapability
      effects.set(capability, { operation, options })
      return { capability, operation }
    },
    workspace(receipt: RepositoryPreparationReceiptRef) {
      const workspace = receipts.get(receipt)
      if (!workspace) throw new Error('preparation-receipt-unavailable')
      return workspace
    },
    async rollback(receipt: RepositoryPreparationReceiptRef) {
      outsideTransaction()
      const workspace = receipts.get(receipt)
      if (!workspace) throw new Error('preparation-receipt-unavailable')
      return cleanupCreatedWorktree(workspace.cleanup)
    },
    bindRead(receipt: RepositoryPreparationReceiptRef) {
      const workspace = receipts.get(receipt)
      if (!workspace) throw new Error('preparation-receipt-unavailable')
      const snapshot = decodeRepositoryLaunchRef('workspace', `sc:workspace:v1:${ulid()}`)
      snapshots.set(snapshot, workspace.worktreePath)
      const capability = Object.freeze({}) as WorkspaceReadCapability
      taskReads.set(capability, snapshot)
      return { snapshot, capability }
    },
    diagnostic(ref: RepositoryPreparationDiagnosticsRef) {
      return diagnostics.get(ref)
    },
  }
}
