// RFC-271 T27/T28 —— 导入提交：验签 → 幂等 → 翻译成 `ResourceBundle` → 调引擎。
//
// **步骤顺序是承重的**（design §5）：
//
//   ① 验签（previewToken）
//   ② **duplicate lookup 先于过期检查**
//   ③ 仅首次 claim 才查 `exp`
//
// ②③ 反过来写的话，「commit 成功但响应丢失、用户过了有效期再重试」会撞在过期检查
// 上而**进不了 replay**——用户看到一个错误，而资源其实已经建好了。幂等的意义正在于
// 让这种情形能安全重放。
//
// 另外两条同样是「顺序/归属」性质的：
//   · 用户提交的 `(target, expect)` 必须是**签名基线里的一对**——不是「expect 形状
//     对就行」。这挡住「包没变、把 expect 换成用户从未确认过的那一版」那一招。
//   · `allowedActions` **服务端重算**，不信客户端回传。

import type { SecretBox } from '@/auth/secretBox'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  BundleSchema,
  canonicalJson,
  decodeBundleIdentityRef,
  type BundleResourceType,
  type BundleOp,
  type ResourceBundle,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import { resourceBundleApplies, users } from '@/db/schema'
import { canViewResource, canViewResourceInTx } from '@/services/resourceAcl'
import {
  findSqliteBuiltinResource,
  findSqliteBuiltinResourceInTx,
  getSqlitePackageResourceRow,
  getSqlitePackageResourceRowInTx,
} from '@/modules/resource-catalog/infrastructure/sqlitePackageResourceRows'
import { asPackageResourceKind } from '@/modules/resource-catalog/public/types'
import { ConflictError, ValidationError } from '@/util/errors'
import {
  applyResourceBundle,
  replayBundleApplyOutcome,
  type BundleApplyDeps,
} from '@/services/bundle/apply'
import type { BundleApplyProvider, BundleReceipt } from '@/services/bundle/provider'
import { opSlug, resourceTypeOfOp } from '@/services/bundle/provider'
import { missingImportPermissions } from './importPermissions'
import type { ParsedPackage } from './parse'
import {
  applyPackageSecretInputs,
  type PackageSecretInput,
  type PackageSecretProjection,
} from './secretInputs'
import {
  expectTokenOf,
  normalizeHumanMemberBaseline,
  verifyPreviewToken,
  type HumanMemberBaselineEntry,
  type ImportAction,
} from './preview'

export interface ImportDecision {
  localSlug: string
  action: ImportAction
  /** reuse / overwrite 时指向的本地行。 */
  targetId?: string
  /** new 时的最终名字（用户可改）。 */
  finalName?: string
}

/** 一个 human 成员槽的落地决定：绑到哪个本地用户，或 `null` = 不加入该成员。 */
export interface HumanMemberMapping {
  workgroupSlug: string
  username: string
  userId?: string | null
}

/**
 * human 成员映射表的键。**必须只有这一个定义**：解析端与 provider 端各拼一次的
 * 写法已经出过一次事故 —— 一侧的「空格」实际敲成了 U+0000，另一侧是真空格，于是
 * 查表永远落空、human 成员被静默当成「用户选了不加入」而整条剔除，全程零报错。
 * `#` 是显式可见字符；slug 与 username 都不含它。
 */
export function humanMemberKey(workgroupSlug: string, username: string): string {
  return `${workgroupSlug}#${username}`
}

export interface CommitPackageInput {
  pkg: ParsedPackage
  previewToken: string
  decisions: ImportDecision[]
  /** 只为 new / overwrite 的工作组给出；同一 `(workgroupSlug, username)` 一条。 */
  humanMemberMappings?: HumanMemberMapping[]
  /** Manifest-fenced credential values. Empty means intentionally omit. */
  secretInputs?: PackageSecretInput[]
}

export const PACKAGE_IDEMPOTENCY_SCOPE = 'package'

