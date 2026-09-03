import { and, desc, eq, getTableColumns, ilike, inArray, or } from 'drizzle-orm'
import { ulid } from 'ulid'
import type {
  Memory,
  MemoryListFilter,
  MemoryPatchField,
  MemoryStatus,
  MemorySummary,
  MemoryWsMessage,
} from '@agent-workflow/shared'
import {
  MemoryMoveRequestSchema,
  MemoryPatchRequestSchema,
  MemorySchema,
  matchesTagFilter,
  normalizeStoredAdditionalPermissions,
} from '@agent-workflow/shared'

import { buildActor, type Actor, type ActorSource } from '@/auth/actor'
import type { ResourceAccess } from '@agent-workflow/shared'
import { createRepositoryScopeAuthorizationInTx } from '@/modules/source-control/application/repositoryScopeAuthorization'
import { postgresqlRepositoryScopeExistenceReads } from '@/modules/source-control/infrastructure/repositoryScopeAuthorization'
import type {
  RepositoryScopeAuthorizationInTx,
  RepositoryScopeTarget,
} from '@/modules/source-control/public/participants'
import {
  memories,
  memoryDistillJobs,
  memoryScopeMoveEvents,
  userPermissionGrants,
  users,
} from '@/db/schema'
import type {
  AuthenticatedPrincipal,
  DirectCommandContextFactory,
  PrincipalSource,
} from '@/modules/identity-access/public/participants'
import { hasResourceAclBypass } from '@/modules/resource-catalog/domain/resourceAccess'
import {
  decideMemoryRowManageStamp,
  decideMemoryScopeManage,
  decideMemoryScopeView,
  memoryScopeNeedsResourceAccess,
  type MemoryScopeAuthorizationFacts,
  type MemoryScopeKind,
} from '../domain/scopeAuthorization'
import type { ResourceMemoryScopeRef } from '@/modules/resource-catalog/public/types'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { MEMORY_CHANNEL, memoryBroadcaster } from '@/ws/broadcaster'
import type { MemoryResourceScopeAccessParticipant } from '../application/ports/resourceScopeAccess'
import type {
  MemoryCatalogCommands,
  MemoryCatalogOperations,
  MemoryCatalogQueries,
  MemoryScopeAuthority,
  MemoryScopeRef,
  MemoryWithChain,
  MoveMemoryResult,
  PatchMemoryResult,
} from '../public/catalog'

export type PostgresqlMemoryTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]
type PostgresqlTransaction = PostgresqlMemoryTransaction
type MemoryRow = typeof memories.$inferSelect

const SUMMARY_COLUMNS = Object.fromEntries(
  Object.entries(getTableColumns(memories)).filter(([key]) => key !== 'bodyMd'),
) as Omit<ReturnType<typeof getTableColumns<typeof memories>>, 'bodyMd'>

function parseTags(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw)
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function rowToMemory(row: MemoryRow): Memory {
  return MemorySchema.parse({
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    bodyMd: row.bodyMd,
    tags: parseTags(row.tags),
    status: row.status,
    sourceKind: row.sourceKind,
    sourceEventId: row.sourceEventId,
    sourceTaskId: row.sourceTaskId,
    distillJobId: row.distillJobId,
    distillAction: row.distillAction,
    supersedesId: row.supersedesId,
    supersededById: row.supersededById,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    createdAt: row.createdAt,
    version: row.version,
    fusedIntoSkill: row.fusedIntoSkill,
    fusedIntoSkillId: row.fusedIntoSkillId,
    fusedIntoSkillVersion: row.fusedIntoSkillVersion,
    fusedAt: row.fusedAt,
    fusedByUserId: row.fusedByUserId,
  })
}

function summaryOf(
  row: Omit<MemoryRow, 'bodyMd'>,
  outputLang: 'zh-CN' | 'en-US' | null,
): MemorySummary {
  return {
    id: row.id,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    title: row.title,
    status: row.status,
    tags: parseTags(row.tags),
    approvedAt: row.approvedAt,
    version: row.version,
    distillAction: row.distillAction,
    fusedIntoSkill: row.fusedIntoSkill,
    fusedIntoSkillId: row.fusedIntoSkillId,
    fusedIntoSkillVersion: row.fusedIntoSkillVersion,
    outputLang: row.status === 'candidate' ? outputLang : null,
  }
}

