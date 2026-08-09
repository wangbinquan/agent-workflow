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
import { z } from 'zod'
import { users } from '@/db/schema'
import type { SecretBox } from '@/auth/secretBox'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { canonicalJson, type AclResourceType, type BundleOp } from '@agent-workflow/shared'
import { ACL_TABLES, isVisibleRow, listGrantedResourceIds } from '@/services/resourceAcl'
import { ValidationError } from '@/util/errors'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'
import { resourceTypeOfOp, opSlug } from '@/services/bundle/provider'
import type { PackageManifest, ParsedPackage } from './parse'
import { missingImportPermissions } from './importPermissions'

/** 预检有效期。过期后必须重新 preview——基线可能已经变了。 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000

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
  /** 安全默认：优先复用，其次新建；覆盖永远需要用户主动选择。 */
  defaultAction: ImportAction | null
  /** 当前没有任何可用动作时，列出使 `new` 可用所缺的动态权限点。 */
  missingPermissions: string[]
  /** 建议的新名字（`new` 时用，避开自己已占用的名字）。 */
  suggestedName: string
  /** 此资源需要重新填写的完整 secret 引用；值永远不进 preview。 */
  secretFields: PackageManifest['secrets']
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
  /**
   * 兼容既有 wire 契约。canonical 工作组只允许 agent 当 leader，所以当前合法包里的
   * human 槽恒为 false；读取旧 preview token 时仍按 OR 后的值执行必填约束。
   */
  required: boolean
}

/** 同一源用户可以用多个组内 alias 出现；UI / CLI 按这个形态展示一次、列出全部 alias。 */
export interface HumanMemberSlotGroup {
  workgroupSlug: string
  username: string
  displayNames: string[]
  suggestedUserId: string | null
  required: boolean
}

export interface HumanMemberBaselineEntry {
  workgroupSlug: string
  username: string
  required: boolean
}

export interface PackagePreview {
  importId: string
  /** 包的权威根资源；成功导入后前端据此决定落到哪一类详情页。 */
  root: PackageManifest['root']
  entries: PreviewEntry[]
  /** 需要逐个选映射的 human 成员槽（可能为空）。 */
  humanMembers: HumanMemberSlot[]
  previewToken: string
  expiresAt: number
  /** 需要重新填写的凭据字段（来自 manifest，只有位置）。 */
  secrets: PackageManifest['secrets']
  requirements: PackageManifest['requirements']
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
    humanBaseline: HumanMemberBaselineEntry[]
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
  humanBaseline: HumanMemberBaselineEntry[]
}

const PreviewBaselineEntrySchema = z
  .object({
    localSlug: z.string().min(1),
    candidateIds: z.array(z.string().min(1)),
    expectByCandidateId: z.record(z.unknown()),
    allowedActions: z.array(z.enum(['new', 'reuse', 'overwrite'])),
  })
  .strict()

const HumanMemberBaselineEntrySchema = z
  .object({
    workgroupSlug: z.string().min(1),
    username: z.string().min(1),
    required: z.boolean(),
  })
  .strict()

const VerifiedPreviewSchema = z
  .object({
    importId: z.string().min(1),
    actorUserId: z.string().min(1),
    packageDigest: z.string().min(1),
    expiresAt: z.number().int().nonnegative(),
    baseline: z.array(PreviewBaselineEntrySchema),
    // TTL 内可能仍有旧版本签出的 token；旧形态没有 humanBaseline，等价于无席位。
    humanBaseline: z.array(HumanMemberBaselineEntrySchema).default([]),
  })
  .strict()

export function verifyPreviewToken(box: SecretBox, token: string): VerifiedPreview {
  let raw: string
  try {
    raw = box.unseal(token)
  } catch {
    throw new ValidationError('package-preview-token-invalid', 'preview token is not valid')
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new ValidationError('package-preview-token-invalid', 'preview token payload is corrupt')
  }
  const parsed = VerifiedPreviewSchema.safeParse(payload)
  if (!parsed.success) {
    throw new ValidationError(
      'package-preview-token-invalid',
      'preview token payload has an invalid shape',
    )
  }
  return parsed.data
}