/**
 * 翻译：decisions + 包内 op → 引擎吃的 `ResourceBundle`。
 *
 * · `reuse`     不产 op，但**所有指向它的引用都要改写成 `external:<targetId>`**
 * · `overwrite` create → update + expect，引用**同样**改写成 `external:`
 *               （v3 只写了 reuse 那一半——漏掉 overwrite 会让别的资源仍指向一个
 *               本次并不会创建的 local slug）
 * · `new`       保留 create，可改名
 */
export function translateDecisions(
  pkg: ParsedPackage,
  decisions: readonly ImportDecision[],
  baseline: ReadonlyMap<
    string,
    { candidateIds: string[]; expectByCandidateId: Record<string, unknown> }
  >,
): { ops: BundleOp[]; externalOfSlug: Map<string, string> } {
  // ⚠️ 同一 slug 给两条互相矛盾的 decision 必须**拒绝**，不能靠「后写覆盖」收场：
  // `bySlug` 是后写赢，而 `externalOfSlug` 是遍历原数组建的，早先那条 reuse 会留下。
  // 于是 `MCP reuse(old)` + `MCP new` 会同时新建 MCP **并**让新 agent 指向旧 MCP。
  const seenSlugs = new Set<string>()
  for (const d of decisions) {
    if (seenSlugs.has(d.localSlug)) {
      throw new ValidationError(
        'package-decision-duplicate',
        `entry '${d.localSlug}' has more than one decision`,
      )
    }
    seenSlugs.add(d.localSlug)
  }

  const bySlug = new Map(decisions.map((d) => [d.localSlug, d]))
  const externalOfSlug = new Map<string, string>()
  for (const d of decisions) {
    if ((d.action === 'reuse' || d.action === 'overwrite') && d.targetId !== undefined) {
      externalOfSlug.set(d.localSlug, d.targetId)
    }
  }

  const rewriteRef = (value: unknown): unknown => {
    if (typeof value !== 'string' || !value.startsWith('local:')) return value
    const slug = value.slice('local:'.length)
    const external = externalOfSlug.get(slug)
    return external === undefined ? value : `external:${external}`
  }

  /**
   * 只改 bundle contract 明确定义的引用槽。payload 里还有大量自由数据
   * （frontmatter/options/env/body/description）；盲递归会把一个恰好写成
   * `local:foo` 的示例文本当成引用，产生无提示的数据腐化。
   */
  const rewritePayloadRefs = (op: BundleOp): Record<string, unknown> => {
    const payload = { ...(op.payload as Record<string, unknown>) }
    switch (op.kind) {
      case 'agent-create':
      case 'agent-update':
        for (const key of ['skills', 'dependsOn', 'mcp', 'plugins'] as const) {
          if (Array.isArray(payload[key])) payload[key] = payload[key].map(rewriteRef)
        }
        return payload
      // RFC-304 T17a → RFC-309 — a template's agent reference slots.
      //
      // Without this arm the refs stay `local:<slug>` even when the operator
      // chose to REUSE the destination's own agent: that slug then
      // names no op in the applied bundle, and lowering fails with
      // "bundle ref 'local:agent-…' does not name any op in this bundle" — a
      // message about the package, for a decision the operator made.
      case 'capability-binding-create':
      case 'capability-binding-update':
      case 'capability-template-create':
      case 'capability-template-update': {
        // Pre-merge binding packages also carry a framework reference. New
        // one-row templates do not, but both forms carry agent refs.
        if (typeof payload.frameworkRef === 'string') {
          payload.frameworkRef = rewriteRef(payload.frameworkRef)
        }
        const slots = payload.agentBySlot
        if (typeof slots === 'object' && slots !== null && !Array.isArray(slots)) {
          payload.agentBySlot = Object.fromEntries(
            Object.entries(slots as Record<string, unknown>).map(([slot, ref]) => [
              slot,
              rewriteRef(ref),
            ]),
          )
        }
        return payload
      }
      case 'workgroup-create':
      case 'workgroup-update':
        if (Array.isArray(payload.members)) {
          payload.members = payload.members.map((raw) => {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
            const member = raw as Record<string, unknown>
            return member.memberType === 'agent'
              ? { ...member, agentRef: rewriteRef(member.agentRef) }
              : member
          })
        }
        return payload
      case 'workflow-create':
      case 'workflow-update': {
        const definition = payload.definition
        if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
          return payload
        }
        const cloned = { ...(definition as Record<string, unknown>) }
        if (Array.isArray(cloned.nodes)) {
          cloned.nodes = cloned.nodes.map((raw) => {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
            const node = { ...(raw as Record<string, unknown>) }
            for (const key of ['agentRef', 'workflowRef', 'workgroupRef'] as const) {
              if (node[key] !== undefined) node[key] = rewriteRef(node[key])
            }
            return node
          })
        }
        payload.definition = cloned
        return payload
      }
      default:
        return payload
    }
  }

  const ops: BundleOp[] = []
  for (const op of pkg.bundle.ops) {
    const slug = opSlug(op)
    if (slug === null) continue
    const decision = bySlug.get(slug)
    if (decision === undefined) {
      throw new ValidationError(
        'package-decision-missing',
        `no decision for package entry '${slug}'`,
      )
    }
    if (decision.action === 'reuse') continue // 不产 op

    const payload = rewritePayloadRefs(op)
    if (decision.action === 'new') {
      ops.push({
        ...op,
        payload:
          decision.finalName === undefined ? payload : { ...payload, name: decision.finalName },
      } as BundleOp)
      continue
    }
    // overwrite
    const targetId = decision.targetId
    if (targetId === undefined) {
      throw new ValidationError('package-decision-invalid', `overwrite of '${slug}' needs a target`)
    }
    const entry = baseline.get(slug)
    const expect = entry?.expectByCandidateId[targetId]
    if (expect === undefined) {
      // 用户提交的 (target, expect) 必须是**签名基线里的一对**。
      throw new ValidationError(
        'package-decision-unconfirmed',
        `overwrite target '${targetId}' for '${slug}' was not part of the confirmed preview`,
      )
    }
    ops.push({
      opId: op.opId,
      kind: op.kind.replace('-create', '-update'),
      target: `external:${targetId}`,
      expect,
      payload,
    } as unknown as BundleOp)
  }
  return { ops, externalOfSlug }
}

