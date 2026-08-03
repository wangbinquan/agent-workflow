// RFC-249 — 仓库组目录树 CRUD、展平、预览与引用守卫。
// DB 的唯一事实源是 repo_group_nodes；members 只作为内部/只读兼容投影存在。

import type {
  CreateRepoGroup,
  FlattenableAttachment,
  FlattenableGroup,
  FlattenableNode,
  LegacyRepoGroupWrite,
  PlannedDirectoryNode,
  PlannedRepo,
  RepoGroup,
  RepoGroupLayoutResponse,
  RepoGroupMember,
  RepoGroupMemberInput,
  RepoGroupNode,
  RepoGroupNodeInput,
} from '@agent-workflow/shared'
import {
  RepoGroupLayoutError,
  flattenRepoGroup,
  normalizeMountPath,
  normalizeRepoNodePath,
  parentNodePath,
  redactGitUrl,
  validateRepoGroupNodes,
} from '@agent-workflow/shared'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { cachedRepos, memories, repoGroupNodes, repoGroups, scheduledTasks } from '@/db/schema'
import { resolveCachedRepo, type GitRepoCacheDeps } from '@/services/gitRepoCache'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'

export interface RepoGroupDeps {
  db: DbClient
  cache?: GitRepoCacheDeps
  now?: () => number
}

const ARCHIVABLE_STATUSES = ['candidate', 'approved', 'superseded', 'rejected'] as const

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

interface RawGroupRow {
  id: string
  name: string
  description: string
  version: number
  createdByUserId: string | null
  createdAt: number
  updatedAt: number
  schemaVersion: number
}

interface RawNodeRow {
  groupId: string
  path: string
  attachmentKind: 'repo' | 'group' | null
  cachedRepoId: string | null
  ref: string
  subdir: string
  childGroupId: string | null
  readonly: boolean
}

type RepoGroupWrite = CreateRepoGroup | LegacyRepoGroupWrite
type RepoGroupPreviewWrite =
  | { name?: string; nodes: readonly RepoGroupNodeInput[] }
  | { name?: string; members: readonly RepoGroupMemberInput[] }

function asValidation(error: unknown): never {
  if (error instanceof RepoGroupLayoutError) {
    throw new ValidationError(error.code, error.message, error.detail)
  }
  throw error
}

function legacyInputToNodes(members: readonly RepoGroupMemberInput[]): RepoGroupNodeInput[] {
  const byPath = new Map<string, RepoGroupNodeInput>()
  const ensure = (path: string): RepoGroupNodeInput => {
    const normalized = normalizeRepoNodePath(path)
    const folded = normalized.toLowerCase()
    const existing = byPath.get(folded)
    if (existing !== undefined) return existing
    const parent = parentNodePath(normalized)
    if (parent !== null) ensure(parent)
    const node: RepoGroupNodeInput = { path: normalized, attachment: null }
    byPath.set(folded, node)
    return node
  }
  ensure('')
  for (const member of members) {
    const node = ensure(member.mountPath)
    if (node.attachment !== null) {
      throw new ValidationError(
        'mount-path-duplicate',
        `duplicate mount path: ${member.mountPath || '<root>'}`,
        { mountPath: member.mountPath },
      )
    }
    node.attachment =
      member.kind === 'repo'
        ? {
            kind: 'repo',
            ...(member.cachedRepoId !== undefined
              ? { cachedRepoId: member.cachedRepoId }
              : { repoUrl: member.repoUrl! }),
            ref: member.ref,
            subdir: member.subdir,
            readonly: member.readonly,
          }
        : {
            kind: 'group',
            childGroupId: member.childGroupId,
            readonly: member.readonly,
          }
  }
  return [...byPath.values()]
}

function writeNodes(input: RepoGroupWrite | RepoGroupPreviewWrite): readonly RepoGroupNodeInput[] {
  return 'nodes' in input ? input.nodes : legacyInputToNodes(input.members)
}

