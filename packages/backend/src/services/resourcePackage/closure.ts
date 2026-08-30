// RFC-271 T19/T20/T22 —— 导出闭包遍历与三道门。
//
// 「导出一个工作流」实际要导出的是**它的整棵引用树**：agent → 技能 / MCP / 插件 /
// dependsOn，工作流 → agent + call 目标，工作组 → 成员 agent。BFS + visited 去重
// 去环，一次批量装载一层。
//
// 三道门（design §4.1）：
//   ① 行级可见性（**含传递**）—— 闭包内每个 id 域资源都要对导出者可见
//   ② 特权节点（分轴）—— 脚本 / 代码平台各自独立判
//   ③ **同名重复** —— 闭包里出现两个同 `(类型,名字)` 的资源就整体拒绝
//
// ⚠️ 曾经写作「四道门」并列出一道**体积门**——那道门随 AC-11 改判取消（用户拍板
// 「技能整棵树进包、不设任何上限」，截断会产出一个「看起来成功」的残包）。注释描述
// 一道并不存在的门，比没有注释更糟：读的人会去找它、找不到就以为是自己漏了。
//
// ③ 为什么在**导出侧**拒绝：包不带任何权属信息。源实例上两个同名资源能共存是因为
// 名字是 `(owner,name)` 复合唯一；进了包 owner 没了，就剩两个都叫 `lint` 的条目，
// 导入方无从分辨。这种包在语义上不可表示——与其让导入侧去猜，不如根本不产出。
// 场景真实存在：工作流引用代理 A（用 Alice 的 `lint`）和代理 B（用 Bob 的 `lint`）。
//
// ⚠️ **显式不做第四道类型级 `*:read` 门**（决策 24 / AC-7d）：用户原则「可见即有读
// 权限」——`isVisibleRow` 的 owner/public/grant 判定本身就是读权限模型；类型级权限点
// 管的是「能不能走这一类的列表 / 详情路由」。测试用**反向锁**钉住。