export interface CommitPackageDeps extends BundleApplyDeps {
  box: SecretBox
}

export async function commitResourcePackage(
  deps: CommitPackageDeps,
  actor: Actor,
  input: CommitPackageInput,
): Promise<BundleReceipt> {
  // ① 验签。
  const verified = verifyPreviewToken(deps.box, input.previewToken)
  if (verified.actorUserId !== actor.user.id) {
    throw new ValidationError(
      'package-preview-token-invalid',
      'preview token belongs to another user',
    )
  }
  if (verified.packageDigest !== input.pkg.digest) {
    throw new ValidationError(
      'package-preview-token-invalid',
      'the uploaded package is not the one that was previewed',
    )
  }

  // ② duplicate lookup **先于** exp 检查。顺序反了，「成功但响应丢失、过期后重试」
  //    会撞在过期上而进不了 replay —— 用户看到错误，资源其实已经建好了。
  const existing = deps.db
    .select()
    .from(resourceBundleApplies)
    .where(
      and(
        eq(resourceBundleApplies.scope, PACKAGE_IDEMPOTENCY_SCOPE),
        eq(resourceBundleApplies.key, verified.importId),
      ),
    )
    .get()

  // 认证信封与包摘要已经验证；从这一行起，重放不得再依赖任何会变化的状态。
  // 权限、human 用户、候选可见性乃至 token 有效期都可能在首次成功后改变。
  if (existing !== undefined) return replayBundleApplyOutcome(existing)

  // ③ 只有**首次** claim 才查 exp。
  if (Date.now() > verified.expiresAt) {
    throw new ConflictError(
      'package-preview-expired',
      'this preview has expired; re-run the preview and confirm again',
    )
  }

  const baseline = new Map(verified.baseline.map((b) => [b.localSlug, b]))
  assertActionsAllowed(actor, input.pkg, input.decisions, verified.baseline)
  // 先翻译以锁住 decision 完整性/唯一性；human 映射只属于真正会 materialize 的
  // workgroup op，reuse 不产 op，因而既不要求映射也不消费客户端附带的映射。
  const { ops, externalOfSlug } = translateDecisions(input.pkg, input.decisions, baseline)
  const translated = translatedBundle(input.pkg, ops, externalOfSlug)
  const secretProjection = applyPackageSecretInputs(
    translated,
    input.pkg.manifest.secrets,
    input.secretInputs ?? [],
    materializedSecretProjections(input.pkg, input.decisions, translated),
  )
  const bundle = secretProjection.bundle
  const humanMemberUserIds = resolveHumanMemberMappings(
    deps.db,
    verified.humanBaseline ?? [],
    materializedWorkgroupSlugs(input.pkg, input.decisions),
    input.humanMemberMappings ?? [],
  )

  const provider = makePackageProvider(
    deps.db,
    actor,
    input,
    verified.importId,
    baseline,
    humanMemberUserIds,
    secretProjection.skippedRefs,
  )
  return applyResourceBundle(deps, {
    bundle,
    provider,
  })
}

