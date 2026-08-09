// RFC-271 T26 —— 导入预检：逐条匹配本地已有资源、给出可选动作、签发 `previewToken`。
//
// **`previewToken` 必须签死整套确认基线，不能只签包摘要**（R4-P1-1 / R5-P1-A）。
//
// 两版被否掉的写法，各自的绕法都很具体：
//   · 「preview 下发包摘要、commit 重算比对」—— 证明不了任何事：客户端可以同时换掉
//     文件**和**摘要（preview 包 A 拿 `DA`，commit 传包 B 并把摘要改成 `hash(B)`，
//     服务端重算 B 得同一个值，比对通过）。
//   · 「只签 packageDigest」—— 包没变也能绕：preview 时目标插件是 `H1`，用户在另一
//     标签页把它改成了 `H2`；客户端把 decision 里的 `expect` 换成 `H2`，签名仍有效、
//     owner 与 allowedActions 也仍通过，于是 CAS 覆盖了用户**从未确认过**的 `H2`。
//
// 所以签名面是：`importId ‖ actorUserId ‖ packageDigest ‖ exp ‖ canonical(baseline)`，
// 其中 baseline 逐条目记下 { 候选 id、各候选的 expect、允许的动作 }。
// **用户的「选择」是自由的，但可选项与它们的基线是签死的。**

import { eq, inArray } from 'drizzle-orm'
import { users } from '@/db/schema'
import type { SecretBox } from '@/auth/secretBox'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  canonicalJson,
  type AclResourceType,
  type BundleOp,
  type Permission,
} from '@agent-workflow/shared'
import { ACL_TABLES, isVisibleRow, listGrantedResourceIds } from '@/services/resourceAcl'
import { ValidationError } from '@/util/errors'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'
import { resourceTypeOfOp, opSlug } from '@/services/bundle/provider'
import type { ParsedPackage } from './parse'

/** 预检有效期。过期后必须重新 preview——基线可能已经变了。 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000

/**
 * 资源类型 → 写权限点。**两头都受检**：`Record<AclResourceType, …>` 保证六类一个不漏，
 * 值标成 `Permission` 保证写出来的点位真的存在（打错字直接编译失败）。
 */
const WRITE_POINTS: Record<AclResourceType, { create: Permission; update: Permission }> = {
  agent: { create: 'agents:create', update: 'agents:update' },
  skill: { create: 'skills:create', update: 'skills:update' },
  mcp: { create: 'mcps:create', update: 'mcps:update' },
  plugin: { create: 'plugins:create', update: 'plugins:update' },
  workflow: { create: 'workflows:create', update: 'workflows:update' },
  workgroup: { create: 'workgroups:create', update: 'workgroups:update' },
}

export type ImportAction = 'new' | 'reuse' | 'overwrite'

export interface PreviewCandidate {
  id: string
  name: string
  /** 该候选的内容级 CAS token（overwrite 用）。 */
  expect: Record<string, unknown>
  /** 归属：只有自己的才允许 overwrite。 */
  owned: boolean
}

export interface PreviewEntry {
  localSlug: string
  type: AclResourceType
  name: string
  /** 本地已有的同名候选。**可以多个**（名字是 (owner,name) 复合唯一）。 */
  candidates: PreviewCandidate[]
  /** 服务端算的允许动作。commit 时**重算**，不信客户端。 */
  allowedActions: ImportAction[]
  /** 建议的新名字（`new` 时用，避开自己已占用的名字）。 */
  suggestedName: string
}

/** 包里的一个 human 成员槽 —— 导入时由用户选映射到哪个本地用户。 */
export interface HumanMemberSlot {
  workgroupSlug: string
  /** 源实例上的用户名。**只是标识，不保证这台机器上是同一个人。** */
  username: string
  /** 组内寻址名（组内唯一）。 */
  displayName: string
  /** 本地恰好有同名的 active 用户时预填，仅供参考——最终由用户拍板。 */
  suggestedUserId: string | null
  /** leader_worker 的 leader：**不允许跳过**，否则导入出来的组起不了。 */
  required: boolean
}

export interface PackagePreview {
  importId: string
  entries: PreviewEntry[]
  /** 需要逐个选映射的 human 成员槽（可能为空）。 */
  humanMembers: HumanMemberSlot[]
  previewToken: string
  expiresAt: number
  /** 需要重新填写的凭据字段（来自 manifest，只有位置）。 */
  secrets: unknown[]
  requirements: unknown
}

interface BundleHumanMember {
  username: string
  displayName: string
}

/** 进签名的那一份基线——**只含服务端定的东西**，不含用户的选择。 */
interface PreviewBaselineEntry {
  localSlug: string
  candidateIds: string[]
  expectByCandidateId: Record<string, unknown>
  allowedActions: ImportAction[]
}

