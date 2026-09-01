// RFC-249 — 仓库组目录树 CRUD、展平、预览与引用守卫。
// DB 与公开 wire 的唯一事实源都是 repo_group_nodes；旧 members 模型已完全退役。

import type {
  CreateRepoGroup,
  FlattenableAttachment,
  FlattenableGroup,
  FlattenableNode,
  PlannedDirectoryNode,
  PlannedRepo,
  RepoGroup,
  RepoGroupLayoutResponse,
  RepoGroupNode,
  RepoGroupNodeInput,
} from '@agent-workflow/shared'
import {
  RepoGroupLayoutError,
  flattenRepoGroup,
  normalizeMountPath,
  validateRepoGroupNodes,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'
import type {
  RepositoryGroupNodeRecord,
  RepositoryGroupRecord,
  RepositoryGroupSnapshot,
  RepositoryWorkspaceStore,
} from '@/modules/source-control/public/operations'
import { resolveCachedRepo, type GitRepoCacheDeps } from '@/services/gitRepoCache'
import {
  ConflictError,
  DomainError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'

export interface RepoGroupDeps {
  store: RepositoryWorkspaceStore
  cache?: GitRepoCacheDeps
  now?: () => number
}

export class RepoGroupHasReferencesError extends DomainError {
  constructor(
    readonly referencingGroups: Array<{ id: string; name: string }>,
    readonly referencingSchedules: Array<{ id: string; name: string }> = [],
  ) {
    const parts: string[] = []
    if (referencingGroups.length > 0) parts.push(`${referencingGroups.length} repo group(s)`)
    if (referencingSchedules.length > 0) {
      parts.push(`${referencingSchedules.length} scheduled task(s)`)
    }
    super(
      'repo-group-has-references',
      `${parts.join(' and ')} still reference this group; pass force=1 to detach/disable them`,
      409,
      { referencingGroups, referencingSchedules },
    )
  }
}

type RawGroupRow = RepositoryGroupRecord
type RawNodeRow = RepositoryGroupNodeRecord

type RepoGroupWrite = CreateRepoGroup
type RepoGroupPreviewWrite = { name?: string; nodes: readonly RepoGroupNodeInput[] }

function asValidation(error: unknown): never {
  if (error instanceof RepoGroupLayoutError) {
    throw new ValidationError(error.code, error.message, error.detail)
  }
  throw error
}

function loadAllGroups(snapshot: RepositoryGroupSnapshot): Map<string, FlattenableGroup> {
  const groups = snapshot.groups
  const nodes = snapshot.nodes
  const repoUrlById = snapshot.repoUrls

  const byId = new Map<string, FlattenableGroup>()
  for (const group of groups) byId.set(group.id, { id: group.id, name: group.name, nodes: [] })
  for (const row of nodes) {
    const group = byId.get(row.groupId)
    if (group === undefined) continue
    let attachment: FlattenableAttachment | null = null
    if (row.attachmentKind === 'repo') {
      attachment = {
        kind: 'repo',
        cachedRepoId: row.cachedRepoId ?? '',
        repoUrlRedacted: repoUrlById.get(row.cachedRepoId ?? '') ?? '',
        ref: row.ref,
        subdir: row.subdir,
        readonly: row.readonly,
      }
    } else if (row.attachmentKind === 'group') {
      attachment = {
        kind: 'group',
        childGroupId: row.childGroupId ?? '',
        readonly: row.readonly,
      }
    }
    ;(group.nodes as FlattenableNode[]).push({ path: row.path, attachment })
  }
  return byId
}

export async function resolveRepoGroupLayout(
  store: RepositoryWorkspaceStore,
  groupId: string,
): Promise<{
  repos: PlannedRepo[]
  nodes: PlannedDirectoryNode[]
  maxDepth: number
  groupName: string
}> {
  const all = loadAllGroups(await store.readRepositoryGroupSnapshot())
  const root = all.get(groupId)
  if (root === undefined) {
    throw new NotFoundError('repo-group-not-found', `repo group ${groupId} not found`)
  }
  try {
    const { repos, nodes, maxDepth } = flattenRepoGroup(groupId, (id) => all.get(id))
    return { repos, nodes, maxDepth, groupName: root.name }
  } catch (error) {
    asValidation(error)
  }
}

export async function previewRepoGroupLayout(
  store: RepositoryWorkspaceStore,
  input: RepoGroupPreviewWrite,
): Promise<RepoGroupLayoutResponse & { pendingImports: number; pendingRepoPaths: string[] }> {
  const snapshot = await store.readRepositoryGroupSnapshot()
  const all = loadAllGroups(snapshot)
  const urlById = snapshot.repoUrls

  let normalized: Array<{ path: string; attachment: RepoGroupNodeInput['attachment'] }>
  try {
    normalized = validateRepoGroupNodes(input.nodes)
  } catch (error) {
    asValidation(error)
  }

  const pendingIds = new Set<string>()
  const pendingRepoPaths: string[] = []
  const nodes: FlattenableNode[] = normalized.map((node, index) => {
    const attachment = node.attachment
    if (attachment === null) return { path: node.path, attachment: null }
    if (attachment.kind === 'group') {
      if (!all.has(attachment.childGroupId)) {
        throw new NotFoundError(
          'repo-group-not-found',
          `child repo group ${attachment.childGroupId} not found`,
        )
      }
      return {
        path: node.path,
        attachment: {
          kind: 'group',
          childGroupId: attachment.childGroupId,
          readonly: attachment.readonly,
        },
      }
    }
    let cachedRepoId = attachment.cachedRepoId
    if (cachedRepoId === undefined) {
      cachedRepoId = `__pending__${index}`
      pendingIds.add(cachedRepoId)
      pendingRepoPaths.push(node.path)
    }
    return {
      path: node.path,
      attachment: {
        kind: 'repo',
        cachedRepoId,
        repoUrlRedacted: urlById.get(cachedRepoId) ?? '',
        ref: attachment.ref,
        subdir: attachment.subdir,
        readonly: attachment.readonly,
      },
    }
  })

  const draftId = '__draft__'
  const withDraft = new Map(all)
  withDraft.set(draftId, { id: draftId, name: input.name ?? '', nodes })
  try {
    const result = flattenRepoGroup(draftId, (id) => withDraft.get(id))
    const repos = result.repos.filter((repo) => !pendingIds.has(repo.cachedRepoId))
    return {
      groupId: draftId,
      groupName: input.name ?? '',
      repos,
      nodes: result.nodes,
      totalRepos: result.repos.length,
      totalNodes: result.nodes.length,
      maxDepth: result.maxDepth,
      pendingImports: pendingIds.size,
      pendingRepoPaths,
    }
  } catch (error) {
    asValidation(error)
  }
}

export async function getRepoGroupLayoutResponse(
  store: RepositoryWorkspaceStore,
  groupId: string,
): Promise<RepoGroupLayoutResponse> {
  const { repos, nodes, maxDepth, groupName } = await resolveRepoGroupLayout(store, groupId)
  return {
    groupId,
    groupName,
    repos,
    nodes,
    totalRepos: repos.length,
    totalNodes: nodes.length,
    maxDepth,
  }
}

function toDto(
  snapshot: RepositoryGroupSnapshot,
  row: RawGroupRow,
  all: Map<string, FlattenableGroup>,
): RepoGroup {
  const sourceNodes = all.get(row.id)?.nodes ?? []
  const nodes: RepoGroupNode[] = sourceNodes.map((node) => {
    const attachment = node.attachment
    if (attachment === null) return { path: node.path, attachment: null }
    if (attachment.kind === 'repo') {
      return {
        path: node.path,
        attachment: {
          kind: 'repo',
          cachedRepoId: attachment.cachedRepoId,
          repoUrlRedacted: attachment.repoUrlRedacted,
          ref: attachment.ref,
          subdir: attachment.subdir,
          readonly: attachment.readonly,
        },
      }
    }
    return {
      path: node.path,
      attachment: {
        kind: 'group',
        childGroupId: attachment.childGroupId,
        childGroupName: all.get(attachment.childGroupId)?.name ?? '',
        readonly: attachment.readonly,
      },
    }
  })
  let flatRepoCount = 0
  try {
    flatRepoCount = flattenRepoGroup(row.id, (id) => all.get(id)).repos.length
  } catch (error) {
    if (!(error instanceof RepoGroupLayoutError)) throw error
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    schemaVersion: row.schemaVersion,
    createdByUserId: row.createdByUserId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    nodes,
    directNodeCount: nodes.length,
    flatRepoCount,
    boundMemories: snapshot.boundMemoryCounts.get(row.id) ?? 0,
  }
}

export async function listRepoGroups(store: RepositoryWorkspaceStore): Promise<RepoGroup[]> {
  const snapshot = await store.readRepositoryGroupSnapshot()
  const all = loadAllGroups(snapshot)
  return [...snapshot.groups]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((row) => toDto(snapshot, row, all))
}

export async function getRepoGroup(
  store: RepositoryWorkspaceStore,
  id: string,
): Promise<RepoGroup> {
  const snapshot = await store.readRepositoryGroupSnapshot()
  const row = snapshot.groups.find((candidate) => candidate.id === id)
  if (row === undefined) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  return toDto(snapshot, row, loadAllGroups(snapshot))
}

async function materializeNodes(
  deps: RepoGroupDeps,
  snapshot: RepositoryGroupSnapshot,
  input: RepoGroupWrite,
): Promise<RawNodeRow[]> {
  let normalized: Array<{ path: string; attachment: RepoGroupNodeInput['attachment'] }>
  try {
    normalized = validateRepoGroupNodes(input.nodes)
  } catch (error) {
    asValidation(error)
  }

  const output: RawNodeRow[] = []
  for (const [index, node] of normalized.entries()) {
    const attachment = node.attachment
    if (attachment === null) {
      output.push({
        groupId: '',
        path: node.path,
        attachmentKind: null,
        cachedRepoId: null,
        ref: '',
        subdir: '',
        childGroupId: null,
        readonly: false,
      })
      continue
    }
    if (attachment.kind === 'group') {
      if (!snapshot.groups.some((group) => group.id === attachment.childGroupId)) {
        throw new ValidationError(
          'repo-group-member-not-found',
          `referenced repo group ${attachment.childGroupId} not found`,
          { nodePath: node.path, childGroupId: attachment.childGroupId },
        )
      }
      output.push({
        groupId: '',
        path: node.path,
        attachmentKind: 'group',
        cachedRepoId: null,
        ref: '',
        subdir: '',
        childGroupId: attachment.childGroupId,
        readonly: attachment.readonly,
      })
      continue
    }

    let cachedRepoId = attachment.cachedRepoId ?? null
    if (cachedRepoId === null) {
      if (deps.cache === undefined) {
        throw new ValidationError(
          'repo-group-url-import-unavailable',
          'cannot import a repo URL in this context; pass cachedRepoId instead',
          { nodePath: node.path, nodeIndex: index },
        )
      }
      const resolved = await resolveCachedRepo(deps.cache, { url: attachment.repoUrl! })
      cachedRepoId = resolved.cached.id
    } else {
      if (!snapshot.repoUrls.has(cachedRepoId)) {
        throw new ValidationError(
          'repo-group-member-not-found',
          `referenced cached repo ${cachedRepoId} not found`,
          { nodePath: node.path, cachedRepoId },
        )
      }
    }
    let subdir = ''
    if (attachment.subdir !== '') {
      try {
        subdir = normalizeMountPath(attachment.subdir)
      } catch (error) {
        if (error instanceof RepoGroupLayoutError) {
          throw new ValidationError(error.code, `subdir: ${error.message}`, {
            ...error.detail,
            nodePath: node.path,
            field: 'subdir',
          })
        }
        throw error
      }
    }
    output.push({
      groupId: '',
      path: node.path,
      attachmentKind: 'repo',
      cachedRepoId,
      ref: attachment.ref,
      subdir,
      childGroupId: null,
      readonly: attachment.readonly,
    })
  }
  return output
}

function assertFlattenable(
  snapshot: RepositoryGroupSnapshot,
  groupId: string,
  requireRepo: boolean,
): void {
  const all = loadAllGroups(snapshot)
  try {
    const result = flattenRepoGroup(groupId, (id) => all.get(id))
    if (requireRepo && result.repos.length === 0) {
      throw new ValidationError(
        'repo-group-empty',
        'a repo group must contain at least one repository attachment',
      )
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error
    asValidation(error)
  }
}

function assertAncestorsStillFlattenable(snapshot: RepositoryGroupSnapshot, groupId: string): void {
  const all = loadAllGroups(snapshot)
  const ancestors = new Set<string>()
  const stack = [groupId]
  while (stack.length > 0) {
    const current = stack.pop()!
    const parents = snapshot.nodes.filter((node) => node.childGroupId === current)
    for (const parent of parents) {
      if (ancestors.has(parent.groupId)) continue
      ancestors.add(parent.groupId)
      stack.push(parent.groupId)
    }
  }
  for (const ancestor of ancestors) {
    try {
      flattenRepoGroup(ancestor, (id) => all.get(id))
    } catch (error) {
      if (error instanceof RepoGroupLayoutError) {
        throw new ValidationError(
          error.code,
          `saving this group would break repo group '${all.get(ancestor)?.name ?? ancestor}': ${error.message}`,
          { ...error.detail, brokenGroupId: ancestor },
        )
      }
      throw error
    }
  }
}

function assertNameFree(snapshot: RepositoryGroupSnapshot, name: string, excludeId?: string): void {
  const folded = name.toLocaleLowerCase()
  if (
    snapshot.groups.some((row) => row.id !== excludeId && row.name.toLocaleLowerCase() === folded)
  ) {
    throw new ConflictError(
      'repo-group-name-conflict',
      `a repo group named '${name}' already exists`,
    )
  }
}

export async function createRepoGroup(
  deps: RepoGroupDeps,
  input: RepoGroupWrite,
  actorUserId: string | null,
): Promise<RepoGroup> {
  const snapshot = await deps.store.readRepositoryGroupSnapshot()
  assertNameFree(snapshot, input.name)
  const nodes = await materializeNodes(deps, snapshot, input)
  const id = ulid()
  const now = (deps.now ?? Date.now)()
  const group: RepositoryGroupRecord = {
    id,
    name: input.name,
    description: input.description,
    version: 1,
    createdByUserId: actorUserId,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 2,
  }
  const groupNodes = nodes.map((node) => ({ ...node, groupId: id }))
  assertFlattenable(
    {
      ...snapshot,
      groups: [...snapshot.groups, group],
      nodes: [...snapshot.nodes, ...groupNodes],
    },
    id,
    true,
  )
  if ((await deps.store.createRepositoryGroup(group, groupNodes)) === 'name-conflict') {
    throw new ConflictError(
      'repo-group-name-conflict',
      `a repo group named '${input.name}' already exists`,
    )
  }
  return await getRepoGroup(deps.store, id)
}

export async function updateRepoGroup(
  deps: RepoGroupDeps,
  id: string,
  input: RepoGroupWrite,
  expectedVersion?: number,
): Promise<RepoGroup> {
  const snapshot = await deps.store.readRepositoryGroupSnapshot()
  const existing = snapshot.groups.find((group) => group.id === id)
  if (existing === undefined) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  assertNameFree(snapshot, input.name, id)
  const nodes = await materializeNodes(deps, snapshot, input)
  const selfReference = nodes.find((node) => node.childGroupId === id)
  if (selfReference !== undefined) {
    throw new ValidationError('repo-group-cycle', 'a repo group cannot reference itself', {
      nodePath: selfReference.path,
    })
  }
  const now = (deps.now ?? Date.now)()
  const groupNodes = nodes.map((node) => ({ ...node, groupId: id }))
  const prospective: RepositoryGroupSnapshot = {
    ...snapshot,
    groups: snapshot.groups.map((group) =>
      group.id === id
        ? {
            ...group,
            name: input.name,
            description: input.description,
            version: group.version + 1,
            updatedAt: now,
            schemaVersion: 2,
          }
        : group,
    ),
    nodes: [...snapshot.nodes.filter((node) => node.groupId !== id), ...groupNodes],
  }
  assertFlattenable(prospective, id, true)
  assertAncestorsStillFlattenable(prospective, id)
  const written = await deps.store.updateRepositoryGroup({
    id,
    name: input.name,
    description: input.description,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    expectedGraphVersions: snapshot.groups.map((group) => ({
      id: group.id,
      version: group.version,
    })),
    updatedAt: now,
    nodes: groupNodes,
  })
  if (written.status === 'missing') {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  if (written.status === 'name-conflict') {
    throw new ConflictError(
      'repo-group-name-conflict',
      `a repo group named '${input.name}' already exists`,
    )
  }
  if (written.status === 'stale') {
    throw staleConflictError(
      'repo_group',
      `repo group was modified concurrently (expected version ${expectedVersion}, found ${written.actualVersion})`,
      { expectedVersion, actualVersion: written.actualVersion },
    )
  }
  if (written.status === 'graph-stale') {
    throw staleConflictError(
      'repo_group',
      'repository group graph was modified concurrently; reload and retry',
    )
  }
  return await getRepoGroup(deps.store, id)
}

export interface DeleteRepoGroupResult {
  archivedMemories: number
  detachedReferences: number
  disabledSchedules: number
}

function scheduledPayloadRepoGroupId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const direct = (payload as { repoGroupId?: unknown }).repoGroupId
  if (typeof direct === 'string' && direct.length > 0) return direct
  const body = (payload as { body?: unknown }).body
  if (typeof body === 'object' && body !== null) {
    const nested = (body as { repoGroupId?: unknown }).repoGroupId
    if (typeof nested === 'string' && nested.length > 0) return nested
  }
  return null
}

export async function deleteRepoGroup(
  store: RepositoryWorkspaceStore,
  id: string,
  options: { force?: boolean } = {},
): Promise<DeleteRepoGroupResult> {
  const snapshot = await store.readRepositoryGroupSnapshot()
  if (!snapshot.groups.some((group) => group.id === id)) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  const groupById = new Map(snapshot.groups.map((group) => [group.id, group]))
  const referencing = snapshot.nodes.flatMap((node) => {
    if (node.childGroupId !== id) return []
    const group = groupById.get(node.groupId)
    return group === undefined ? [] : [{ id: group.id, name: group.name }]
  })
  const uniqueRefs = [...new Map(referencing.map((row) => [row.id, row])).values()]
  const refSchedules = snapshot.schedules
    .filter((row) => row.enabled && row.launchPayload.includes(`"repoGroupId":"${id}"`))
    .filter((row) => {
      try {
        return scheduledPayloadRepoGroupId(JSON.parse(row.launchPayload)) === id
      } catch {
        return false
      }
    })
    .map((row) => ({ id: row.id, name: row.name }))
  if ((uniqueRefs.length > 0 || refSchedules.length > 0) && options.force !== true) {
    throw new RepoGroupHasReferencesError(uniqueRefs, refSchedules)
  }

  const deleted = await store.deleteRepositoryGroup({
    id,
    scheduleIds: refSchedules.map((row) => row.id),
    expectedGraphVersions: snapshot.groups.map((group) => ({
      id: group.id,
      version: group.version,
    })),
  })
  if (deleted.status === 'graph-stale') {
    throw staleConflictError(
      'repo_group',
      'repository group graph was modified concurrently; reload and retry',
    )
  }
  return {
    archivedMemories: deleted.archivedMemories,
    detachedReferences: deleted.detachedReferences,
    disabledSchedules: deleted.disabledSchedules,
  }
}

export async function groupsReferencingRepo(
  store: RepositoryWorkspaceStore,
  cachedRepoId: string,
): Promise<Array<{ id: string; name: string }>> {
  return [...(await store.groupsReferencingRepo(cachedRepoId))]
}

/** Force-delete a cached repo by detaching it while preserving its directory node/subtree. */
export async function detachRepoFromAllGroups(
  store: RepositoryWorkspaceStore,
  cachedRepoId: string,
): Promise<number> {
  return await store.detachRepoFromAllGroups(cachedRepoId)
}