function materializedSecretProjections(
  pkg: ParsedPackage,
  decisions: readonly ImportDecision[],
  translated: ResourceBundle,
): PackageSecretProjection[] {
  const decisionBySlug = new Map(decisions.map((decision) => [decision.localSlug, decision]))
  const out: PackageSecretProjection[] = []
  for (const secret of pkg.manifest.secrets) {
    const matches = pkg.bundle.ops.filter(
      (op) =>
        resourceTypeOfOp(op) === secret.resourceType &&
        (op.payload as { name?: unknown }).name === secret.resourceName,
    )
    if (matches.length !== 1) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `manifest secret '${secret.resourceType}/${secret.resourceName}:${secret.field}' does not identify exactly one package resource`,
      )
    }
    const sourceOp = matches[0]!
    const slug = opSlug(sourceOp)
    const decision = slug === null ? undefined : decisionBySlug.get(slug)
    if (slug === null || decision === undefined) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `manifest secret '${secret.resourceType}/${secret.resourceName}:${secret.field}' has no confirmed resource decision`,
      )
    }
    if (decision.action === 'reuse') continue
    const targetOp = translated.ops.find((op) => op.opId === sourceOp.opId)
    const targetName = (targetOp?.payload as { name?: unknown } | undefined)?.name
    if (typeof targetName !== 'string' || targetName.length === 0) {
      throw new ValidationError(
        'package-secret-manifest-invalid',
        `manifest secret '${secret.resourceType}/${secret.resourceName}:${secret.field}' has no materialized target`,
      )
    }
    out.push({ source: secret, target: { ...secret, resourceName: targetName } })
  }
  return out
}

/**
 * `allowedActions` **服务端重算**——不信客户端回传的那一份。
 * 归属规则：「只能覆盖自己的，别人的不给覆盖选项」。
 */
