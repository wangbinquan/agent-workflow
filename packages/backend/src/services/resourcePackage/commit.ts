// RFC-271 T27/T28 —— 资源包导入的**决策翻译层**：把用户在 preview 上作出的决定
// （new / reuse / overwrite + 改名）翻译成 apply 引擎吃的 `ResourceBundle`。
//
// 这一层是 **provider 中立**的纯函数：只吃已解析的包与决策，不碰数据库、不知道事务。
// RFC-359（apply 引擎合一，plan §5dv）把它从 `platform/persistence/sqlite/legacyResourcePackageCommit.ts`
// 搬到这里——那个文件的其余部分（SQLite 专属的 `commitResourcePackage` 编排）随合一退役，
// 而这几个判据两个 provider 共用，本来就不该住在一个按引擎命名的文件里。
//
// **承重的几条**（原文件头注，规则仍然成立，只是执行者换成了统一 apply 引擎）：
//
//   · 用户提交的 `(target, expect)` 必须是**签名基线里的一对**——不是「expect 形状对就行」。
//     这挡住「包没变、把 expect 换成用户从未确认过的那一版」那一招。
//   · `allowedActions` **服务端重算**，不信客户端回传。
//   · `reuse` 不产 op，但所有指向它的引用都要改写成 `external:<targetId>`；`overwrite` 同样改写
//     （只写 reuse 那一半会让别的资源仍指向一个本次并不会创建的 local slug）。
//
// 幂等顺序那两条（duplicate lookup 先于过期检查、只有首次 claim 才查 `exp`）跟着编排走，
// 现在的执行者与判据在 `platform/persistence/postgresqlResourcePackageAtomicApply.ts` 与
// `tests/rfc359-w14-unified-apply-journal-replay.test.ts`。

import type { Actor } from '@/auth/actor'
import {
  BundleSchema,
  type BundleOp,
  type BundleResourceType,
  type ResourceBundle,
} from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'
import { opSlug, resourceTypeOfOp } from '@/services/bundle/provider'
import { missingImportPermissions } from '@/services/resourcePackage/importPermissions'
import type { ParsedPackage } from '@/services/resourcePackage/parse'
import type {
  PackageSecretInput,
  PackageSecretProjection,
} from '@/services/resourcePackage/secretInputs'
import type { ImportAction } from '@/services/resourcePackage/preview'

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

export function materializedSecretProjections(
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
export function assertActionsAllowed(
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
export function translatedBundle(
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

/** decision 已经由 `translateDecisions` 校验完整/唯一；这里只选会真实写 roster 的组。 */
export function materializedWorkgroupSlugs(
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

export function typeOfSlug(pkg: ParsedPackage, slug: string): BundleResourceType | null {
  for (const op of pkg.bundle.ops) {
    if (opSlug(op) === slug) return resourceTypeOfOp(op)
  }
  return null
}