function summaryFromMemory(memory: Memory): MemorySummary {
  return {
    id: memory.id,
    scopeType: memory.scopeType,
    scopeId: memory.scopeId,
    title: memory.title,
    status: memory.status,
    tags: memory.tags,
    approvedAt: memory.approvedAt,
    version: memory.version,
    distillAction: memory.distillAction,
    fusedIntoSkill: memory.fusedIntoSkill ?? null,
    fusedIntoSkillId: memory.fusedIntoSkillId ?? null,
    fusedIntoSkillVersion: memory.fusedIntoSkillVersion ?? null,
    outputLang: null,
  }
}

function publish(message: MemoryWsMessage): void {
  memoryBroadcaster.broadcast(MEMORY_CHANNEL, message)
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((value, index) => value === b[index])
}

function actorSourceOf(source: PrincipalSource): ActorSource {
  return source === 'session' || source === 'pat' || source === 'daemon' ? source : 'daemon'
}

async function currentActor(
  tx: PostgresqlTransaction,
  principal: AuthenticatedPrincipal,
): Promise<Actor> {
  const accountRows = await tx
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      status: users.status,
      accessRevision: users.accessRevision,
    })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1)
    .all()
  const account = accountRows[0]
  if (account === undefined || account.status !== 'active') {
    throw new UnauthorizedError('request authority is no longer active')
  }
  const grants = await tx
    .select({ permission: userPermissionGrants.permission })
    .from(userPermissionGrants)
    .where(eq(userPermissionGrants.userId, account.id))
    .all()
  const additionalPermissions = normalizeStoredAdditionalPermissions({
    role: account.role,
    additionalPermissions: grants.map((row) => row.permission),
  }).additionalPermissions
  const source = actorSourceOf(principal.source)
  return buildActor({
    user: account,
    source,
    additionalPermissions,
    ...(source === 'pat' ? { patScopes: ['memory:update' as const] } : {}),
    authorityRevision: account.accessRevision,
  })
}

function resourceScope(scope: MemoryScopeRef): ResourceMemoryScopeRef | null {
  if (
    (scope.scopeType !== 'agent' && scope.scopeType !== 'workflow') ||
    scope.scopeId === null ||
    scope.scopeId === ''
  ) {
    return null
  }
  return { kind: scope.scopeType, id: scope.scopeId }
}

async function accessOf(
  participant: MemoryResourceScopeAccessParticipant<PostgresqlTransaction>,
  tx: PostgresqlTransaction,
  authority: MemoryScopeAuthority,
  scope: MemoryScopeRef,
) {
  const ref = resourceScope(scope)
  return ref === null ? 'none' : await participant.accessOf(tx, authority, ref)
}

async function assertManageable(input: {
  readonly participant: MemoryResourceScopeAccessParticipant<PostgresqlTransaction>
  readonly repositories: RepositoryScopeAuthorizationInTx<PostgresqlTransaction>
  readonly tx: PostgresqlTransaction
  readonly authority: MemoryScopeAuthority
  readonly scope: MemoryScopeRef
  readonly side: 'current' | 'destination'
}): Promise<void> {
  if (input.scope.scopeType === 'global') {
    if (hasResourceAclBypass(input.authority.actor)) return
    throw new ForbiddenError(
      'memory-scope-forbidden',
      `${input.side} global memory scope requires resource-acl:bypass`,
    )
  }
  if (input.scope.scopeId === null || input.scope.scopeId === '') {
    throw new ValidationError('invalid-body', `${input.scope.scopeType} scope requires scopeId`)
  }
  if (input.scope.scopeType === 'repo' || input.scope.scopeType === 'repo_group') {
    // RFC-352 T4：与 SQLite 侧同一条路——存在性与管理权由 source-control 的 offered
    // participant 回答，memory 不再直读 `cachedRepos` / `repoGroups`。
    const target: RepositoryScopeTarget = {
      kind: input.scope.scopeType,
      id: input.scope.scopeId,
    }
    const exists = await input.repositories.exists(input.tx, target)
    if (!exists && !(input.side === 'current' && hasResourceAclBypass(input.authority.actor))) {
      throw new NotFoundError(
        'memory-scope-target-not-found',
        `${input.side} ${input.scope.scopeType} scope target not found`,
      )
    }
    if (
      await input.repositories.canManage(
        input.tx,
        { hasResourceAclBypass: hasResourceAclBypass(input.authority.actor) },
        target,
      )
    ) {
      return
    }
    throw new ForbiddenError(
      'memory-scope-forbidden',
      `${input.side} ${input.scope.scopeType} memory scope requires resource-acl:bypass`,
    )
  }
  const access = await accessOf(input.participant, input.tx, input.authority, input.scope)
  if (access === 'none') {
    if (input.side === 'current' && hasResourceAclBypass(input.authority.actor)) return
    throw new NotFoundError(
      'memory-scope-target-not-found',
      `${input.side} ${input.scope.scopeType} scope target not found`,
    )
  }
  if (access !== 'write' && access !== 'own') {
    throw new ForbiddenError(
      'memory-scope-forbidden',
      `request authority cannot manage the ${input.side} ${input.scope.scopeType} scope`,
    )
  }
}