function assertActionsAllowed(
  actor: Actor,
  pkg: ParsedPackage,
  decisions: readonly ImportDecision[],
  baseline: readonly {
    localSlug: string
    candidateIds: string[]
    allowedActions: ImportAction[]
  }[],
): void {
  const bySlug = new Map(baseline.map((b) => [b.localSlug, b]))
  const opBySlug = new Map(
    pkg.bundle.ops.flatMap((op) => {
      const slug = opSlug(op)
      return slug === null ? [] : ([[slug, op]] as const)
    }),
  )
  for (const d of decisions) {
    const entry = bySlug.get(d.localSlug)
    if (entry === undefined) {
      throw new ValidationError(
        'package-decision-unconfirmed',
        `entry '${d.localSlug}' was not part of the confirmed preview`,
      )
    }
    if (!entry.allowedActions.includes(d.action)) {
      throw new ValidationError(
        'package-decision-not-allowed',
        `action '${d.action}' is not available for '${d.localSlug}'`,
      )
    }
    const op = opBySlug.get(d.localSlug)
    if (op === undefined) {
      throw new ValidationError(
        'package-decision-unconfirmed',
        `entry '${d.localSlug}' does not identify a package resource`,
      )
    }
    const missingPermissions = missingImportPermissions(actor.permissions, op, d.action)
    if (missingPermissions.length > 0) {
      throw new ValidationError(
        'package-write-forbidden',
        `current actor is missing permission(s) required to ${d.action} '${d.localSlug}'`,
        { missingPermissions },
      )
    }
    if (d.action !== 'new') {
      if (d.targetId === undefined || !entry.candidateIds.includes(d.targetId)) {
        throw new ValidationError(
          'package-decision-unconfirmed',
          `target '${d.targetId ?? '<none>'}' for '${d.localSlug}' was not among the confirmed candidates`,
        )
      }
    }
  }
}

/**
 * Decisions can turn the package root into an existing row. Keep the root on the same translated
 * identity surface as every nested ref, then run the canonical schema instead of casting around
 * its dangling-root checks.
 */
function translatedBundle(
  pkg: ParsedPackage,
  ops: BundleOp[],
  externalOfSlug: ReadonlyMap<string, string>,
): ResourceBundle {
  const rootRef = pkg.bundle.rootRef
  if (rootRef === undefined) {
    throw new ValidationError('package-invalid', 'a config package must have a root')
  }
  // built-in 根不产 op/decision；保留自描述引用，finalizeInTx 会在目标实例上按
  // `(type,name,builtin=true)` 解析并写入 receipt。此前 export→parse 已放行这里却仍
  // 硬拒，导致一个由本系统导出的合法包永远无法导入。
  if (rootRef.startsWith('builtin:')) {
    return BundleSchema.parse({ ...pkg.bundle, ops })
  }
  if (!rootRef.startsWith('local:')) {
    throw new ValidationError(
      'package-invalid',
      'a config package must have a local or builtin root',
    )
  }
  const rootSlug = rootRef.slice('local:'.length)
  const externalRoot = externalOfSlug.get(rootSlug)
  if (externalRoot === undefined) {
    return BundleSchema.parse({ ...pkg.bundle, ops })
  }
  const rootType = typeOfSlug(pkg, rootSlug)
  if (rootType === null) {
    throw new ValidationError('package-invalid', `package root '${rootSlug}' has no resource op`)
  }
  return BundleSchema.parse({
    ...pkg.bundle,
    ops,
    rootRef: `external:${externalRoot}`,
    rootType,
  })
}

/**
 * human 成员映射：`(workgroupSlug, username)` → 本地 user id（或 null = 不加入）。
 *
 * 三条判据，缺一不可（仅针对 decision 为 new / overwrite 的工作组）：
 *  ① 每个**会落地且在签名基线里**的槽都必须给出决定；reuse 不要求、不消费；
 *  ② 给的槽必须在基线里——否则客户端可以凭空插入一个成员；
 *  ③ 旧 token 中 OR 后的 `required` 槽不能映射成 null。当前 canonical schema 只允许
 *     agent 当 leader，因此新 preview 不再产生 required human 槽；保留此分支兼容 TTL
 *     内已经签出的 token。
 *
 * 目标用户必须存在且 active：绑到一个不能登录的主体上没有意义，而绑到一个不存在的
 * id 上会在 `workgroup_members` 里留一条永远解析不出人的行。
 */
