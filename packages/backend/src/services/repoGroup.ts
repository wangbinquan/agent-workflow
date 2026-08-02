// RFC-248 — 仓库组的 CRUD + 展平 + 引用守卫。
//
// 布局算法本身**不在这里**：它是无 DB / 无 fs 的纯逻辑，住在
// `@agent-workflow/shared` 的 `repoGroupLayout.ts`，前端布局预览与后端物化共用
// 同一份——两边算出不同结果 = 用户看到的目录和真实跑出来的目录不一样。本模块
// 只负责「把 DB 行喂给那份纯逻辑」和「持久化 / 守卫 / 脱敏」。
//
// 权限模型：仓库组与 cached_repos 同类，**不进** RFC-099 的 owner + visibility
// + grants 体系，能力只由 `repos:*` 权限点治理（D5）。`created_by_user_id`
// 只作审计展示，不参与任何鉴权判定。

import type {
  CreateRepoGroup,
  FlattenableGroup,
  PlannedRepo,
  RepoGroup,
  RepoGroupLayoutResponse,
  RepoGroupMember,
} from '@agent-workflow/shared'
import {
  RepoGroupLayoutError,
  flattenRepoGroup,
  normalizeMountPath,
  redactGitUrl,
} from '@agent-workflow/shared'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { cachedRepos, memories, repoGroupMembers, repoGroups, scheduledTasks } from '@/db/schema'
import { resolveCachedRepo, type GitRepoCacheDeps } from '@/services/gitRepoCache'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'

export interface RepoGroupDeps {
  db: DbClient
  /** 建组时把还没导入的 URL 现场 clone 成 cached_repos 行（D7）。 */
  cache?: GitRepoCacheDeps
  now?: () => number
}

/**
 * 删组时**可以**被改成 `archived` 的记忆状态。
 *
 * `fused` 刻意不在内：0132 的 CHECK 是
 * `(status='fused') = (fused_into_skill IS NOT NULL)`，把一条 fused 行改成
 * archived 会**违反约束并让整个删除事务 500 回滚**——即「组里只要有一条已融合
 * 的记忆就永远删不掉」。fused 本身已是终态且被 `memoryInject` 的
 * `status='approved'` 过滤排除，注入本来就停了，所以不动它是正确的，
 * 只需单独报数让用户知道有几条留在那儿。
 */
const ARCHIVABLE_STATUSES = ['candidate', 'approved', 'superseded', 'rejected'] as const