import type { BundleResourceType, WorkflowDefinition } from '@agent-workflow/shared'
import {
  collectWorkflowCallRefs,
  collectWorkgroupCallRefs,
  migrateWorkflowDefinitionToLatest,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'
import { asc, inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { users, workgroupMembers } from '@/db/schema'
import { isVisibleRow, listGrantedResourceIds } from '@/services/resourceAcl'
import {
  listSqlitePackageResourceRowsByIds,
  listSqlitePackageResourceRowsByNames,
} from '@/modules/resource-catalog/infrastructure/sqlitePackageResourceRows'
import { privilegedNodeLensFor } from '@/services/privilegedNodeLens'
import { ValidationError } from '@/util/errors'

/** 闭包里的一条资源。`row` 是 canonical 行（未脱敏——脱敏在序列化段）。 */
export interface ClosureResource {
  type: BundleResourceType
  id: string
  name: string
  row: Record<string, unknown>
  /** 谁把它拉进闭包的（`<type>:<id>`）。同名冲突的报错要点名这个。 */
  referencedBy: string[]
  /**
   * 框架 built-in（`agents` / `workflows` 两张表有这一列；owner 通常是 `__system__`）。
   *
   * **照常导出、标记出来、导入时自动忽略**：它在每个实例上都由框架自己 seed，
   * 复制一份的结果是对端多出一个 owner 错、`builtin=false` 的同名副本，而真正的
   * built-in 仍在那儿。所以它进包只为了**让引用能被解释**，不产 create op。
   *
   * 可选：缺省 = 不是 built-in。带这一列的是 `agents` / `workflows` /
   * `capability_templates` 三张表，但只有前两张有把它写成 true 的路径，
   * 其余类型永远走缺省。（RFC-317 T66 订正：原文写「只有两张表有这一列」，
   * RFC-304/309 给 capability_templates 加列之后就不成立了。）
   */
  builtin?: boolean
}

/**
 * `builtin` 列在 agents / workflows / capability_templates 三张表上；只有前两张
 * 有写 true 的路径，因此其余类型的行恒为 false。（RFC-317 T66 订正。）
 */
export const isBuiltinRow = (row: Record<string, unknown>): boolean => row.builtin === true

export interface ClosureCallRef {
  /** 引用方 */
  fromType: 'workflow'
  fromId: string
  nodeId: string
  targetType: 'workflow' | 'workgroup'
  name: string
  /** 解析到的行；null = dangling（零匹配或全部不可见，**两者同形**）。 */
  resolvedId: string | null
}

export interface ExportClosure {
  root: ClosureResource
  resources: ClosureResource[]
  callRefs: ClosureCallRef[]
}

export const rowName = (row: Record<string, unknown>): string =>
  typeof row.name === 'string' ? row.name : ''

/** 一次装载一层。**只返回对 actor 可见的行**——不可见的由 ① 号门报错。 */
async function loadRows(
  db: DbClient,
  type: BundleResourceType,
  ids: readonly string[],
): Promise<Record<string, unknown>[]> {
  const out = await listSqlitePackageResourceRowsByIds(db, type, ids, { orderById: true })
  if (type === 'workgroup') await attachWorkgroupMembers(db, out)
  return out
}

/**
 * 工作组的成员在**独立表** `workgroup_members`，不是 `workgroups` 上的 JSON 列；
 * 开关（shareOutputs / directMessages / blackboard）也是各自独立的列。
 *
 * 在**装载层**把成员补进 `row.members`，让下游（`directRefsOf` / 序列化 /
 * requirements）只有一处知道它的来源——三处各查一遍是「两套实现」的起点。
 *
 * human 成员在表里只有 `user_id`；跨实例可移植的标识是 **username**，所以这里
 * 一并 join 出来。排序按 `(sortOrder, id)` 固定，导出要逐字节稳定。
 */
export async function attachWorkgroupMembers(
  db: DbClient,
  groups: Record<string, unknown>[],
): Promise<void> {
  if (groups.length === 0) return
  const groupIds = groups.map((g) => String(g.id))
  const members = await db
    .select()
    .from(workgroupMembers)
    .where(inArray(workgroupMembers.workgroupId, groupIds))
    .orderBy(asc(workgroupMembers.sortOrder), asc(workgroupMembers.id))

  const userIds = [
    ...new Set(
      members
        .filter((m) => m.memberType === 'human' && typeof m.userId === 'string')
        .map((m) => m.userId as string),
    ),
  ]
  const usernameById = new Map<string, string>()
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: users.id, username: users.username })
      .from(users)
      .where(inArray(users.id, userIds))
    for (const u of rows) usernameById.set(u.id, u.username)
  }

  const byGroup = new Map<string, Record<string, unknown>[]>()
  for (const m of members) {
    const list = byGroup.get(m.workgroupId) ?? []
    list.push({
      id: m.id,
      memberType: m.memberType,
      agentId: m.agentId,
      agentName: m.agentName,
      userId: m.userId,
      username: m.userId === null ? null : (usernameById.get(m.userId) ?? null),
      displayName: m.displayName,
      roleDesc: m.roleDesc,
      sortOrder: m.sortOrder,
    })
    byGroup.set(m.workgroupId, list)
  }
  for (const g of groups) g.members = byGroup.get(String(g.id)) ?? []
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Sibling of `parseJsonArray` for the object-valued JSON columns. */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function definitionOf(row: Record<string, unknown>): WorkflowDefinition | null {
  const raw = row.definition
  try {
    const parsed = WorkflowDefinitionSchema.safeParse(
      typeof raw === 'string' ? JSON.parse(raw) : raw,
    )
    return parsed.success ? migrateWorkflowDefinitionToLatest(parsed.data) : null
  } catch {
    return null
  }
}

/** 一个资源直接引用了哪些 id 域资源（不含 call 的名字域）。 */
export function directRefsOf(
  type: BundleResourceType,
  row: Record<string, unknown>,
): Array<{ type: BundleResourceType; id: string }> {
  const out: Array<{ type: BundleResourceType; id: string }> = []
  if (type === 'agent') {
    for (const raw of parseJsonArray(row.skills)) {
      const ref = raw as { kind?: string; skillId?: string }
      // project 技能不是资源（无行、无 ACL）——闭包遍历必须跳过它，否则会去查一个
      // 永远查不到的 id 然后判成「不可见」。
      if (ref.kind === 'managed' && typeof ref.skillId === 'string') {
        out.push({ type: 'skill', id: ref.skillId })
      }
    }
    for (const id of parseJsonArray(row.dependsOn)) {
      if (typeof id === 'string') out.push({ type: 'agent', id })
    }
    for (const id of parseJsonArray(row.mcp)) {
      if (typeof id === 'string') out.push({ type: 'mcp', id })
    }
    for (const id of parseJsonArray(row.plugins)) {
      if (typeof id === 'string') out.push({ type: 'plugin', id })
    }
    return out
  }
  if (type === 'workflow') {
    const defn = definitionOf(row)
    for (const node of defn?.nodes ?? []) {
      const agentId = (node as unknown as { agentId?: unknown }).agentId
      if (typeof agentId === 'string' && agentId.length > 0) {
        out.push({ type: 'agent', id: agentId })
      }
    }
    return out
  }
  if (type === 'capability_template') {
    // RFC-309 — a template references only the AGENTS filling its slots. The
    // old binding arm also had to pull in its framework, and forgetting that
    // produced a package whose binding pointed at a template that was not in it
    // — a defect the compiler could not see, because the extractor's default is
    // an empty list rather than a missing case. The merge deletes that class of
    // failure: the scripts travel in the same row.
    for (const agentId of Object.values(parseJsonObject(row.agentBySlotJson))) {
      if (typeof agentId === 'string' && agentId.length > 0) {
        out.push({ type: 'agent', id: agentId })
      }
    }
    return out
  }
  if (type === 'workgroup') {
    // `row.members` 由 `attachWorkgroupMembers` 在装载层补上（成员是独立表）。
    for (const raw of parseJsonArray(row.members)) {
      const m = raw as { memberType?: string; agentId?: string }
      if (m.memberType === 'agent' && typeof m.agentId === 'string') {
        out.push({ type: 'agent', id: m.agentId })
      }
    }
    return out
  }
  return out
}

