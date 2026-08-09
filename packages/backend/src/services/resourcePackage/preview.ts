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

import { eq } from 'drizzle-orm'
import type { SecretBox } from '@/auth/secretBox'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { canonicalJson, type AclResourceType, type BundleOp } from '@agent-workflow/shared'
import { ACL_TABLES, isVisibleRow, listGrantedResourceIds } from '@/services/resourceAcl'
import { ValidationError } from '@/util/errors'
import { mcpOperationConfigHashOf } from '@/services/mcpOperationRevision'
import { pluginOperationConfigHashOf } from '@/services/pluginOperationRevision'
import { resourceTypeOfOp, opSlug } from '@/services/bundle/provider'
import type { ParsedPackage } from './parse'

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
  /** 建议的新名字（`new` 时用，避开自己已占用的名字）。 */
  suggestedName: string
}

export interface PackagePreview {
  importId: string
  entries: PreviewEntry[]
  previewToken: string
  expiresAt: number
  /** 需要重新填写的凭据字段（来自 manifest，只有位置）。 */
  secrets: unknown[]
  requirements: unknown
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
    const allowedActions: ImportAction[] = ['new']
    if (candidates.length > 0) allowedActions.push('reuse')
    if (candidates.some((c) => c.owned)) allowedActions.push('overwrite')

    entries.push({
      localSlug: slug,
      type,
      name,
      candidates,
      allowedActions,
      suggestedName: suggestName(name, new Set(rows.map((r) => String(r.name)))),
    })
  }

  const expiresAt = now + PREVIEW_TTL_MS
  const baseline = previewBaselineOf(entries)
  return {
    importId: opts.importId,
    entries,
    previewToken: signPreviewToken(opts.box, {
      importId: opts.importId,
      actorUserId: actor.user.id,
      packageDigest: pkg.digest,
      expiresAt,
      baseline,
    }),
    expiresAt,
    secrets: Array.isArray(pkg.manifest.secrets) ? pkg.manifest.secrets : [],
    requirements: pkg.manifest.requirements ?? {},
  }
}

function suggestName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  for (let n = 2; n < 1000; n++) {
    const candidate = `${name}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${name}-${Date.now()}`
}