/** 被别的组引用时删不掉；`force=1` 才摘除引用行。 */
export class RepoGroupHasReferencesError extends DomainError {
  constructor(
    readonly referencingGroups: Array<{ id: string; name: string }>,
    /**
     * RFC-248 H9/#10：**引用本组的启用中定时任务**。漏掉它的后果是删组后留下
     * 一堆反复失败的计划（每次触发都 404），而管理员在计划列表里看不出原因。
     */
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

// ─────────────────────────────────────────────────────────────────────────────
// 读
// ─────────────────────────────────────────────────────────────────────────────

interface RawGroupRow {
  id: string
  name: string
  description: string
  version: number
  createdByUserId: string | null
  createdAt: number
  updatedAt: number
}

interface RawMemberRow {
  groupId: string
  memberIndex: number
  kind: 'repo' | 'group'
  cachedRepoId: string | null
  ref: string
  subdir: string
  childGroupId: string | null
  mountPath: string
  readonly: boolean
}

/**
 * 一次性把**所有**组与成员读进内存，给展平用的 loader。
 *
 * 全量加载而不是按需递归查询：展平要跟着 `child_group_id` 走任意条边，按需查询
 * 在菱形引用下会把同一个组查很多遍，而组的总量是「用户手工建的若干个」这个量级
 * （不是任务级数据），全量读一次反而更简单也更快。
 */
function loadAllGroups(db: DbClient): Map<string, FlattenableGroup> {
  const groups = db.select().from(repoGroups).all() as RawGroupRow[]
  const members = db
    .select()
    .from(repoGroupMembers)
    .orderBy(repoGroupMembers.groupId, repoGroupMembers.memberIndex)
    .all() as RawMemberRow[]
  const repoUrlById = new Map(
    (
      db
        .select({ id: cachedRepos.id, url: cachedRepos.url, urlRedacted: cachedRepos.urlRedacted })
        .from(cachedRepos)
        .all() as Array<{ id: string; url: string; urlRedacted: string | null }>
    ).map((r) => [
      r.id,
      // RFC-204: 出网只给脱敏形态。`url_redacted` 是封存后写入的；封存前的
      // 存量行还留着明文 `url`，现场脱敏一次而不是原样吐出去。
      r.urlRedacted ?? redactGitUrl(r.url),
    ]),
  )

  const byId = new Map<string, FlattenableGroup>()
  for (const g of groups) byId.set(g.id, { id: g.id, name: g.name, members: [] })
  for (const m of members) {
    const g = byId.get(m.groupId)
    if (g === undefined) continue
    const arr = g.members as FlattenableGroup['members'][number][]
    if (m.kind === 'repo') {
      arr.push({
        kind: 'repo',
        cachedRepoId: m.cachedRepoId ?? '',
        repoUrlRedacted: repoUrlById.get(m.cachedRepoId ?? '') ?? '',
        ref: m.ref,
        subdir: m.subdir,
        mountPath: m.mountPath,
        readonly: m.readonly,
      })
    } else {
      arr.push({
        kind: 'group',
        childGroupId: m.childGroupId ?? '',
        mountPath: m.mountPath,
        readonly: m.readonly,
      })
    }
  }
  return byId
}

/**
 * 展平一个组。
 *
 * 布局错误统一转成 `ValidationError`（422）——`RepoGroupLayoutError` 是 shared
 * 里的普通 Error，直接漏到 route 层会被中央 errorHandler 渲染成 **500**，
 * 于是「你的组成环了」这条完全可操作的用户错误变成了一个服务端故障。
 * 写路径的 `assertFlattenable` 早就这么做了，读路径漏了。
 */
export function resolveRepoGroupLayout(
  db: DbClient,
  groupId: string,
): { repos: PlannedRepo[]; maxDepth: number; groupName: string } {
  const all = loadAllGroups(db)
  const root = all.get(groupId)
  if (root === undefined) {
    throw new NotFoundError('repo-group-not-found', `repo group ${groupId} not found`)
  }
  try {
    const { repos, maxDepth } = flattenRepoGroup(groupId, (id) => all.get(id))
    return { repos, maxDepth, groupName: root.name }
  } catch (err) {
    if (err instanceof RepoGroupLayoutError) {
      throw new ValidationError(err.code, err.message, err.detail)
    }
    throw err
  }
}

export function getRepoGroupLayoutResponse(db: DbClient, groupId: string): RepoGroupLayoutResponse {
  const { repos, maxDepth, groupName } = resolveRepoGroupLayout(db, groupId)
  return { groupId, groupName, repos, totalRepos: repos.length, maxDepth }
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
  const src = all.get(row.id)
  const members: RepoGroupMember[] = (src?.members ?? []).map((m, i) =>
    m.kind === 'repo'
      ? {
          kind: 'repo' as const,
          memberIndex: i,
          cachedRepoId: m.cachedRepoId,
          repoUrlRedacted: m.repoUrlRedacted,
          ref: m.ref,
          subdir: m.subdir,
          mountPath: m.mountPath,
          readonly: m.readonly,
        }
      : {
          kind: 'group' as const,
          memberIndex: i,
          childGroupId: m.childGroupId,
          childGroupName: all.get(m.childGroupId)?.name ?? '',
          mountPath: m.mountPath,
          readonly: m.readonly,
        },
  )
  // 展平失败（环 / 超限 / 悬空引用）不该让列表整个 500——把 flatRepoCount 记 0，
  // 用户点进详情或启动时才看到那条具体的 422。
  let flatRepoCount = 0
  try {
    flatRepoCount = flattenRepoGroup(row.id, (id) => all.get(id)).repos.length
  } catch (err) {
    if (!(err instanceof RepoGroupLayoutError)) throw err
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    members,
    flatRepoCount,
    boundMemories: boundMemoryCount(db, row.id),
  }
}

export function listRepoGroups(db: DbClient): RepoGroup[] {
  const all = loadAllGroups(db)
  const rows = db.select().from(repoGroups).all() as RawGroupRow[]
  return rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => toDto(db, r, all))
}

export function getRepoGroup(db: DbClient, id: string): RepoGroup {
  const rows = db.select().from(repoGroups).where(eq(repoGroups.id, id)).limit(1).all()
  const row = rows[0] as RawGroupRow | undefined
  if (row === undefined) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  return toDto(db, row, loadAllGroups(db))
}

// ─────────────────────────────────────────────────────────────────────────────
// 写
// ─────────────────────────────────────────────────────────────────────────────

/** 成员输入 → 可落库的行；顺带把 `repoUrl` resolve 成 `cachedRepoId`（D7）。 */
async function materializeMembers(
  deps: RepoGroupDeps,
  input: CreateRepoGroup,
): Promise<RawMemberRow[]> {
  const out: RawMemberRow[] = []
  for (let i = 0; i < input.members.length; i++) {
    const m = input.members[i]!
    // 挂载路径在**写入前**规范化并校验：DB 里存的永远是规范形态，展平期再跑
    // 一次是幂等的。校验失败带上成员下标，让 UI 能就地标红。
    let mountPath: string
    try {
      mountPath = normalizeMountPath(m.mountPath)
    } catch (err) {
      if (err instanceof RepoGroupLayoutError) {
        throw new ValidationError(err.code, err.message, { ...err.detail, memberIndex: i })
      }
      throw err
    }
    if (m.kind === 'group') {
      const exists = deps.db
        .select({ id: repoGroups.id })
        .from(repoGroups)
        .where(eq(repoGroups.id, m.childGroupId))
        .limit(1)
        .all()
      if (exists.length === 0) {
        throw new ValidationError(
          'repo-group-member-not-found',
          `referenced repo group ${m.childGroupId} not found`,
          { memberIndex: i, childGroupId: m.childGroupId },
        )
      }
      out.push({
        groupId: '',
        memberIndex: i,
        kind: 'group',
        cachedRepoId: null,
        ref: '',
        subdir: '',
        childGroupId: m.childGroupId,
        mountPath,
        readonly: m.readonly,
      })
      continue
    }
    let cachedRepoId = m.cachedRepoId ?? null
    if (cachedRepoId === null) {
      if (deps.cache === undefined) {
        throw new ValidationError(
          'repo-group-url-import-unavailable',
          'cannot import a repo URL in this context; pass cachedRepoId instead',
          { memberIndex: i },
        )
      }
      // D7：粘一个还没导入的 URL ⇒ 现场 clone 成 cached_repos 行并回填 id。
      const resolved = await resolveCachedRepo(deps.cache, { url: m.repoUrl! })
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
          { memberIndex: i, cachedRepoId },
        )
      }
    }
    let subdir = ''
    if (m.subdir !== '') {
      // 子目录复用挂载路径的同一套规范化——同样不许绝对 / `..` / CR / LF /
      // 反斜杠 / NUL，同样归一化到 NFC。
      try {
        subdir = normalizeMountPath(m.subdir)
      } catch (err) {
        if (err instanceof RepoGroupLayoutError) {
          throw new ValidationError(err.code, `subdir: ${err.message}`, {
            ...err.detail,
            memberIndex: i,
            field: 'subdir',
          })
        }
        throw err
      }
    }
    out.push({
      groupId: '',
      memberIndex: i,
      kind: 'repo',
      cachedRepoId,
      ref: m.ref,
      subdir,
      childGroupId: null,
      mountPath,
      readonly: m.readonly,
    })
  }
  return out
}