/**
 * name 域的 call 目标解析——**与 `freezeCallClosure` 逐字一致**（AC-7c）：
 * `workflowId` cache 优先（且该行**仍带该选择器名字**），其次最老可见 ULID。
 *
 * ⚠️ v2 曾写成「总选最老可见行」，与运行时不符：节点若指向同名新行 W2 而另有更老的
 * W1，现网启动的是 W2，那样的导出却会导出 W1 —— 包与实际执行的闭包不是同一个。
 *
 * 零匹配与「有行但全部不可见」返回**同一个** null：两者必须逐字节同形，否则导出
 * 本身成了存在性预言机。
 */
async function resolveCallTarget(
  db: DbClient,
  actor: Actor,
  type: 'workflow' | 'workgroup',
  name: string,
  idHint: string | undefined,
  grants: ReadonlySet<string>,
): Promise<Record<string, unknown> | null> {
  const rows = await listSqlitePackageResourceRowsByNames(db, type, [name], {
    orderById: true,
  })
  const visible = rows.filter((r) => isVisibleRow(actor, r as never, grants))
  if (visible.length === 0) return null
  if (idHint !== undefined) {
    const hinted = visible.find((r) => r.id === idHint && rowName(r) === name)
    if (hinted !== undefined) return hinted
  }
  return visible[0] ?? null
}

export interface ExportGateOptions {
  /** 体积上限（四维）。缺省用技能 zip 的那套。 */
  limits?: { entries: number; perFileBytes: number; totalBytes: number; depth: number }
}

/**
 * 遍历闭包并跑前两道门（可见性 / 同名重复）。特权门与体积门需要序列化后的内容，
 * 由 `assertPrivilegedNodesExportable` / 序列化段各自负责。
 */
