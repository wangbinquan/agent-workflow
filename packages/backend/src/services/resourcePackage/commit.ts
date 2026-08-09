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
import { canonicalJson, type AclResourceType, type BundleOp } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { resourceBundleApplies } from '@/db/schema'
import { ACL_TABLES } from '@/services/resourceAcl'
import { ConflictError, ValidationError } from '@/util/errors'
import { applyResourceBundle, type BundleApplyDeps } from '@/services/bundle/apply'
import type { BundleApplyProvider, BundleReceipt } from '@/services/bundle/provider'
import { opSlug, resourceTypeOfOp } from '@/services/bundle/provider'
import type { ParsedPackage } from './parse'
import { expectTokenOf, verifyPreviewToken, type ImportAction } from './preview'

export interface ImportDecision {
  localSlug: string
  action: ImportAction
  /** reuse / overwrite 时指向的本地行。 */
  targetId?: string
  /** new 时的最终名字（用户可改）。 */
  finalName?: string
}

export interface CommitPackageInput {
  pkg: ParsedPackage
  previewToken: string
  decisions: ImportDecision[]
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
  const bySlug = new Map(decisions.map((d) => [d.localSlug, d]))
  const externalOfSlug = new Map<string, string>()
  for (const d of decisions) {
    if ((d.action === 'reuse' || d.action === 'overwrite') && d.targetId !== undefined) {
      externalOfSlug.set(d.localSlug, d.targetId)
    }
  }

  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!value.startsWith('local:')) return value
      const slug = value.slice('local:'.length)
      const external = externalOfSlug.get(slug)
      return external === undefined ? value : `external:${external}`
    }
    if (Array.isArray(value)) return value.map(rewrite)
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]))
    }
    return value
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

    const payload = rewrite(op.payload) as Record<string, unknown>
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
    .where(eq(resourceBundleApplies.key, verified.importId))
    .get()

  // ③ 只有**首次** claim 才查 exp。
  if (existing === undefined && Date.now() > verified.expiresAt) {
    throw new ConflictError(
      'package-preview-expired',
      'this preview has expired; re-run the preview and confirm again',
    )
  }

  const baseline = new Map(verified.baseline.map((b) => [b.localSlug, b]))
  assertActionsAllowed(deps.db, actor, input.decisions, verified.baseline)
  const { ops } = translateDecisions(input.pkg, input.decisions, baseline)

  const provider = makePackageProvider(deps.db, actor, input, verified.importId, baseline)
  return applyResourceBundle(deps, {
    bundle: { ...input.pkg.bundle, ops } as typeof input.pkg.bundle,
    provider,
  })
}

/**
 * `allowedActions` **服务端重算**——不信客户端回传的那一份。
 * 归属规则：「只能覆盖自己的，别人的不给覆盖选项」。
 */
function assertActionsAllowed(
  db: DbClient,
  actor: Actor,
  decisions: readonly ImportDecision[],
  baseline: readonly {
    localSlug: string
    candidateIds: string[]
    allowedActions: ImportAction[]
  }[],
): void {
  const bySlug = new Map(baseline.map((b) => [b.localSlug, b]))
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
    if (d.action !== 'new') {
      if (d.targetId === undefined || !entry.candidateIds.includes(d.targetId)) {
        throw new ValidationError(
          'package-decision-unconfirmed',
          `target '${d.targetId ?? '<none>'}' for '${d.localSlug}' was not among the confirmed candidates`,
        )
      }
    }
  }
  void db
  void actor
}

function makePackageProvider(
  db: DbClient,
  actor: Actor,
  input: CommitPackageInput,
  importId: string,
  baseline: ReadonlyMap<string, { expectByCandidateId: Record<string, unknown> }>,
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
    resolveExternal: async (ref, expectType) => {
      const id = ref.startsWith('external:') ? ref.slice('external:'.length) : ref
      const table = ACL_TABLES[expectType]
      const row = db.select({ id: table.id }).from(table).where(eq(table.id, id)).get()
      if (row === undefined) {
        throw new ValidationError(
          'package-external-unresolved',
          `referenced ${expectType} '${id}' does not exist on this instance`,
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
        const type = typeOfSlug(input, d.localSlug)
        if (type === null) continue
        const table = ACL_TABLES[type]
        const row = tx.select().from(table).where(eq(table.id, d.targetId)).get() as
          | Record<string, unknown>
          | undefined
        if (row === undefined) {
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
  }
}

function typeOfSlug(input: CommitPackageInput, slug: string): AclResourceType | null {
  for (const op of input.pkg.bundle.ops) {
    if (opSlug(op) === slug) return resourceTypeOfOp(op)
  }
  return null
}