/** 写库后立刻展平一次——环 / 超限 / 重复挂点必须在**保存时**就被拒。 */
function assertFlattenable(db: DbClient, groupId: string): void {
  const all = loadAllGroups(db)
  try {
    flattenRepoGroup(groupId, (id) => all.get(id))
  } catch (err) {
    if (err instanceof RepoGroupLayoutError) {
      throw new ValidationError(err.code, err.message, err.detail)
    }
    throw err
  }
}

/**
 * 保存后还要复查**所有引用了本组的祖先组**是否仍然可展平。
 *
 * 单查自己不够：给内层组加一个成员，可能把某个外层组顶过 32 仓上限或造出重复
 * 挂点，而外层组自己的定义一个字都没改。不查的话那个外层组会在**下次启动时**
 * 才炸——那时用户已经不记得是哪一次编辑导致的了。
 */
function assertAncestorsStillFlattenable(db: DbClient, groupId: string): void {
  const all = loadAllGroups(db)
  const ancestors = new Set<string>()
  const stack = [groupId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    const parents = db
      .select({ groupId: repoGroupMembers.groupId })
      .from(repoGroupMembers)
      .where(eq(repoGroupMembers.childGroupId, cur))
      .all()
    for (const p of parents) {
      if (ancestors.has(p.groupId)) continue
      ancestors.add(p.groupId)
      stack.push(p.groupId)
    }
  }
  for (const a of ancestors) {
    try {
      flattenRepoGroup(a, (id) => all.get(id))
    } catch (err) {
      if (err instanceof RepoGroupLayoutError) {
        throw new ValidationError(
          err.code,
          `saving this group would break repo group '${all.get(a)?.name ?? a}': ${err.message}`,
          { ...err.detail, brokenGroupId: a },
        )
      }
      throw err
    }
  }
}