export async function walkExportClosure(
  db: DbClient,
  actor: Actor,
  root: { type: BundleResourceType; id: string },
): Promise<ExportClosure> {
  const grantsByType = new Map<BundleResourceType, ReadonlySet<string>>()
  const grantsOf = async (type: BundleResourceType): Promise<ReadonlySet<string>> => {
    const cached = grantsByType.get(type)
    if (cached !== undefined) return cached
    const ids = new Set(await listGrantedResourceIds(db, actor, type))
    grantsByType.set(type, ids)
    return ids
  }

  const byKey = new Map<string, ClosureResource>()
  const callRefs: ClosureCallRef[] = []
  const keyOf = (type: BundleResourceType, id: string): string => `${type}:${id}`

  let frontier: Array<{ type: BundleResourceType; id: string; from: string | null }> = [
    { ...root, from: null },
  ]
  let rootResource: ClosureResource | null = null

  while (frontier.length > 0) {
    const wanted = new Map<BundleResourceType, Set<string>>()
    for (const item of frontier) {
      const existing = byKey.get(keyOf(item.type, item.id))
      if (existing !== undefined) {
        if (item.from !== null && !existing.referencedBy.includes(item.from)) {
          existing.referencedBy.push(item.from)
        }
        continue
      }
      const set = wanted.get(item.type) ?? new Set<string>()
      set.add(item.id)
      wanted.set(item.type, set)
    }
    if (wanted.size === 0) break

    const next: Array<{ type: BundleResourceType; id: string; from: string | null }> = []
    for (const [type, ids] of wanted) {
      const rows = await loadRows(db, type, [...ids])
      const grants = await grantsOf(type)
      const foundIds = new Set(rows.map((r) => String(r.id)))
      for (const id of ids) {
        const row = rows.find((r) => r.id === id)
        // ① 行级可见性（**含传递**）。「不存在」与「存在但不可见」同形——闭包里
        // 一条引用解析不出可导出的行，就整体拒绝，不给出哪一种。
        if (row === undefined || !foundIds.has(id) || !isVisibleRow(actor, row as never, grants)) {
          const from = frontier.find((f) => f.type === type && f.id === id)?.from
          throw new ValidationError(
            'package-export-ref-unavailable',
            from === null || from === undefined
              ? `cannot export ${type} '${id}': it is not available to you`
              : `cannot export: ${from} references ${type} '${id}', which is not available to you`,
          )
        }
        const resource: ClosureResource = {
          type,
          id,
          name: rowName(row),
          row,
          referencedBy: [],
          builtin: isBuiltinRow(row),
        }
        const from = frontier.find((f) => f.type === type && f.id === id)?.from
        if (from !== null && from !== undefined) resource.referencedBy.push(from)
        byKey.set(keyOf(type, id), resource)
        if (rootResource === null && type === root.type && id === root.id) rootResource = resource

        for (const ref of directRefsOf(type, row)) {
          next.push({ ...ref, from: keyOf(type, id) })
        }
        // call 目标：名字域，late-bound。解析不到**不是错误**（dangling 合法）。
        if (type === 'workflow') {
          const defn = definitionOf(row)
          if (defn !== null) {
            for (const ref of collectWorkflowCallRefs(defn)) {
              const target = await resolveCallTarget(
                db,
                actor,
                'workflow',
                ref.workflowName,
                ref.workflowId,
                await grantsOf('workflow'),
              )
              callRefs.push({
                fromType: 'workflow',
                fromId: id,
                nodeId: ref.nodeId,
                targetType: 'workflow',
                name: ref.workflowName,
                resolvedId: target === null ? null : String(target.id),
              })
              if (target !== null) {
                next.push({ type: 'workflow', id: String(target.id), from: keyOf(type, id) })
              }
            }
            for (const ref of collectWorkgroupCallRefs(defn)) {
              const target = await resolveCallTarget(
                db,
                actor,
                'workgroup',
                ref.workgroupName,
                ref.workgroupId,
                await grantsOf('workgroup'),
              )
              callRefs.push({
                fromType: 'workflow',
                fromId: id,
                nodeId: ref.nodeId,
                targetType: 'workgroup',
                name: ref.workgroupName,
                resolvedId: target === null ? null : String(target.id),
              })
              if (target !== null) {
                next.push({ type: 'workgroup', id: String(target.id), from: keyOf(type, id) })
              }
            }
          }
        }
      }
    }
    frontier = next
  }

  if (rootResource === null) {
    throw new ValidationError(
      'package-export-ref-unavailable',
      `cannot export ${root.type} '${root.id}': it is not available to you`,
    )
  }

  const resources = [...byKey.values()]
  assertNoDuplicateNames(resources)
  return { root: rootResource, resources, callRefs }
}

/** ④ 同名重复门。 */
export function assertNoDuplicateNames(resources: readonly ClosureResource[]): void {
  const seen = new Map<string, ClosureResource[]>()
  for (const r of resources) {
    const key = `${r.type}:${r.name}`
    const bucket = seen.get(key) ?? []
    bucket.push(r)
    seen.set(key, bucket)
  }
  for (const [key, bucket] of seen) {
    if (bucket.length < 2) continue
    const detail = bucket
      .map((r) => `${r.id} (referenced by ${r.referencedBy.join(', ') || 'the export root'})`)
      .join(' and ')
    throw new ValidationError(
      'package-duplicate-resource-name',
      // 包里没有 owner，所以两条同名条目导入方无从分辨——不产出这种包。
      `closure contains two resources named ${key}: ${detail}. A package carries no ownership, so two same-named ${bucket[0]!.type}s cannot be represented; rename one before exporting.`,
    )
  }
}

/** ② 特权节点门（分轴）。`lens.scripts === true` 表示该 actor **没有**脚本创作权。 */
export function assertPrivilegedNodesExportable(
  actor: Actor,
  resources: readonly ClosureResource[],
): void {
  const lens = privilegedNodeLensFor(actor)
  if (!lens.scripts && !lens.codeHost) return
  for (const r of resources) {
    if (r.type !== 'workflow') continue
    const defn = definitionOf(r.row)
    for (const node of defn?.nodes ?? []) {
      const kind = (node as unknown as { kind?: string }).kind
      if (lens.scripts && kind === 'script') {
        throw new ValidationError(
          'package-privileged-node-forbidden',
          `cannot export workflow '${r.id}': it contains a script node and you lack scripts:author`,
        )
      }
      if (lens.codeHost && kind === 'code-host-call') {
        throw new ValidationError(
          'package-privileged-node-forbidden',
          `cannot export workflow '${r.id}': it contains a code-host node and you lack code-host-calls:author`,
        )
      }
    }
  }
}