/**
 * **导出 fence 用的就是 `expectTokenOf`**，不是另一份定义——这一点被验证过，别再拆开。
 *
 * 实现门第三轮曾报「workflow / workgroup 的导出 fence 漏了 ACL 漂移维度」（`version`
 * 只被内容写路径推进，`updateResourceAcl` 只推 `aclRevision` / `updatedAt`），我据此
 * 加了 `exportFenceTokenOf` 多带一维 `expectedAclRevision`。
 *
 * **实测推翻了这条**：包**不携带任何权属信息**（决策 4/12——带上只会诱导导入侧去
 * 「还原」一个在本实例根本不存在的主体）。于是把一个工作流从 private 改成 public
 * 之后再导出，产物**逐字节相同**、manifest 也相同。fence 放行它是对的：所见即所得
 * 的「所得」没有变。
 *
 * 那个改动的代价是真实的：它让六个前端导出入口全部 `package-invalid`（工作流/工作组
 * 只拿得到 `version`，拿不到 `aclRevision`），换来的是拦截一次**不改变任何产物**的
 * 漂移。这条留在这里，是为了让下一个看到同样"不一致"的人先问一句：**这一维会改变
 * 导出的字节吗？** 不会就别加。
 *
 * （agent / skill 的 fence 里有 `expectedAclRevision`，那是因为它们的 CAS token 本就
 * 是这个形态——`agent.ts` 的 mutation revision 是这两个——不是因为 ACL 影响导出。）
 */

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

/**
 * 包声明的 built-in 依赖里，本实例**没有**的那些。
 *
 * 判据与导入期 `resolveIdentityRef` 的 built-in 分支**必须一致**：同名 + `builtin = true`。
 * 只按名字查会把用户自建的同名资源当成内置件——那一行 owner 不是 `__system__`、
 * `builtin` 是 false，绑上去等于把别人的资源当框架件用。
 */