function assertNameFree(db: DbClient, name: string, excludeId?: string): void {
  const rows = db
    .select({ id: repoGroups.id })
    .from(repoGroups)
    .where(sql`lower(${repoGroups.name}) = lower(${name})`)
    .all()
  if (rows.some((r) => r.id !== excludeId)) {
    throw new ConflictError(
      'repo-group-name-conflict',
      `a repo group named '${name}' already exists`,
    )
  }
}

export async function createRepoGroup(
  deps: RepoGroupDeps,
  input: CreateRepoGroup,
  actorUserId: string | null,
): Promise<RepoGroup> {
  assertNameFree(deps.db, input.name)
  // URL → id 的 resolve 会真的 clone，必须在事务**外**做：持有写事务 clone 会把
  // 整个 daemon 的 DB 写全部堵住。
  const members = await materializeMembers(deps, input)
  const id = ulid()
  const now = (deps.now ?? Date.now)()
  // 校验必须在**事务内**、写入之后、提交之前。设计门二轮 H1：原实现先提交再
  // assertFlattenable，于是一个返回 422 的请求仍然把非法组持久化了下来。
  dbTxSync(deps.db, (tx) => {
    assertNameFree(deps.db, input.name)
    tx.insert(repoGroups)
      .values({
        id,
        name: input.name,
        description: input.description,
        version: 1,
        createdByUserId: actorUserId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const m of members)
      tx.insert(repoGroupMembers)
        .values({ ...m, groupId: id })
        .run()
    // 抛出 ⇒ dbTxSync 回滚 ⇒ 库里不留任何痕迹。
    assertFlattenable(tx as unknown as DbClient, id)
  })
  return getRepoGroup(deps.db, id)
}

export async function updateRepoGroup(
  deps: RepoGroupDeps,
  id: string,
  input: CreateRepoGroup,
  /**
   * 设计门二轮 H1 —— 乐观并发控制。两个并发的全量替换在没有它时会静默互相
   * 覆盖（后到的赢，先到的成员列表无声消失）。前端从 GET 拿到 version 后回传。
   * 省略 = 不做 OCC（内部调用方 / 脚本）。
   */
  expectedVersion?: number,
): Promise<RepoGroup> {
  const existing = deps.db
    .select()
    .from(repoGroups)
    .where(eq(repoGroups.id, id))
    .limit(1)
    .all() as RawGroupRow[]
  if (existing.length === 0) {
    throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
  }
  assertNameFree(deps.db, input.name, id)
  const members = await materializeMembers(deps, input)
  // 自引用在展平期也会被环检测抓住，但在这里先拒能给出更准的成员下标。
  const selfRef = members.findIndex((m) => m.kind === 'group' && m.childGroupId === id)
  if (selfRef >= 0) {
    throw new ValidationError('repo-group-cycle', 'a repo group cannot reference itself', {
      memberIndex: selfRef,
    })
  }
  const now = (deps.now ?? Date.now)()
  dbTxSync(deps.db, (tx) => {
    // 在事务内**重读** version：materializeMembers 期间（可能有 clone，很慢）
    // 别人可能已经改过这个组。
    const fresh = tx
      .select({ version: repoGroups.version })
      .from(repoGroups)
      .where(eq(repoGroups.id, id))
      .limit(1)
      .all()
    const current = fresh[0]?.version
    if (current === undefined) {
      throw new NotFoundError('repo-group-not-found', `repo group ${id} not found`)
    }
    if (expectedVersion !== undefined && current !== expectedVersion) {
      throw new ConflictError(
        'repo-group-version-conflict',
        `repo group was modified concurrently (expected version ${expectedVersion}, found ${current})`,
        { expectedVersion, actualVersion: current },
      )
    }
    tx.delete(repoGroupMembers).where(eq(repoGroupMembers.groupId, id)).run()
    for (const m of members)
      tx.insert(repoGroupMembers)
        .values({ ...m, groupId: id })
        .run()
    tx.update(repoGroups)
      .set({
        name: input.name,
        description: input.description,
        version: current + 1,
        updatedAt: now,
      })
      .where(eq(repoGroups.id, id))
      .run()
    // 事务内校验：目标组本身 + 所有引用它的祖先组。任一不可展平 ⇒ 整笔回滚，
    // 成员列表与 version 都保持原样（H1 要求「失败 update 完全不变」）。
    assertFlattenable(tx as unknown as DbClient, id)
    assertAncestorsStillFlattenable(tx as unknown as DbClient, id)
  })
  return getRepoGroup(deps.db, id)
}

export interface DeleteRepoGroupResult {
  archivedMemories: number
  detachedReferences: number
  /** RFC-248 #10: force 删除时被**禁用**的定时任务数（不删计划，只停发）。 */
  disabledSchedules: number
}

/**
 * 从一条持久化的定时任务 launch payload 里取出 `repoGroupId`。
 *
 * payload 是 kind-enveloped 的（`{kind, body}` 或直接就是 body，历史上两种都
 * 出现过），所以两层都看一眼；取不到就返回 null。
 */
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

/**
 * 删组。
 *
 * 设计门 G5：绑在本组上的记忆在**同一事务**里置为 `archived`——不硬删（保住
 * 用户知识），但 `memoryInject` 按 `status='approved'` 过滤，注入立即停止。
 * 不这么做的话会留下孤儿记忆：`repo_group` 与 repo/global 同档，
 * `canViewMemory`（`memory.ts:743`）在加载资源行**之前**就 return true，
 * 于是删掉的组的记忆仍然可列出、仍会被引用了旧 id 的任务注入。
 */
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
    .from(repoGroupMembers)
    .innerJoin(repoGroups, eq(repoGroups.id, repoGroupMembers.groupId))
    .where(eq(repoGroupMembers.childGroupId, id))
    .all()
  const uniqueRefs = [...new Map(referencing.map((r) => [r.id, r])).values()]
  // RFC-248 #10：**启用中**的定时任务也算引用。payload 是 JSON 文本，这里按
  // 精确的 `"repoGroupId":"<id>"` 子串筛出候选，再逐条 JSON.parse 确认——只用
  // 子串会把「组 id 恰好出现在某个提示词里」误判成引用。
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
            bound.map((b) => b.id),
          ),
        )
        .run()
      archivedMemories = bound.length
    }
    // drizzle 的 `.run()` 在这个版本不回传 changes，所以先数再删。
    detachedReferences = tx
      .select({ groupId: repoGroupMembers.groupId })
      .from(repoGroupMembers)
      .where(eq(repoGroupMembers.childGroupId, id))
      .all().length
    tx.delete(repoGroupMembers).where(eq(repoGroupMembers.childGroupId, id)).run()
    // RFC-248 #10: force 删除时，引用本组的启用中计划在**同一事务**里禁用。
    // 不删计划——用户可能只是想换个组重新启用；`next_run_at` 置 null 让轮询
    // 直接跳过，`last_error` 说明原因，管理员在列表里一眼看得出。
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
            refSchedules.map((r) => r.id),
          ),
        )
        .run()
      disabledSchedules = refSchedules.length
    }
    tx.delete(repoGroups).where(eq(repoGroups.id, id)).run()
  })
  return { archivedMemories, detachedReferences, disabledSchedules }
}