function resolveHumanMemberMappings(
  db: DbClient,
  humanBaseline: readonly HumanMemberBaselineEntry[],
  materializedWorkgroups: ReadonlySet<string>,
  mappings: readonly HumanMemberMapping[],
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  // 旧 preview 可能逐 alias 签出重复 tuple；按 key 去重并 OR required，不能后写覆盖。
  const confirmed = new Map(
    normalizeHumanMemberBaseline(humanBaseline).map((b) => [
      humanMemberKey(b.workgroupSlug, b.username),
      b,
    ]),
  )
  const wanted = new Map(
    [...confirmed].filter(([, slot]) => materializedWorkgroups.has(slot.workgroupSlug)),
  )
  const given = new Map<string, HumanMemberMapping>()
  for (const m of mappings) {
    const key = humanMemberKey(m.workgroupSlug, m.username)
    if (!confirmed.has(key)) {
      throw new ValidationError(
        'package-human-mapping-unconfirmed',
        `member '${m.username}' of '${m.workgroupSlug}' was not part of the confirmed preview`,
      )
    }
    // 确认过但最终选择 reuse 的工作组不会写 roster；这条映射完全不消费，连目标用户
    // 是否 active 都不查询，避免把无关的旧计划字段变成 reuse 的提交门槛。
    if (!materializedWorkgroups.has(m.workgroupSlug)) continue
    if (given.has(key)) {
      throw new ValidationError(
        'package-human-mapping-duplicate',
        `member '${m.username}' of '${m.workgroupSlug}' has more than one mapping`,
      )
    }
    given.set(key, m)
  }

  for (const [key, slot] of wanted) {
    const mapping = given.get(key)
    if (mapping === undefined) {
      throw new ValidationError(
        'package-human-mapping-missing',
        `no mapping for member '${slot.username}' of '${slot.workgroupSlug}'`,
      )
    }
    const userId = mapping.userId ?? null
    if (userId === null) {
      if (slot.required) {
        throw new ValidationError(
          'package-human-mapping-required',
          `member '${slot.username}' of '${slot.workgroupSlug}' was confirmed as required and cannot be skipped`,
        )
      }
      out.set(key, null)
      continue
    }
    const row = db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.id, userId))
      .get()
    if (row === undefined || row.status !== 'active') {
      throw new ValidationError(
        'package-human-mapping-invalid',
        `mapping target for '${slot.username}' is not an active user`,
      )
    }
    out.set(key, userId)
  }
  return out
}

/** decision 已经由 `translateDecisions` 校验完整/唯一；这里只选会真实写 roster 的组。 */
function materializedWorkgroupSlugs(
  pkg: ParsedPackage,
  decisions: readonly ImportDecision[],
): Set<string> {
  const actionBySlug = new Map(decisions.map((d) => [d.localSlug, d.action]))
  const out = new Set<string>()
  for (const op of pkg.bundle.ops) {
    if (resourceTypeOfOp(op) !== 'workgroup') continue
    const slug = opSlug(op)
    if (slug === null) continue
    const action = actionBySlug.get(slug)
    if (action === 'new' || action === 'overwrite') out.add(slug)
  }
  return out
}