async function findMissingBuiltins(
  db: DbClient,
  declared: readonly { type: string; name: string }[],
): Promise<Array<{ type: string; name: string }>> {
  const missing: Array<{ type: string; name: string }> = []
  for (const want of declared) {
    // schema 已把 type 收窄到 agent | workflow，这里只是把它接回 ACL_TABLES 的键。
    if (want.type !== 'agent' && want.type !== 'workflow') {
      missing.push(want)
      continue
    }
    const table = ACL_TABLES[want.type]
    const rows = (await db
      .select()
      .from(table)
      .where(eq(table.name, want.name))) as unknown as Array<Record<string, unknown>>
    if (!rows.some((row) => row.builtin === true)) missing.push(want)
  }
  return missing
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

  // AC-9：包里声明的 built-in 依赖，**本实例必须都有**，而且必须在**预检**就报出来。
  //
  // 这些 built-in 不产 op、不入 entries，导入时按名字绑到对端自己 seed 的那一个。绑不上
  // 是一个**环境前提不满足**，不是数据冲突——用户能做的只有升级/修复对端实例，不是在
  // 这个包里改点什么。所以它必须出现在「要不要导入」这个决策之前。
  //
  // 在此之前它要到 commit 才由 `resolveIdentityRef` 抛 `bundle-builtin-missing`：用户
  // 已经逐条选完动作、填完凭据、点了提交，才被告知这个包在本实例根本装不了。
  const missingBuiltins = await findMissingBuiltins(db, pkg.manifest.builtins)
  if (missingBuiltins.length > 0) {
    throw new ValidationError(
      'package-builtin-missing',
      `this instance is missing ${missingBuiltins.length} framework built-in(s) required by the package: ${missingBuiltins
        .map((b) => `${b.type}/${b.name}`)
        .join(', ')}`,
      { missingBuiltins },
    )
  }

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
    // 所有写能力都走与 commit 共用的动态 oracle；workflow 的 script / code-host-call
    // author 轴也因此不会被 preview 漏掉。reuse 不写任何字节，只要求候选当前可见。
    const allowedActions: ImportAction[] = []
    if (missingImportPermissions(actor.permissions, op as BundleOp, 'new').length === 0) {
      allowedActions.push('new')
    }
    if (candidates.length > 0) allowedActions.push('reuse')
    if (
      candidates.some((c) => c.owned) &&
      missingImportPermissions(actor.permissions, op as BundleOp, 'overwrite').length === 0
    ) {
      allowedActions.push('overwrite')
    }
    const defaultAction: PreviewEntry['defaultAction'] = allowedActions.includes('reuse')
      ? 'reuse'
      : allowedActions.includes('new')
        ? 'new'
        : null

    entries.push({
      localSlug: slug,
      type,
      name,
      candidates,
      allowedActions,
      defaultAction,
      missingPermissions:
        defaultAction === null
          ? missingImportPermissions(actor.permissions, op as BundleOp, 'new')
          : [],
      // Name conflicts are owner-scoped for the resource types that enforce them. Using every
      // same-name row here would make a hidden private row observable as a `name-2` suggestion,
      // even though another owner's row cannot conflict with this actor's create.
      suggestedName: suggestName(
        name,
        new Set(
          rows.filter((row) => row.ownerUserId === actor.user.id).map((row) => String(row.name)),
        ),
      ),
      secretFields: pkg.manifest.secrets.filter(
        (secret) => secret.resourceType === type && secret.resourceName === name,
      ),
    })
  }

  const humanMembers = await collectHumanMemberSlots(db, pkg, actor.permissions.has('users:search'))

  const expiresAt = now + PREVIEW_TTL_MS
  const baseline = previewBaselineOf(entries)
  return {
    importId: opts.importId,
    root: pkg.manifest.root,
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
    secrets: pkg.manifest.secrets,
    requirements: pkg.manifest.requirements,
  }
}

/**
 * 包里的 human 成员 alias —— wire 层逐行保留，供 UI 展示组内寻址名。
 *
 * `username` 是源实例的标识，在这台机器上可能对应另一个人、或根本没有。所以平台
 * 不替用户猜：同名用户只作为 `suggestedUserId` 预填，最终由用户按
 * `(workgroupSlug, username)` 拍板。同一用户的多个 alias 在签名基线里合成一个槽。
 *
 * canonical 工作组要求 leader 必须是 agent。若包把 human alias 指成 leader，这不是
 * 一个可通过「必填 human 映射」修复的状态，预检直接拒绝；合法 human 槽均可跳过。
 */
async function collectHumanMemberSlots(
  db: DbClient,
  pkg: ParsedPackage,
  canSuggestUsers: boolean,
): Promise<HumanMemberSlot[]> {
  const slots: HumanMemberSlot[] = []
  const wanted = new Set<string>()
  const raw: Array<{ slug: string; m: BundleHumanMember }> = []

  for (const op of pkg.bundle.ops) {
    if (resourceTypeOfOp(op as BundleOp) !== 'workgroup') continue
    const slug = opSlug(op)
    if (slug === null) continue
    const payload = op.payload as {
      members?: unknown
      leaderDisplayName?: unknown
    }
    for (const member of Array.isArray(payload.members) ? payload.members : []) {
      const m = member as BundleHumanMember & { memberType?: string }
      if (m.memberType !== 'human') continue
      if (m.displayName === payload.leaderDisplayName) {
        throw new ValidationError(
          'package-invalid',
          `workgroup '${slug}' designates human member '${m.displayName}' as leader; leader must be an agent member`,
        )
      }
      wanted.add(m.username)
      raw.push({ slug, m })
    }
  }
  if (raw.length === 0) return slots

  const localByUsername = new Map<string, string>()
  // `suggestedUserId` is a user-directory lookup, not merely package metadata. PATs can reach
  // preview but can never carry the system-domain `users:search` point; querying/returning the
  // match here would turn guessed source usernames into an existence + internal UUID oracle.
  // Skip the lookup entirely when the actor lacks that point so hit/miss have the same result.
  if (canSuggestUsers) {
    const rows = await db
      .select({ id: users.id, username: users.username, status: users.status })
      .from(users)
      .where(inArray(users.username, [...wanted]))
    for (const u of rows) {
      // 停用的人不是可选映射目标——把成员绑到一个不能登录的主体上毫无意义。
      if (u.status === 'active') localByUsername.set(u.username, u.id)
    }
  }

  for (const { slug, m } of raw) {
    slots.push({
      workgroupSlug: slug,
      username: m.username,
      displayName: m.displayName,
      suggestedUserId: localByUsername.get(m.username) ?? null,
      // canonical schema 要求 leader 是 agent；合法 human 槽不会承担 leader 必填语义。
      required: false,
    })
  }
  return slots
}

