import {
  type PlannedRepo,
  type PlannedDirectoryNode,
  canonicalJson,
  flattenRepoGroup,
  RepoGroupLayoutError,
  type FlattenableGroup,
  type FlattenableNode,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type { RequestAuthority } from '@/modules/identity-access/public/participants'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { sha256Hex } from '@/util/hash'
import type { RepositoryLaunchSnapshotInTx } from './ports/repositoryLaunch'
import { decodeRepositoryLaunchRef } from '../domain/repositoryLaunchRef'
import {
  RepositoryPreparationFactsSchema,
  SealedRepositorySourceFactsSchema,
  repositoryPreparationFactsJson,
  repositoryPreparationRevision,
  type RepositoryPreparationFacts,
} from '../domain/repositoryPreparationFacts'
import type {
  FrozenRepositoryPreparationRef,
  RepositoryLaunchSource,
  VersionedRepositoryRef,
} from '../public/types'
import type {
  CachedRepositoryRecord,
  RepositoryGroupSnapshot,
} from '../ports/repositoryWorkspaceStore'
import type { RepositoryPreparationJournal } from './ports/repositoryPreparationJournal'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'

function flattened(snapshot: RepositoryGroupSnapshot, id: string) {
  const groups = new Map<string, FlattenableGroup>(
    snapshot.groups.map((g) => [g.id, { id: g.id, name: g.name, nodes: [] }]),
  )
  for (const node of snapshot.nodes) {
    const group = groups.get(node.groupId)
    if (group === undefined) continue
    const attachment =
      node.attachmentKind === 'repo'
        ? {
            kind: 'repo' as const,
            cachedRepoId: node.cachedRepoId ?? '',
            repoUrlRedacted: snapshot.repoUrls.get(node.cachedRepoId ?? '') ?? '',
            ref: node.ref,
            subdir: node.subdir,
            readonly: node.readonly,
          }
        : node.attachmentKind === 'group'
          ? {
              kind: 'group' as const,
              childGroupId: node.childGroupId ?? '',
              readonly: node.readonly,
            }
          : null
    ;(group.nodes as FlattenableNode[]).push({ path: node.path, attachment })
  }
  try {
    return flattenRepoGroup(id, (groupId) => groups.get(groupId))
  } catch (error) {
    if (error instanceof RepoGroupLayoutError)
      throw new ValidationError(error.code, error.message, error.detail)
    throw error
  }
}

function repositoryFact(row: CachedRepositoryRecord) {
  return {
    id: row.id,
    revision: repositoryPreparationRevision(row),
    urlHash: row.urlHash,
    defaultBranch: row.defaultBranch,
  }
}

/** Root supplies the Task-owned live scope. This factory opens no transaction and performs no Git/FS. */
export function createRepositoryLaunchSnapshot(input: {
  readonly journal: RepositoryPreparationJournal
  readonly store: RepositoryWorkspaceStore
  readonly authority: RequestAuthority
  readonly assertLive: () => void
  readonly now: number
}) {
  const { journal, store } = input
  let closed = false
  function assertLive() {
    input.assertLive()
    if (closed) throw new Error('repository-launch-scope-ended')
  }
  async function row(id: string) {
    assertLive()
    const value = await store.findCachedRepoById(id)
    assertLive()
    if (value === null)
      throw new NotFoundError('cached-repo-not-found', `cached repository ${id} not found`)
    return value
  }
  async function factsFor(source: RepositoryLaunchSource): Promise<RepositoryPreparationFacts> {
    if (source.kind === 'repository-group') {
      const snapshot = await store.readRepositoryGroupSnapshot()
      const root = snapshot.groups.find((group) => group.id === source.group.id)
      if (root === undefined)
        throw new NotFoundError('repo-group-not-found', `repo group ${source.group.id} not found`)
      if (root.version !== source.group.version)
        throw new ConflictError(
          'repository-version-changed',
          'repository group changed before admission',
        )
      const layout = flattened(snapshot, root.id)
      if (layout.repos.length === 0)
        throw new ValidationError(
          'repo-group-empty',
          'repo group flattens to zero repos; a task needs at least one repo to run in',
        )
      // Include empty directory-only nested groups, not just groups on repository paths.
      const visited = new Set<string>()
      const visit = (id: string) => {
        if (visited.has(id)) return
        visited.add(id)
        for (const node of snapshot.nodes)
          if (node.groupId === id && node.attachmentKind === 'group' && node.childGroupId !== null)
            visit(node.childGroupId)
      }
      visit(root.id)
      const repositories = []
      for (const id of [...new Set(layout.repos.map((repo) => repo.cachedRepoId))])
        repositories.push(repositoryFact(await row(id)))
      return {
        version: 1,
        kind: 'repository-group',
        repositories,
        groups: snapshot.groups
          .filter((group) => visited.has(group.id))
          .map(({ id, version, name }) => ({ id, version, name }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        layout: { repos: layout.repos, nodes: layout.nodes },
        groupName: root.name,
      }
    }
    const sealed =
      source.kind === 'sealed-public-repository'
        ? await journal.source(decodeRepositoryLaunchRef('source', source.source))
        : null
    if (source.kind === 'sealed-public-repository' && sealed === null)
      throw new NotFoundError(
        'repository-source-unavailable',
        'sealed repository source is unavailable',
      )
    const sealedFacts =
      sealed === null ? null : SealedRepositorySourceFactsSchema.parse(JSON.parse(sealed.factsJson))
    const repository = await row(
      source.kind === 'repository' ? source.repository.id : sealedFacts!.cachedRepoId,
    )
    const revision = repositoryPreparationRevision(repository)
    if (source.kind === 'repository' && source.repository.revision !== revision)
      throw new ConflictError(
        'repository-version-changed',
        'repository source configuration changed before admission',
      )
    const base = source.kind === 'repository' ? source.base : (sealedFacts!.requestedRef ?? '')
    return {
      version: 1,
      kind: 'repository',
      repositories: [repositoryFact(repository)],
      groups: [],
      groupName: null,
      layout: {
        repos: [
          {
            cachedRepoId: repository.id,
            repoUrlRedacted: repository.urlRedacted ?? '',
            ref: base,
            subdir: '',
            mountPath: '',
            readonly: false,
            viaGroups: [],
          },
        ],
        nodes: [],
      },
    }
  }
  const liveParticipants = new WeakSet<RepositoryLaunchSnapshotInTx>()
  function createRepositoryLaunchSnapshotParticipant(): RepositoryLaunchSnapshotInTx {
    const participant = Object.freeze({
      async resolveAuthorized(
        authority: RequestAuthority,
        source: RepositoryLaunchSource,
      ): Promise<FrozenRepositoryPreparationRef> {
        if (!liveParticipants.has(participant)) throw new Error('repository-launch-scope-ended')
        assertLive()
        if (authority !== input.authority)
          throw new Error('repository-launch-authority-scope-mismatch')
        const facts = await factsFor(source)
        assertLive()
        const factsJson = repositoryPreparationFactsJson(facts)
        const revision = `sha256:${sha256Hex(factsJson)}`
        const sealed =
          source.kind === 'sealed-public-repository'
            ? (await journal.source(source.source))!
            : await journal.seal({
                id: `sc:source:v1:${ulid()}`,
                requestKey: `snapshot-source:${revision}`,
                requestDigest: revision,
                kind: source.kind,
                factsJson,
                createdAt: input.now,
              })
        const frozen = await journal.freeze({
          id: `sc:preparation:v1:${ulid()}`,
          sourceRef: sealed.id,
          revision,
          factsJson,
          createdAt: input.now,
        })
        assertLive()
        return decodeRepositoryLaunchRef('preparation', frozen.id)
      },
    }) as RepositoryLaunchSnapshotInTx
    liveParticipants.add(participant)
    return participant
  }
  const participant = createRepositoryLaunchSnapshotParticipant()
  return Object.freeze({
    participant,
    close() {
      closed = true
      liveParticipants.delete(participant)
    },
    /** The Task owner supplies its historical layout in the same live transaction.
     * This deliberately does not read the editable group definition. */
    async frozenLayout(layout: {
      readonly repos: readonly PlannedRepo[]
      readonly nodes: readonly PlannedDirectoryNode[]
    }): Promise<FrozenRepositoryPreparationRef> {
      assertLive()
      const repositories = []
      for (const id of [...new Set(layout.repos.map((repo) => repo.cachedRepoId))])
        repositories.push(repositoryFact(await row(id)))
      const factsJson = repositoryPreparationFactsJson({
        version: 1,
        kind: 'repository-group',
        repositories,
        groups: [],
        groupName: null,
        layout: { repos: [...layout.repos], nodes: [...layout.nodes] },
      })
      const revision = `sha256:${sha256Hex(factsJson)}`
      const sealed = await journal.seal({
        id: `sc:source:v1:${ulid()}`,
        requestKey: `frozen-task-layout:${revision}`,
        requestDigest: revision,
        kind: 'repository-group',
        factsJson,
        createdAt: input.now,
      })
      const frozen = await journal.freeze({
        id: `sc:preparation:v1:${ulid()}`,
        sourceRef: sealed.id,
        revision,
        factsJson,
        createdAt: input.now,
      })
      assertLive()
      return decodeRepositoryLaunchRef('preparation', frozen.id)
    },
    async currentRepository(id: string): Promise<VersionedRepositoryRef> {
      const current = await row(id)
      return { id: current.id, revision: repositoryPreparationRevision(current) }
    },
    async currentGroup(id: string) {
      assertLive()
      const current = (await store.readRepositoryGroupSnapshot()).groups.find(
        (group) => group.id === id,
      )
      assertLive()
      if (current === undefined)
        throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
      return { id: current.id, version: current.version }
    },
  })
}

/** Used by effects after a restart; lookup is durable, not a ref-to-object Map. */
export async function readRepositoryPreparationFactsFromJournal(
  journal: RepositoryPreparationJournal,
  reference: FrozenRepositoryPreparationRef,
) {
  const frozen = await journal.snapshot(decodeRepositoryLaunchRef('preparation', reference))
  if (frozen === null)
    throw new NotFoundError(
      'repository-snapshot-unavailable',
      'frozen repository preparation is unavailable',
    )
  const facts = RepositoryPreparationFactsSchema.parse(JSON.parse(frozen.factsJson))
  if (`sha256:${sha256Hex(canonicalJson(facts))}` !== frozen.revision)
    throw new Error('repository-snapshot-content-mismatch')
  return facts
}