// ─────────────────────────────────────────────────────────────────────────────
// 删仓守卫（D13）—— 供 gitRepoCache.deleteCachedRepo 调用
// ─────────────────────────────────────────────────────────────────────────────

/** 引用了某个 cached repo 的组（去重）。 */
export function groupsReferencingRepo(
  db: DbClient,
  cachedRepoId: string,
): Array<{ id: string; name: string }> {
  const rows = db
    .select({ id: repoGroups.id, name: repoGroups.name })
    .from(repoGroupMembers)
    .innerJoin(repoGroups, eq(repoGroups.id, repoGroupMembers.groupId))
    .where(eq(repoGroupMembers.cachedRepoId, cachedRepoId))
    .all()
  return [...new Map(rows.map((r) => [r.id, r])).values()]
}

/** `force=1` 删仓时把它从所有组里摘掉，返回摘除的成员行数。 */
export function detachRepoFromAllGroups(db: DbClient, cachedRepoId: string): number {
  // 先数再删（drizzle 的 `.run()` 在这个版本不回传 changes）。
  const n = db
    .select({ groupId: repoGroupMembers.groupId })
    .from(repoGroupMembers)
    .where(eq(repoGroupMembers.cachedRepoId, cachedRepoId))
    .all().length
  db.delete(repoGroupMembers).where(eq(repoGroupMembers.cachedRepoId, cachedRepoId)).run()
  return n
}