function loadAllGroups(db: DbClient): Map<string, FlattenableGroup> {
  const groups = db.select().from(repoGroups).all() as RawGroupRow[]
  const nodes = db
    .select()
    .from(repoGroupNodes)
    .orderBy(repoGroupNodes.groupId, repoGroupNodes.path)
    .all() as RawNodeRow[]
  const repoUrlById = new Map(
    (
      db
        .select({ id: cachedRepos.id, url: cachedRepos.url, urlRedacted: cachedRepos.urlRedacted })
        .from(cachedRepos)
        .all() as Array<{ id: string; url: string; urlRedacted: string | null }>
    ).map((row) => [row.id, row.urlRedacted ?? redactGitUrl(row.url)]),
  )

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

export function resolveRepoGroupLayout(
  db: DbClient,
  groupId: string,
): {
  repos: PlannedRepo[]
  nodes: PlannedDirectoryNode[]
  maxDepth: number
  groupName: string
} {
  const all = loadAllGroups(db)
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

export function previewRepoGroupLayout(
  db: DbClient,
  input: RepoGroupPreviewWrite,
): RepoGroupLayoutResponse & { pendingImports: number; pendingRepoPaths: string[] } {
  const all = loadAllGroups(db)
  const urlById = new Map(
    (
      db
        .select({ id: cachedRepos.id, url: cachedRepos.url, urlRedacted: cachedRepos.urlRedacted })
        .from(cachedRepos)
        .all() as Array<{ id: string; url: string; urlRedacted: string | null }>
    ).map((row) => [row.id, row.urlRedacted ?? redactGitUrl(row.url)]),
  )

  let normalized: Array<{ path: string; attachment: RepoGroupNodeInput['attachment'] }>
  try {
    normalized = validateRepoGroupNodes(writeNodes(input))
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

export function getRepoGroupLayoutResponse(db: DbClient, groupId: string): RepoGroupLayoutResponse {
  const { repos, nodes, maxDepth, groupName } = resolveRepoGroupLayout(db, groupId)
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

function boundMemoryCount(db: DbClient, groupId: string): number {
  const rows = db
    .select({ n: sql<number>`count(*)` })
    .from(memories)
    .where(
      and(
        eq(memories.scopeType, 'repo_group'),
        eq(memories.scopeId, groupId),
        inArray(memories.status, ARCHIVABLE_STATUSES),
      ),
    )
    .all()
  return Number(rows[0]?.n ?? 0)
}

function toDto(db: DbClient, row: RawGroupRow, all: Map<string, FlattenableGroup>): RepoGroup {
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
  const members: RepoGroupMember[] = []
  for (const node of nodes) {
    const attachment = node.attachment
    if (attachment === null) continue
    const memberIndex = members.length
    if (attachment.kind === 'repo') {
      members.push({
        kind: 'repo',
        memberIndex,
        cachedRepoId: attachment.cachedRepoId,
        repoUrlRedacted: attachment.repoUrlRedacted,
        ref: attachment.ref,
        subdir: attachment.subdir,
        mountPath: node.path,
        readonly: attachment.readonly,
      })
    } else {
      members.push({
        kind: 'group',
        memberIndex,
        childGroupId: attachment.childGroupId,
        childGroupName: attachment.childGroupName,
        mountPath: node.path,
        readonly: attachment.readonly,
      })
    }
  }

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
    members,
    directNodeCount: nodes.length,
    flatRepoCount,
    boundMemories: boundMemoryCount(db, row.id),
  }
}

export function listRepoGroups(db: DbClient): RepoGroup[] {
  const all = loadAllGroups(db)
  const rows = db.select().from(repoGroups).all() as RawGroupRow[]
  return rows.sort((a, b) => a.name.localeCompare(b.name)).map((row) => toDto(db, row, all))
}

export function getRepoGroup(db: DbClient, id: string): RepoGroup {
  const row = db.select().from(repoGroups).where(eq(repoGroups.id, id)).limit(1).all()[0] as
    | RawGroupRow
    | undefined
  if (row === undefined) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  return toDto(db, row, loadAllGroups(db))
}

async function materializeNodes(deps: RepoGroupDeps, input: RepoGroupWrite): Promise<RawNodeRow[]> {
  let normalized: Array<{ path: string; attachment: RepoGroupNodeInput['attachment'] }>
  try {
    normalized = validateRepoGroupNodes(writeNodes(input))
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
      const exists = deps.db
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(eq(repoGroups.id, attachment.childGroupId))
        .limit(1)
        .all()
      if (exists.length === 0) {
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
      const exists = deps.db
        .select({ id: cachedRepos.id })
        .from(cachedRepos)
        .where(eq(cachedRepos.id, cachedRepoId))
        .limit(1)
        .all()
      if (exists.length === 0) {
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

function assertFlattenable(db: DbClient, groupId: string, requireRepo: boolean): void {
  const all = loadAllGroups(db)
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

function assertAncestorsStillFlattenable(db: DbClient, groupId: string): void {
  const all = loadAllGroups(db)
  const ancestors = new Set<string>()
  const stack = [groupId]
  while (stack.length > 0) {
    const current = stack.pop()!
    const parents = db
      .select({ groupId: repoGroupNodes.groupId })
      .from(repoGroupNodes)
      .where(eq(repoGroupNodes.childGroupId, current))
      .all()
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

function assertNameFree(db: DbClient, name: string, excludeId?: string): void {
  const rows = db
    .select({ id: repoGroups.id })
    .from(repoGroups)
    .where(sql`lower(${repoGroups.name}) = lower(${name})`)
    .all()
  if (rows.some((row) => row.id !== excludeId)) {
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
  assertNameFree(deps.db, input.name)
  const nodes = await materializeNodes(deps, input)
  const id = ulid()
  const now = (deps.now ?? Date.now)()
  dbTxSync(deps.db, (tx) => {
    assertNameFree(tx as unknown as DbClient, input.name)
    tx.insert(repoGroups)
      .values({
        id,
        name: input.name,
        description: input.description,
        version: 1,
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
        schemaVersion: 2,
      })
      .run()
    for (const node of nodes)
      tx.insert(repoGroupNodes)
        .values({ ...node, groupId: id })
        .run()
    assertFlattenable(tx as unknown as DbClient, id, true)
  })
  return getRepoGroup(deps.db, id)
}

export async function updateRepoGroup(
  deps: RepoGroupDeps,
  id: string,
  input: RepoGroupWrite,
  expectedVersion?: number,
): Promise<RepoGroup> {
  const existing = deps.db
    .select({ id: repoGroups.id })
    .from(repoGroups)
    .where(eq(repoGroups.id, id))
    .limit(1)
    .all()
  if (existing.length === 0) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  assertNameFree(deps.db, input.name, id)
  const nodes = await materializeNodes(deps, input)
  const selfReference = nodes.find((node) => node.childGroupId === id)
  if (selfReference !== undefined) {
    throw new ValidationError('repo-group-cycle', 'a repo group cannot reference itself', {
      nodePath: selfReference.path,
    })
  }
  const now = (deps.now ?? Date.now)()
  dbTxSync(deps.db, (tx) => {
    const fresh = tx
      .select({ version: repoGroups.version })
      .from(repoGroups)
      .where(eq(repoGroups.id, id))
      .limit(1)
      .all()[0]
    if (fresh === undefined) {
      throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
    }
    if (expectedVersion !== undefined && fresh.version !== expectedVersion) {
      throw new ConflictError(
        'repo-group-version-conflict',
        `repo group was modified concurrently (expected version ${expectedVersion}, found ${fresh.version})`,
        { expectedVersion, actualVersion: fresh.version },
      )
    }
    tx.delete(repoGroupNodes).where(eq(repoGroupNodes.groupId, id)).run()
    for (const node of nodes)
      tx.insert(repoGroupNodes)
        .values({ ...node, groupId: id })
        .run()
    tx.update(repoGroups)
      .set({
        name: input.name,
        description: input.description,
        version: fresh.version + 1,
        updatedAt: now,
        schemaVersion: 2,
      })
      .where(eq(repoGroups.id, id))
      .run()
    assertFlattenable(tx as unknown as DbClient, id, true)
    assertAncestorsStillFlattenable(tx as unknown as DbClient, id)
  })
  return getRepoGroup(deps.db, id)
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

export function deleteRepoGroup(
  db: DbClient,
  id: string,
  options: { force?: boolean } = {},
): DeleteRepoGroupResult {
  const rows = db.select().from(repoGroups).where(eq(repoGroups.id, id)).limit(1).all()
  if (rows.length === 0) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  const referencing = db
    .select({ id: repoGroups.id, name: repoGroups.name })
    .from(repoGroupNodes)
    .innerJoin(repoGroups, eq(repoGroups.id, repoGroupNodes.groupId))
    .where(eq(repoGroupNodes.childGroupId, id))
    .all()
  const uniqueRefs = [...new Map(referencing.map((row) => [row.id, row])).values()]
  const scheduleCandidates = db
    .select({
      id: scheduledTasks.id,
      name: scheduledTasks.name,
      payload: scheduledTasks.launchPayload,
    })
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.enabled, true),
        like(scheduledTasks.launchPayload, `%"repoGroupId":"${id}"%`),
      ),
    )
    .all()
  const refSchedules = scheduleCandidates
    .filter((row) => {
      try {
        return scheduledPayloadRepoGroupId(JSON.parse(row.payload)) === id
      } catch {
        return false
      }
    })
    .map((row) => ({ id: row.id, name: row.name }))
  if ((uniqueRefs.length > 0 || refSchedules.length > 0) && options.force !== true) {
    throw new RepoGroupHasReferencesError(uniqueRefs, refSchedules)
  }

  let archivedMemories = 0
  let detachedReferences = 0
  let disabledSchedules = 0
  dbTxSync(db, (tx) => {
    const bound = tx
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.scopeType, 'repo_group'),
          eq(memories.scopeId, id),
          inArray(memories.status, ARCHIVABLE_STATUSES),
        ),
      )
      .all()
    if (bound.length > 0) {
      tx.update(memories)
        .set({ status: 'archived' })
        .where(
          inArray(
            memories.id,
            bound.map((row) => row.id),
          ),
        )
        .run()
      archivedMemories = bound.length
    }
    const refs = tx
      .select({ groupId: repoGroupNodes.groupId })
      .from(repoGroupNodes)
      .where(eq(repoGroupNodes.childGroupId, id))
      .all()
    detachedReferences = refs.length
    if (refs.length > 0) {
      tx.update(repoGroupNodes)
        .set({
          attachmentKind: null,
          cachedRepoId: null,
          childGroupId: null,
          ref: '',
          subdir: '',
          readonly: false,
        })
        .where(eq(repoGroupNodes.childGroupId, id))
        .run()
    }
    if (refSchedules.length > 0) {
      tx.update(scheduledTasks)
        .set({
          enabled: false,
          nextRunAt: null,
          lastError: `repo group ${id} was deleted; re-point this schedule before re-enabling`,
        })
        .where(
          inArray(
            scheduledTasks.id,
            refSchedules.map((row) => row.id),
          ),
        )
        .run()
      disabledSchedules = refSchedules.length
    }
    tx.delete(repoGroups).where(eq(repoGroups.id, id)).run()
  })
  return { archivedMemories, detachedReferences, disabledSchedules }
}

export function groupsReferencingRepo(
  db: DbClient,
  cachedRepoId: string,
): Array<{ id: string; name: string }> {
  const rows = db
    .select({ id: repoGroups.id, name: repoGroups.name })
    .from(repoGroupNodes)
    .innerJoin(repoGroups, eq(repoGroups.id, repoGroupNodes.groupId))
    .where(eq(repoGroupNodes.cachedRepoId, cachedRepoId))
    .all()
  return [...new Map(rows.map((row) => [row.id, row])).values()]
}

/** Force-delete a cached repo by detaching it while preserving its directory node/subtree. */
export function detachRepoFromAllGroups(db: DbClient, cachedRepoId: string): number {
  const rows = db
    .select({ groupId: repoGroupNodes.groupId })
    .from(repoGroupNodes)
    .where(eq(repoGroupNodes.cachedRepoId, cachedRepoId))
    .all()
  if (rows.length > 0) {
    db.update(repoGroupNodes)
      .set({
        attachmentKind: null,
        cachedRepoId: null,
        childGroupId: null,
        ref: '',
        subdir: '',
        readonly: false,
      })
      .where(eq(repoGroupNodes.cachedRepoId, cachedRepoId))
      .run()
  }
  return rows.length
}