function makePackageProvider(
  db: DbClient,
  actor: Actor,
  input: CommitPackageInput,
  importId: string,
  baseline: ReadonlyMap<string, { expectByCandidateId: Record<string, unknown> }>,
  humanMemberUserIds: ReadonlyMap<string, string | null>,
  skippedSecrets: readonly { resourceType: string; resourceName: string; field: string }[],
): BundleApplyProvider {
  // 串行键按**目标资源集合**，不是常量 scope（I1）：拿 `'package'` 当串行键，
  // Alice 一个慢 npm 安装会堵死 Bob 完全无关的纯 agent 包。
  const targets = input.decisions
    .map((d) => d.targetId ?? d.localSlug)
    .sort()
    .join(',')
  return {
    idempotencyKey: { scope: PACKAGE_IDEMPOTENCY_SCOPE, key: importId },
    serializationKey: `package:${actor.user.id}:${targets}`,
    actor,
    // 仅 new / overwrite 工作组会带进来的 human 映射（已校验签名基线与 active 状态）。
    // 包里的 built-in 没有 create op（导入侧自动忽略）；引用按**名字**绑到本实例
    // 自己 seed 的那一个。只认 `builtin = true` 的行——同名的普通资源不算数，
    // 否则「忽略 built-in」会退化成「绑到某个碰巧同名的用户资源」。
    resolveBuiltin: async (type, name) => {
      // 第二道防线（refs.ts 已按槽类型校验过声明类型）：`builtin` 列只在
      // agents / workflows / capability_templates 三张表上，对没有该列的类型拼
      // `eq(table.builtin, true)` 会让 drizzle 生成非法 SQL ⇒ 500 而不是 4xx。
      // 这里直接判「没有 built-in」，交给调用点 fail closed。
      //
      // RFC-317 T66 —— capability_template **有列但没有任何写 true 的路径**
      // （全仓零 `builtin: true` 写点），因此今天这条早退不会漏掉任何真实的
      // built-in。等哪天真的 seed 了 built-in 能力模板，这里必须一起放行，
      // 否则包里的 `builtin:capability_template/...` 引用会 fail closed 到
      // 「本实例没有同名 built-in」——这正是原注释「只有两张表有列」所掩盖的
      // 那一步。
      if (type !== 'agent' && type !== 'workflow') return null
      const row = await findSqliteBuiltinResource(db, type, name)
      return row?.id ?? null
    },
    resolveHumanMember: (workgroupSlug, username) =>
      humanMemberUserIds.get(humanMemberKey(workgroupSlug, username)) ?? null,
    resolveExternal: async (ref, expectType) => {
      const id = ref.startsWith('external:') ? ref.slice('external:'.length) : ref
      const packageType = asPackageResourceKind(expectType)
      const row =
        packageType === null ? undefined : await getSqlitePackageResourceRow(db, packageType, id)
      // Missing and hidden must be byte-for-byte the same refusal. Otherwise a hand-built
      // package carrying `external:<id>` can distinguish a private row from an absent one before
      // the canonical write kernel reaches its own reference fence.
      if (row === undefined || !(await canViewResource(db, actor, expectType, row as never))) {
        throw new ValidationError(
          'package-external-unresolved',
          `referenced ${expectType} '${id}' is not available on this instance`,
        )
      }
      return id
    },
    readSkillFile: (ref) => {
      const bytes = input.pkg.files.get(ref)
      if (bytes === undefined) {
        throw new ValidationError('package-invalid', `package does not contain skill file '${ref}'`)
      }
      return bytes
    },
    // ⚠️ **必须实现**：全 reuse 的包一个 op 都没有，若这里留空则完全免检——
    // 用户确认的是「复用这几行」，而 pre-stage 窗口里它们可能已经变了。
    revalidateInTx: (tx) => {
      for (const d of input.decisions) {
        if (d.action !== 'reuse' && d.action !== 'overwrite') continue
        if (d.targetId === undefined) continue
        const expect = baseline.get(d.localSlug)?.expectByCandidateId[d.targetId]
        if (expect === undefined) continue
        const type = typeOfSlug(input.pkg, d.localSlug)
        if (type === null) continue
        const row = getSqlitePackageResourceRowInTx(tx, type, d.targetId)
        if (row === undefined || !canViewResourceInTx(tx, actor, type, row as never)) {
          throw new ConflictError(
            'package-selected-target-gone',
            `the ${type} you chose to reuse is no longer available`,
          )
        }
        // 用**同一个** `expectTokenOf` 重算，与用户确认过的那份逐字比对。
        // overwrite 的内容 CAS 由各 commit 内核在本事务里做；这里真正兜住的是
        // **reuse** —— 它不产 op，没有任何内核会替它把关，而用户确认的正是
        // 「复用**这一版**」。
        if (canonicalJson(expectTokenOf(type, row)) !== canonicalJson(expect)) {
          throw new ConflictError(
            'package-selected-target-changed',
            `the ${type} you chose to reuse changed since the preview; re-run the preview`,
          )
        }
      }
    },
    finalizeInTx: (tx, receipt) => {
      if (skippedSecrets.length > 0) receipt.skippedSecrets = [...skippedSecrets]
      const rootRef = input.pkg.bundle.rootRef
      if (rootRef === undefined) {
        throw new ValidationError('package-invalid', 'a config package must have a root')
      }
      if (rootRef.startsWith('builtin:')) {
        const ref = decodeBundleIdentityRef(rootRef)
        if (ref?.k !== 'builtin') {
          throw new ValidationError('package-invalid', `invalid builtin root '${rootRef}'`)
        }
        const row =
          ref.type === 'agent' || ref.type === 'workflow'
            ? findSqliteBuiltinResourceInTx(tx, ref.type, ref.name)
            : undefined
        if (row === undefined) {
          // 同名普通资源不能充当 built-in；这一条件与嵌套引用的 resolveBuiltin 完全
          // 相同，并且在 big tx 里复核，避免 preview 后环境前提漂移。
          throw new ValidationError(
            'bundle-builtin-missing',
            `this instance has no builtin ${ref.type} named '${ref.name}'`,
          )
        }
        receipt.root = {
          resourceType: ref.type,
          resourceId: row.id,
          name: row.name,
          action: 'reuse',
        }
        return
      }
      if (!rootRef.startsWith('local:')) {
        throw new ValidationError(
          'package-invalid',
          'a config package must have a local or builtin root',
        )
      }
      const rootSlug = rootRef.slice('local:'.length)
      const rootOp = input.pkg.bundle.ops.find((op) => opSlug(op) === rootSlug)
      const rootDecision = input.decisions.find((decision) => decision.localSlug === rootSlug)
      if (rootOp === undefined || rootDecision === undefined) {
        throw new ValidationError(
          'package-root-unresolved',
          `package root '${rootSlug}' has no confirmed decision`,
        )
      }
      const resourceType = resourceTypeOfOp(rootOp)
      if (rootDecision.action === 'reuse') {
        const resourceId = rootDecision.targetId
        if (resourceId === undefined) {
          throw new ValidationError(
            'package-root-unresolved',
            `reuse decision for root '${rootSlug}' has no target`,
          )
        }
        const row = getSqlitePackageResourceRowInTx(tx, resourceType, resourceId) as
          | { id: string; name: string }
          | undefined
        if (row === undefined) {
          throw new ConflictError(
            'package-selected-target-gone',
            `the ${resourceType} you chose to reuse is no longer available`,
          )
        }
        receipt.root = {
          resourceType,
          resourceId: row.id,
          name: row.name,
          action: 'reuse',
        }
        return
      }

      const applied = receipt.applied.find((entry) => entry.opId === rootOp.opId)
      if (applied === undefined) {
        throw new ValidationError(
          'package-root-unresolved',
          `package root '${rootSlug}' was not applied`,
        )
      }
      receipt.root = {
        resourceType,
        resourceId: applied.resourceId,
        name: applied.name,
        action: applied.action,
      }
    },
  }
}

function typeOfSlug(pkg: ParsedPackage, slug: string): BundleResourceType | null {
  for (const op of pkg.bundle.ops) {
    if (opSlug(op) === slug) return resourceTypeOfOp(op)
  }
  return null
}
