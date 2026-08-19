// RFC-310 PR-4 T48 —— ChangeCandidate 的纯判定面（design §9.1）。
//
// candidate 相对 pinned baseline 由平台独立计算（绝不信 Agent 自报的
// changed paths）；本文件只做纯数据判定：禁路径阻断、上传 lineage 四规则、
// receipt 的 canonical digest。git 编排在 application/changeCandidate.ts。
//
// 阻断而非静默排除：`.agent-workflow/`、受保护路径出现在 changed 集合里是
// 固定 refuse（§9.2 尾条），不允许「悄悄剔掉继续发布」。

import { sha256Hex } from '@/util/hash'

/** 平台运行物目录：与 shared PLATFORM_WORKSPACE_DIR 同值；domain 保持零依赖面。 */
export const CANDIDATE_PLATFORM_DIR = '.agent-workflow'

export interface ChangedPathSummary {
  readonly added: readonly string[]
  readonly modified: readonly string[]
  readonly deleted: readonly string[]
}

export function changedPathSet(summary: ChangedPathSummary): ReadonlySet<string> {
  return new Set([...summary.added, ...summary.modified, ...summary.deleted])
}

export interface CandidatePathViolation {
  readonly path: string
  readonly reason: 'platform-dir' | 'protected-root'
}

/** §9.1/§9.2：candidate 里出现平台目录或受保护路径 ⇒ 固定阻断。 */
export function checkForbiddenCandidatePaths(
  summary: ChangedPathSummary,
  protectedRoots: readonly string[],
): CandidatePathViolation[] {
  const out: CandidatePathViolation[] = []
  const inRoot = (path: string, root: string): boolean =>
    path === root || path.startsWith(`${root}/`)
  for (const path of [...changedPathSet(summary)].sort()) {
    if (inRoot(path, CANDIDATE_PLATFORM_DIR)) {
      out.push({ path, reason: 'platform-dir' })
      continue
    }
    if (protectedRoots.some((root) => inRoot(path, root))) {
      out.push({ path, reason: 'protected-root' })
    }
  }
  return out
}

export interface UploadLineageEntry {
  readonly targetPath: string
  readonly contentPolicy: 'preserve-upload' | 'agent-editable'
  readonly fileMode: 'regular' | 'executable'
  /** placement 计算的 disposition（plan 的 create/replace/already-present）。 */
  readonly disposition: 'create' | 'replace' | 'already-present'
  /** 上传 evidence 的内容 digest；agent-editable 目标允许 null（最终 digest 由验证回填）。 */
  readonly uploadSha256: string | null
}

export type UploadLineageVerdict =
  | {
      readonly ok: true
      readonly finalDigests: readonly { readonly targetPath: string; readonly sha256: string }[]
    }
  | {
      readonly ok: false
      readonly code:
        | 'upload-entry-missing-from-diff'
        | 'upload-preserve-digest-mismatch'
        | 'upload-editable-target-missing'
        | 'upload-already-present-changed'
      readonly targetPath: string
    }

/**
 * §9.1 prepare 前的 UploadPlan 逐项验证：
 *   create/replace ⇒ 必须真实出现在相对 baseline 的 diff 中；
 *   preserve-upload ⇒ candidate blob 必须等于上传 digest；
 *   agent-editable ⇒ 目标必须存在并记录最终 digest；
 *   already-present ⇒ 不得伪装为 changed path。
 * 任一不满足都作废整个 candidate（不允许漏掉上传文件继续发布）。
 */
export function verifyUploadLineage(
  entries: readonly UploadLineageEntry[],
  facts: {
    readonly changed: ReadonlySet<string>
    /** candidate 树内目标文件的内容 digest；不存在 ⇒ null。 */
    readonly blobSha256Of: (targetPath: string) => string | null
    /**
     * The baseline is a platform-published mission commit that already
     * fulfilled this upload plan. Repair rounds still verify existence and
     * content policy, but must not require every original create/replace entry
     * to reappear in the new incremental diff.
     */
    readonly alreadyPublished?: boolean
  },
): UploadLineageVerdict {
  const finalDigests: { targetPath: string; sha256: string }[] = []
  for (const entry of [...entries].sort((a, b) => a.targetPath.localeCompare(b.targetPath))) {
    if (entry.disposition === 'already-present') {
      if (facts.changed.has(entry.targetPath)) {
        return { ok: false, code: 'upload-already-present-changed', targetPath: entry.targetPath }
      }
      continue
    }
    if (!facts.changed.has(entry.targetPath) && facts.alreadyPublished !== true) {
      return { ok: false, code: 'upload-entry-missing-from-diff', targetPath: entry.targetPath }
    }
    const actual = facts.blobSha256Of(entry.targetPath)
    if (actual === null) {
      return { ok: false, code: 'upload-editable-target-missing', targetPath: entry.targetPath }
    }
    if (entry.contentPolicy === 'preserve-upload' && actual !== entry.uploadSha256) {
      return { ok: false, code: 'upload-preserve-digest-mismatch', targetPath: entry.targetPath }
    }
    finalDigests.push({ targetPath: entry.targetPath, sha256: actual })
  }
  return { ok: true, finalDigests }
}

export interface ChangeCandidateReceipt {
  /** receipt 核心字段的 canonical digest——跨 context 引用只用这个 ref。 */
  readonly candidateRef: string
  readonly baselineSnapshotRef: string
  /** `git write-tree` 的 tree oid：candidate 树的内容寻址身份。 */
  readonly treeOid: string
  readonly changed: ChangedPathSummary
  readonly excludePolicyDigest: string
  readonly agentOutcomeRef: string
  readonly uploadLineage: {
    readonly planDigest: string
    readonly finalDigests: readonly { readonly targetPath: string; readonly sha256: string }[]
  } | null
}

/** 键序稳定的最小 canonical stringify（source-control domain 内自足，不跨 context）。 */
export function candidateCanonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(candidateCanonicalStringify).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${candidateCanonicalStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

export function candidateReceiptRef(core: Omit<ChangeCandidateReceipt, 'candidateRef'>): string {
  return sha256Hex(candidateCanonicalStringify(core))
}