export function previewBaselineOf(entries: readonly PreviewEntry[]): PreviewBaselineEntry[] {
  return entries
    .map((e) => ({
      localSlug: e.localSlug,
      candidateIds: e.candidates.map((c) => c.id).sort(),
      expectByCandidateId: Object.fromEntries(
        [...e.candidates].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, c.expect]),
      ),
      allowedActions: [...e.allowedActions].sort(),
    }))
    .sort((a, b) => a.localSlug.localeCompare(b.localSlug))
}

export function signPreviewToken(
  box: SecretBox,
  payload: {
    importId: string
    actorUserId: string
    packageDigest: string
    expiresAt: number
    baseline: PreviewBaselineEntry[]
    humanBaseline: Array<{ workgroupSlug: string; username: string; required: boolean }>
  },
): string {
  return box.seal(canonicalJson(payload))
}

export interface VerifiedPreview {
  importId: string
  actorUserId: string
  packageDigest: string
  expiresAt: number
  baseline: PreviewBaselineEntry[]
  humanBaseline: Array<{ workgroupSlug: string; username: string; required: boolean }>
}

export function verifyPreviewToken(box: SecretBox, token: string): VerifiedPreview {
  let raw: string
  try {
    raw = box.unseal(token)
  } catch {
    throw new ValidationError('package-preview-token-invalid', 'preview token is not valid')
  }
  try {
    return JSON.parse(raw) as VerifiedPreview
  } catch {
    throw new ValidationError('package-preview-token-invalid', 'preview token payload is corrupt')
  }
}

/** 各类型的内容级 CAS token —— 与 `BundleExpectToken` 的形态一一对应。 */
export function expectTokenOf(
  type: AclResourceType,
  row: Record<string, unknown>,
): Record<string, unknown> {
  switch (type) {
    case 'agent':
      return {
        expectedUpdatedAt: Number(row.updatedAt ?? 0),
        expectedAclRevision: Number(row.aclRevision ?? 0),
      }
    case 'skill':
      return {
        expectedContentVersion: Number(row.contentVersion ?? 0),
        expectedMetaRevision: Number(row.metaRevision ?? 0),
        expectedAclRevision: Number(row.aclRevision ?? 0),
      }
    case 'mcp':
      return { expectedConfigHash: mcpOperationConfigHashOf(rowToMcpLike(row)) }
    case 'plugin':
      return { expectedConfigHash: pluginOperationConfigHashOf(rowToPluginLike(row)) }
    case 'workflow':
    case 'workgroup':
      return { expectedVersion: Number(row.version ?? 1) }
  }
}

/** hash 函数吃的是领域对象，不是原始行——把 JSON 列解开即可。 */
function rowToMcpLike(
  row: Record<string, unknown>,
): Parameters<typeof mcpOperationConfigHashOf>[0] {
  return {
    ...row,
    config: typeof row.config === 'string' ? JSON.parse(row.config) : (row.config ?? {}),
  } as never
}

function rowToPluginLike(
  row: Record<string, unknown>,
): Parameters<typeof pluginOperationConfigHashOf>[0] {
  return {
    ...row,
    options:
      typeof row.optionsJson === 'string' ? JSON.parse(row.optionsJson) : (row.options ?? {}),
  } as never
}