export function composePostgresqlMemoryCatalogOperations(input: {
  readonly db: PostgresqlDatabaseClient
  readonly contexts: DirectCommandContextFactory
  readonly authorization: MemoryResourceScopeAccessParticipant<PostgresqlTransaction>
}): MemoryCatalogOperations {
  /**
   * 取一条 scope 的授权事实。平台 scope 不查资源访问档（查了也用不上），
   * 与 SQLite 侧保持相同的查询次数。判定本身在 `domain/scopeAuthorization.ts`。
   */
  // RFC-352 T4：source-control 的 repository/group scope 授权 participant，装配一次。
  const repositoryScopes = createRepositoryScopeAuthorizationInTx(
    postgresqlRepositoryScopeExistenceReads,
  )

  const readScopeAuthorizationFacts = async (
    authority: MemoryScopeAuthority,
    scope: MemoryScopeRef,
  ): Promise<MemoryScopeAuthorizationFacts> => {
    const hasAclBypass = hasResourceAclBypass(authority.actor)
    const scopeType = scope.scopeType as MemoryScopeKind
    if (hasAclBypass || !memoryScopeNeedsResourceAccess(scopeType)) {
      return { hasAclBypass, scopeType, resourceAccess: null }
    }
    const resourceAccess = await input.db.transaction(
      async (tx) => await accessOf(input.authorization, tx, authority, scope),
    )
    return { hasAclBypass, scopeType, resourceAccess }
  }

  const loadJobLanguages = async (ids: readonly string[]) => {
    const languages = new Map<string, 'zh-CN' | 'en-US' | null>()
    if (ids.length === 0) return languages
    const rows = await input.db
      .select({ id: memoryDistillJobs.id, outputLang: memoryDistillJobs.outputLang })
      .from(memoryDistillJobs)
      .where(inArray(memoryDistillJobs.id, [...ids]))
      .all()
    for (const row of rows) {
      languages.set(
        row.id,
        row.outputLang === 'zh-CN' || row.outputLang === 'en-US' ? row.outputLang : null,
      )
    }
    return languages
  }

  const listRows = async (filter: MemoryListFilter = {}) => {
    const conditions = []
    if (filter.status !== undefined) conditions.push(eq(memories.status, filter.status))
    if (filter.scopeType !== undefined) conditions.push(eq(memories.scopeType, filter.scopeType))
    if (filter.scopeId !== undefined) conditions.push(eq(memories.scopeId, filter.scopeId))
    if (filter.search !== undefined) {
      const term = `%${filter.search}%`
      conditions.push(or(ilike(memories.title, term), ilike(memories.bodyMd, term))!)
    }
    const where = conditions.length === 0 ? undefined : and(...conditions)
    const rows = await (where === undefined
      ? input.db.select(SUMMARY_COLUMNS).from(memories).orderBy(desc(memories.createdAt)).all()
      : input.db
          .select(SUMMARY_COLUMNS)
          .from(memories)
          .where(where)
          .orderBy(desc(memories.createdAt))
          .all())
    const kept = rows.filter((row) => matchesTagFilter(parseTags(row.tags), filter))
    const jobIds = kept.flatMap((row) =>
      row.status === 'candidate' && row.distillJobId !== null ? [row.distillJobId] : [],
    )
    const languages = await loadJobLanguages(jobIds)
    return kept.map((row) =>
      summaryOf(row, row.distillJobId === null ? null : (languages.get(row.distillJobId) ?? null)),
    )
  }

  const getById = async (id: string): Promise<MemoryWithChain | null> => {
    const rows = await input.db.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    const first = rows[0]
    if (first === undefined) return null
    const memory = rowToMemory(first)
    const ancestors: Memory[] = []
    const seen = new Set([memory.id])
    let cursor = memory.supersedesId
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor)
      const parentRows = await input.db
        .select()
        .from(memories)
        .where(eq(memories.id, cursor))
        .limit(1)
        .all()
      const parent = parentRows[0]
      if (parent === undefined) break
      const parsed = rowToMemory(parent)
      ancestors.push(parsed)
      cursor = parsed.supersedesId
    }
    return { memory, ancestors }
  }

  const queries: MemoryCatalogQueries = {
    list: listRows,
    async listWithBody(filter = {}) {
      const conditions = []
      if (filter.status !== undefined) conditions.push(eq(memories.status, filter.status))
      if (filter.scopeType !== undefined) conditions.push(eq(memories.scopeType, filter.scopeType))
      if (filter.scopeId !== undefined) conditions.push(eq(memories.scopeId, filter.scopeId))
      if (filter.search !== undefined) {
        const term = `%${filter.search}%`
        conditions.push(or(ilike(memories.title, term), ilike(memories.bodyMd, term))!)
      }
      const where = conditions.length === 0 ? undefined : and(...conditions)
      const rows = await (where === undefined
        ? input.db.select().from(memories).orderBy(desc(memories.createdAt)).all()
        : input.db.select().from(memories).where(where).orderBy(desc(memories.createdAt)).all())
      return rows.map(rowToMemory).filter((memory) => matchesTagFilter(memory.tags, filter))
    },
    getById,
    // RFC-352：判据住在 `domain/scopeAuthorization.ts`，与 SQLite 侧共用同一份。
    // 此前两个 provider 各写一遍同样的级联，只改一边就是判据漂移——用户看到的权限
    // 会取决于部署选了哪个数据库。这里只负责取事实。
    async canView(authority, scope) {
      return decideMemoryScopeView(await readScopeAuthorizationFacts(authority, scope))
    },
    async canManage(authority, scope) {
      return decideMemoryScopeManage(await readScopeAuthorizationFacts(authority, scope))
    },
    async filterVisible<T extends MemoryScopeRef>(
      authority: MemoryScopeAuthority,
      rows: readonly T[],
    ) {
      if (hasResourceAclBypass(authority.actor)) return [...rows]
      return await input.db.transaction(async (tx) => {
        const access = new Map<string, string>()
        for (const row of rows) {
          const ref = resourceScope(row)
          if (ref === null) continue
          const key = `${ref.kind}:${ref.id}`
          if (!access.has(key))
            access.set(key, await input.authorization.accessOf(tx, authority, ref))
        }
        return rows.filter((row) =>
          decideMemoryScopeView({
            hasAclBypass: false,
            scopeType: row.scopeType as MemoryScopeKind,
            resourceAccess:
              row.scopeId === null
                ? null
                : ((access.get(`${row.scopeType}:${row.scopeId}`) as ResourceAccess | undefined) ??
                  null),
          }),
        )
      })
    },
    async annotateManageRights<T extends MemoryScopeRef>(
      authority: MemoryScopeAuthority,
      rows: readonly T[],
    ) {
      if (hasResourceAclBypass(authority.actor))
        return rows.map((row) => ({ ...row, canManage: true }))
      return await input.db.transaction(async (tx) => {
        const access = new Map<string, string>()
        for (const row of rows) {
          const ref = resourceScope(row)
          if (ref === null) continue
          const key = `${ref.kind}:${ref.id}`
          if (!access.has(key))
            access.set(key, await input.authorization.accessOf(tx, authority, ref))
        }
        return rows.map((row) => ({
          ...row,
          canManage: decideMemoryRowManageStamp({
            hasAclBypass: false,
            scopeType: row.scopeType as MemoryScopeKind,
            resourceAccess:
              row.scopeId === null
                ? null
                : ((access.get(`${row.scopeType}:${row.scopeId}`) as ResourceAccess | undefined) ??
                  null),
          }),
        }))
      })
    },
  }

  const transition = async (
    id: string,
    expected: readonly MemoryStatus[],
    next: MemoryStatus,
    code: string,
  ): Promise<Memory> => {
    const rows = await input.db.select().from(memories).where(eq(memories.id, id)).limit(1).all()
    const row = rows[0]
    if (row === undefined) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
    if (!expected.includes(row.status)) {
      throw new ConflictError(
        code,
        `memory ${id} is in status '${row.status}'; expected one of ${expected.join(', ')}`,
      )
    }
    const changed = await input.db
      .update(memories)
      .set({ status: next })
      .where(and(eq(memories.id, id), eq(memories.status, row.status)))
      .returning()
      .all()
    if (changed[0] === undefined) throw staleConflictError('memory', `memory ${id} changed`)
    return rowToMemory(changed[0])
  }

  const commands: MemoryCatalogCommands = {
    async createManual(command) {
      const memory = MemorySchema.parse({
        id: ulid(),
        scopeType: command.scopeType,
        scopeId: command.scopeId,
        title: command.title,
        bodyMd: command.bodyMd,
        tags: command.tags ?? [],
        status: 'candidate',
        sourceKind: 'manual',
        sourceEventId: null,
        sourceTaskId: null,
        distillJobId: null,
        distillAction: null,
        supersedesId: null,
        supersededById: null,
        approvedByUserId: null,
        approvedAt: null,
        createdAt: Date.now(),
        version: 1,
        fusedIntoSkillId: null,
      })
      await input.db
        .insert(memories)
        .values({
          ...memory,
          tags: JSON.stringify(memory.tags),
          status: 'candidate',
          sourceKind: 'manual',
        })
        .run()
      publish({ type: 'memory.candidate.created', memory: summaryFromMemory(memory) })
      return memory
    },
    async promote(id, command, administratorUserId) {
      const committed = await input.db.transaction(async (tx) => {
        const rows = await tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
        const candidate = rows[0]
        if (candidate === undefined)
          throw new NotFoundError('memory-not-found', `memory ${id} not found`)
        if (candidate.status !== 'candidate') {
          throw new ConflictError(
            'memory-not-candidate',
            `memory ${id} is in status '${candidate.status}', not 'candidate'`,
          )
        }
        if (command.action === 'reject') {
          const rejected = await tx
            .update(memories)
            .set({ status: 'rejected' })
            .where(eq(memories.id, id))
            .returning()
            .all()
          return { memory: rowToMemory(rejected[0]!), supersededIds: [] as string[] }
        }
        const supersededIds = command.action === 'approve_and_supersede' ? command.supersedeIds : []
        const targets =
          supersededIds.length === 0
            ? []
            : await tx.select().from(memories).where(inArray(memories.id, supersededIds)).all()
        if (targets.length !== supersededIds.length) {
          const missing = supersededIds.filter(
            (targetId) => !targets.some((row) => row.id === targetId),
          )
          throw new NotFoundError(
            'supersede-target-not-found',
            `supersede target(s) not found: ${missing.join(', ')}`,
            { missing },
          )
        }
        for (const target of targets) {
          if (target.id === id)
            throw new ValidationError('supersede-self', 'a candidate cannot supersede itself')
          if (target.status !== 'approved')
            throw new ConflictError(
              'supersede-target-not-approved',
              `cannot supersede memory ${target.id} — status is '${target.status}', not 'approved'`,
            )
          if (target.scopeType !== candidate.scopeType || target.scopeId !== candidate.scopeId) {
            throw new ConflictError(
              'supersede-scope-mismatch',
              `cannot supersede memory ${target.id} — scope mismatch`,
            )
          }
        }
        const version =
          targets.reduce((maximum, target) => Math.max(maximum, target.version), 0) + 1
        const approved = await tx
          .update(memories)
          .set({
            status: 'approved',
            approvedByUserId: administratorUserId,
            approvedAt: Date.now(),
            version,
            supersedesId: supersededIds[0] ?? null,
            tags:
              command.tagsOverride === undefined
                ? candidate.tags
                : JSON.stringify(command.tagsOverride),
          })
          .where(eq(memories.id, id))
          .returning()
          .all()
        if (supersededIds.length > 0) {
          await tx
            .update(memories)
            .set({ status: 'superseded', supersededById: id })
            .where(inArray(memories.id, supersededIds))
            .run()
        }
        return { memory: rowToMemory(approved[0]!), supersededIds }
      })
      publish({
        type: 'memory.candidate.promoted',
        memoryId: id,
        newStatus: committed.memory.status === 'rejected' ? 'rejected' : 'approved',
        supersededIds: committed.supersededIds.length === 0 ? undefined : committed.supersededIds,
      })
      for (const oldId of committed.supersededIds)
        publish({ type: 'memory.superseded', oldId, newId: id })
      return committed.memory
    },
    async patch(id, command, editorUserId) {
      const raw = command as Record<string, unknown>
      if ('scopeType' in raw || 'scopeId' in raw) {
        throw new ValidationError(
          'memory-scope-move-required',
          'scopeType and scopeId cannot be changed by generic PATCH; use the move command',
        )
      }
      const parsed = MemoryPatchRequestSchema.safeParse(command)
      if (!parsed.success)
        throw new ValidationError('invalid-body', 'invalid patch request', parsed.error.format())
      const committed = await input.db.transaction(async (tx): Promise<PatchMemoryResult> => {
        const rows = await tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
        const row = rows[0]
        if (row === undefined) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
        if (row.status === 'superseded' || row.status === 'rejected' || row.status === 'fused') {
          throw new ConflictError(
            'memory-terminal-status',
            `memory ${id} is in terminal status '${row.status}'; cannot edit`,
          )
        }
        const title = parsed.data.title ?? row.title
        const bodyMd = parsed.data.bodyMd ?? row.bodyMd
        const tags = parsed.data.tags ?? parseTags(row.tags)
        const validated = MemorySchema.safeParse({ ...rowToMemory(row), title, bodyMd, tags })
        if (!validated.success)
          throw new ValidationError(
            'invalid-body',
            'patch would put the row in an invalid state',
            validated.error.format(),
          )
        const changedFields: MemoryPatchField[] = []
        if (title !== row.title) changedFields.push('title')
        if (bodyMd !== row.bodyMd) changedFields.push('bodyMd')
        if (!sameTags(tags, parseTags(row.tags))) changedFields.push('tags')
        if (changedFields.length === 0) return { memory: rowToMemory(row), changedFields }
        const updated = await tx
          .update(memories)
          .set({ title, bodyMd, tags: JSON.stringify(tags), version: row.version + 1 })
          .where(and(eq(memories.id, id), eq(memories.version, row.version)))
          .returning()
          .all()
        if (updated[0] === undefined)
          throw staleConflictError('memory', `memory ${id} changed; reload and retry`)
        return { memory: rowToMemory(updated[0]), changedFields }
      })
      if (committed.changedFields.length > 0) {
        publish({
          type: 'memory.updated',
          memoryId: id,
          changedFields: [...committed.changedFields],
          version: committed.memory.version,
        })
        console.log(
          `[memory-edited] id=${id} editedBy=${editorUserId ?? 'unknown'} fieldsChanged=${committed.changedFields.join(',')} version=${committed.memory.version}`,
        )
      }
      return committed
    },
    async move(context, id, command): Promise<MoveMemoryResult> {
      const parsed = MemoryMoveRequestSchema.safeParse(command)
      if (!parsed.success)
        throw new ValidationError('invalid-body', 'invalid move request', parsed.error.format())
      const principal = input.contexts.resolveCommandContext(context)
      const committed = await input.db.transaction(async (tx) => {
        const actor = await currentActor(tx, principal)
        const rows = await tx.select().from(memories).where(eq(memories.id, id)).limit(1).all()
        const row = rows[0]
        if (row === undefined) throw new NotFoundError('memory-not-found', `memory ${id} not found`)
        if (row.version !== parsed.data.expectedVersion)
          throw staleConflictError(
            'memory',
            `memory ${id} changed since version ${parsed.data.expectedVersion}; reload and retry`,
            { expectedVersion: parsed.data.expectedVersion, currentVersion: row.version },
          )
        if (row.status !== 'candidate')
          throw new ConflictError(
            'memory-move-status-forbidden',
            `memory ${id} is '${row.status}'; only candidate memories may move scope`,
            { status: row.status },
          )
        const previousScope: MemoryScopeRef = { scopeType: row.scopeType, scopeId: row.scopeId }
        const nextScope: MemoryScopeRef = {
          scopeType: parsed.data.scopeType,
          scopeId: parsed.data.scopeId,
        }
        const authority = { authority: context.authority, actor }
        await assertManageable({
          participant: input.authorization,
          repositories: repositoryScopes,
          tx,
          authority,
          scope: previousScope,
          side: 'current',
        })
        await assertManageable({
          participant: input.authorization,
          repositories: repositoryScopes,
          tx,
          authority,
          scope: nextScope,
          side: 'destination',
        })
        if (
          previousScope.scopeType === nextScope.scopeType &&
          previousScope.scopeId === nextScope.scopeId
        ) {
          return {
            memory: rowToMemory(row),
            moved: false,
            previousScope,
            actorUserId: principal.userId,
          }
        }
        const refreshedActor = await currentActor(tx, principal)
        const refreshedAuthority = { authority: context.authority, actor: refreshedActor }
        await assertManageable({
          participant: input.authorization,
          repositories: repositoryScopes,
          tx,
          authority: refreshedAuthority,
          scope: previousScope,
          side: 'current',
        })
        await assertManageable({
          participant: input.authorization,
          repositories: repositoryScopes,
          tx,
          authority: refreshedAuthority,
          scope: nextScope,
          side: 'destination',
        })
        const updated = await tx
          .update(memories)
          .set({
            scopeType: nextScope.scopeType,
            scopeId: nextScope.scopeId,
            version: row.version + 1,
          })
          .where(and(eq(memories.id, id), eq(memories.version, row.version)))
          .returning()
          .all()
        if (updated[0] === undefined)
          throw staleConflictError('memory', `memory ${id} changed; reload and retry`, {
            expectedVersion: row.version,
          })
        await tx
          .insert(memoryScopeMoveEvents)
          .values({
            id: context.operationId,
            memoryId: id,
            actorUserId: principal.userId,
            actorSource: principal.source,
            fromScopeType: previousScope.scopeType,
            fromScopeId: previousScope.scopeId,
            toScopeType: nextScope.scopeType,
            toScopeId: nextScope.scopeId,
            expectedVersion: row.version,
            resultingVersion: row.version + 1,
            correlationId: context.correlationId,
            causationId: context.causationId ?? null,
            occurredAt: context.now,
          })
          .run()
        return {
          memory: rowToMemory(updated[0]),
          moved: true,
          previousScope,
          actorUserId: principal.userId,
        }
      })
      if (committed.moved) {
        publish({
          type: 'memory.updated',
          memoryId: id,
          changedFields: ['scopeType', 'scopeId'],
          version: committed.memory.version,
        })
        console.log(
          `[memory-moved] id=${id} movedBy=${committed.actorUserId} version=${committed.memory.version} operationId=${context.operationId}`,
        )
      }
      return { memory: committed.memory, moved: committed.moved }
    },
    async archive(id) {
      const memory = await transition(id, ['approved'], 'archived', 'memory-not-approved')
      publish({ type: 'memory.archived', memoryId: id })
      return memory
    },
    async unarchive(id) {
      const memory = await transition(id, ['archived'], 'approved', 'memory-not-archived')
      publish({ type: 'memory.unarchived', memoryId: id })
      return memory
    },
    async delete(id) {
      const deleted = await input.db
        .delete(memories)
        .where(eq(memories.id, id))
        .returning({ id: memories.id })
        .all()
      if (deleted[0] === undefined)
        throw new NotFoundError('memory-not-found', `memory ${id} not found`)
      publish({ type: 'memory.deleted', memoryId: id })
    },
  }

  return Object.freeze({ queries: Object.freeze(queries), commands: Object.freeze(commands) })
}