/**
 * 展示层分组：保留全部 alias，同时把同一 `(workgroupSlug, username)` 的决定收成一条。
 * `suggestedUserId` 理论上由同一个 username 查询而恒等；这里取首个非 null，兼容旧数据。
 */
export function groupHumanMemberSlots(slots: readonly HumanMemberSlot[]): HumanMemberSlotGroup[] {
  const byWorkgroup = new Map<string, Map<string, HumanMemberSlotGroup>>()
  for (const slot of slots) {
    let byUsername = byWorkgroup.get(slot.workgroupSlug)
    if (byUsername === undefined) {
      byUsername = new Map()
      byWorkgroup.set(slot.workgroupSlug, byUsername)
    }
    const existing = byUsername.get(slot.username)
    if (existing === undefined) {
      byUsername.set(slot.username, {
        workgroupSlug: slot.workgroupSlug,
        username: slot.username,
        displayNames: [slot.displayName],
        suggestedUserId: slot.suggestedUserId,
        required: slot.required,
      })
      continue
    }
    if (!existing.displayNames.includes(slot.displayName)) {
      existing.displayNames.push(slot.displayName)
    }
    existing.required ||= slot.required
    if (existing.suggestedUserId === null && slot.suggestedUserId !== null) {
      existing.suggestedUserId = slot.suggestedUserId
    }
  }
  return [...byWorkgroup.values()]
    .flatMap((byUsername) => [...byUsername.values()])
    .sort((a, b) =>
      a.workgroupSlug === b.workgroupSlug
        ? a.username.localeCompare(b.username)
        : a.workgroupSlug.localeCompare(b.workgroupSlug),
    )
}

/** 旧 token 可能含重复键；commit 也必须用同一套 OR 归一化，不能让「最后一行赢」。 */
export function normalizeHumanMemberBaseline(
  entries: readonly HumanMemberBaselineEntry[],
): HumanMemberBaselineEntry[] {
  const byWorkgroup = new Map<string, Map<string, HumanMemberBaselineEntry>>()
  for (const entry of entries) {
    let byUsername = byWorkgroup.get(entry.workgroupSlug)
    if (byUsername === undefined) {
      byUsername = new Map()
      byWorkgroup.set(entry.workgroupSlug, byUsername)
    }
    const existing = byUsername.get(entry.username)
    if (existing === undefined) {
      byUsername.set(entry.username, { ...entry })
    } else {
      existing.required ||= entry.required
    }
  }
  return [...byWorkgroup.values()]
    .flatMap((byUsername) => [...byUsername.values()])
    .sort((a, b) =>
      a.workgroupSlug === b.workgroupSlug
        ? a.username.localeCompare(b.username)
        : a.workgroupSlug.localeCompare(b.workgroupSlug),
    )
}

export function humanMemberBaselineOf(
  slots: readonly HumanMemberSlot[],
): HumanMemberBaselineEntry[] {
  return normalizeHumanMemberBaseline(
    slots.map((s) => ({
      workgroupSlug: s.workgroupSlug,
      username: s.username,
      required: s.required,
    })),
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