export async function buildPackagePreview(
  db: DbClient,
  actor: Actor,
  pkg: ParsedPackage,
  opts: {
    box: SecretBox
    importId: string
    now?: number
    configHashOf?: (type: AclResourceType, row: Record<string, unknown>) => string
  },
): Promise<PackagePreview> {
  const now = opts.now ?? Date.now()
  const entries: PreviewEntry[] = []

  for (const op of pkg.bundle.ops) {
    const slug = opSlug(op)
    if (slug === null) continue // 包里只应有 create op（导出侧只产 create）
    const type = resourceTypeOfOp(op as BundleOp)
    const name = String((op.payload as { name?: unknown }).name ?? '')
    const table = ACL_TABLES[type]
    const grants = new Set(await listGrantedResourceIds(db, actor, type))
    const rows = (await db.select().from(table).where(eq(table.name, name))) as unknown as Array<
      Record<string, unknown>
    >
    const visible = rows.filter((r) => isVisibleRow(actor, r as never, grants))
    const candidates: PreviewCandidate[] = visible.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      expect: expectTokenOf(type, r),
      // 「只能覆盖自己的，别人的不给覆盖选项」——归属在这里就定死，commit 再算一遍。
      owned: r.ownerUserId === actor.user.id,
    }))
    // 「令牌有写权限才能导入，和界面操作一致」：界面上没有 `agents:create` 就没有
    // 「新建」按钮，这里同样不给 `new`。**reuse 不需要写权限**——它只是引用一个你
    // 本来就看得见的资源，一个字节都不写。
    const allowedActions: ImportAction[] = []
    if (actor.permissions.has(WRITE_POINTS[type].create)) allowedActions.push('new')
    if (candidates.length > 0) allowedActions.push('reuse')
    if (candidates.some((c) => c.owned) && actor.permissions.has(WRITE_POINTS[type].update)) {
      allowedActions.push('overwrite')
    }
    if (allowedActions.length === 0) {
      // 一个动作都不剩 ⇒ 这个包对这个令牌不可导入。**整体拒绝**而不是产出一个
      // 「装了一半」的实例：少掉的那条是别人的传递依赖，跑起来必然悬空。
      throw new ValidationError(
        'package-write-forbidden',
        `importing '${name}' needs ${WRITE_POINTS[type].create} (or an existing ${type} you may reuse)`,
      )
    }

    entries.push({
      localSlug: slug,
      type,
      name,
      candidates,
      allowedActions,
      suggestedName: suggestName(name, new Set(rows.map((r) => String(r.name)))),
    })
  }

  const humanMembers = await collectHumanMemberSlots(db, pkg)

  const expiresAt = now + PREVIEW_TTL_MS
  const baseline = previewBaselineOf(entries)
  return {
    importId: opts.importId,
    entries,
    humanMembers,
    previewToken: signPreviewToken(opts.box, {
      importId: opts.importId,
      actorUserId: actor.user.id,
      packageDigest: pkg.digest,
      expiresAt,
      baseline,
      // human 映射的**候选集**同样是服务端定的基线：不签它，客户端就能把某个成员
      // 映射到一个预检里从未列为候选的 user id（和 `expect` 那一版绕法同构）。
      humanBaseline: humanMemberBaselineOf(humanMembers),
    }),
    expiresAt,
    secrets: Array.isArray(pkg.manifest.secrets) ? pkg.manifest.secrets : [],
    requirements: pkg.manifest.requirements ?? {},
  }
}

/**
 * 包里的 human 成员槽 —— 每个都要用户在导入时**逐个选映射**。
 *
 * `username` 是源实例的标识，在这台机器上可能对应另一个人、或根本没有。所以平台
 * 不替用户猜：同名用户只作为 `suggestedUserId` 预填，最终由用户拍板。
 *
 * `required` 的那一条是 leader：`leader_worker` 模式没有 leader 就不成立，所以
 * leader 槽**不允许跳过**（其余成员可以映射成 null = 不加入该成员）。
 */
async function collectHumanMemberSlots(
  db: DbClient,
  pkg: ParsedPackage,
): Promise<HumanMemberSlot[]> {
  const slots: HumanMemberSlot[] = []
  const wanted = new Set<string>()
  const raw: Array<{ slug: string; m: BundleHumanMember; leader: boolean; mode: string }> = []

  for (const op of pkg.bundle.ops) {
    if (resourceTypeOfOp(op as BundleOp) !== 'workgroup') continue
    const slug = opSlug(op)
    if (slug === null) continue
    const payload = op.payload as {
      mode?: unknown
      members?: unknown
      leaderDisplayName?: unknown
    }
    for (const member of Array.isArray(payload.members) ? payload.members : []) {
      const m = member as BundleHumanMember & { memberType?: string }
      if (m.memberType !== 'human') continue
      wanted.add(m.username)
      raw.push({
        slug,
        m,
        leader: m.displayName === payload.leaderDisplayName,
        mode: String(payload.mode ?? ''),
      })
    }
  }
  if (raw.length === 0) return slots

  const localByUsername = new Map<string, string>()
  const rows = await db
    .select({ id: users.id, username: users.username, status: users.status })
    .from(users)
    .where(inArray(users.username, [...wanted]))
  for (const u of rows) {
    // 停用的人不是可选映射目标——把成员绑到一个不能登录的主体上毫无意义。
    if (u.status === 'active') localByUsername.set(u.username, u.id)
  }

  for (const { slug, m, leader, mode } of raw) {
    slots.push({
      workgroupSlug: slug,
      username: m.username,
      displayName: m.displayName,
      suggestedUserId: localByUsername.get(m.username) ?? null,
      // leader_worker 的 leader 不能空缺，否则导入出来的组根本起不了。
      required: leader && mode === 'leader_worker',
    })
  }
  return slots
}

export function humanMemberBaselineOf(
  slots: readonly HumanMemberSlot[],
): Array<{ workgroupSlug: string; username: string; required: boolean }> {
  return slots
    .map((s) => ({ workgroupSlug: s.workgroupSlug, username: s.username, required: s.required }))
    .sort((a, b) =>
      a.workgroupSlug === b.workgroupSlug
        ? a.username.localeCompare(b.username)
        : a.workgroupSlug.localeCompare(b.workgroupSlug),
    )
}

function suggestName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${name}-${Date.now()}`
}
