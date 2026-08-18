// RFC-310 PR-3 T36a —— RepositoryUploadPlan 生成与 CAS 判定（design §5.4）。
//
// 用户提交的 collisionMode 在 admission 对冻结 baseline 解析为 expectedTarget：
//   create-only：absent | already-present(同 digest+mode) | block
//   replace-existing：exact-file(冻结原 digest) | already-present | block(缺失)
// 目标唯一 + 无 file/descendant 前缀冲突 + 保护面（.git/.agent-workflow/
// symlink/submodule/目录占位）在 Agent 启动前拒绝。planDigest 覆盖 baseline、
// entry 顺序、blob digest、目标、expectedTarget、mode 与 contentPolicy——
// 计划一经落库不可修改（改 = cancel 重 launch）。

import { ulid } from 'ulid'

import { isPlatformWorkspacePath } from '@agent-workflow/shared'
import { canonicalDigest } from '../domain/canonicalJson'
import type { repositoryUploadPolicySchema } from '../domain/automationPolicy'
import { type AutomationPolicyContent } from '../domain/automationPolicy'
import { repoRelativePathSchema } from '../domain/requirementManifest'
import { ValidationError } from '@/util/errors'
import type { z } from 'zod'

export type RepositoryUploadPolicy = z.infer<typeof repositoryUploadPolicySchema>

export interface BaselineFileStat {
  readonly kind: 'file'
  readonly sha256: string
  readonly mode: 'regular' | 'executable'
}

export type BaselineStat = BaselineFileStat | 'missing' | 'directory' | 'unsupported'

export interface BaselineFileReader {
  stat(path: string): Promise<BaselineStat>
}

export interface UploadPlanRequestEntry {
  readonly uploadRef: string
  readonly sha256: string
  readonly bytes: number
  readonly repositoryTargetPath: string
  readonly collisionMode?: 'create-only' | 'replace-existing'
  readonly contentPolicy?: 'preserve-upload' | 'agent-editable'
  readonly fileMode?: 'regular' | 'executable'
}

export interface ResolvedPlanEntry {
  readonly ordinal: number
  readonly fileId: string
  readonly uploadBlobRef: string
  readonly uploadSha256: string
  readonly repositoryTargetPath: string
  readonly contentPolicy: 'preserve-upload' | 'agent-editable'
  readonly targetFileMode: 'regular' | 'executable'
  readonly expectedTarget:
    | { readonly kind: 'absent' }
    | {
        readonly kind: 'exact-file'
        readonly sha256: string
        readonly fileMode: 'regular' | 'executable'
      }
    | {
        readonly kind: 'already-present'
        readonly sha256: string
        readonly fileMode: 'regular' | 'executable'
      }
}

export interface UploadDisposition {
  readonly repositoryTargetPath: string
  readonly disposition: 'create' | 'replace' | 'already-present' | 'blocked'
  readonly effectiveCollisionMode: 'create-only' | 'replace-existing' | null
  readonly effectiveContentPolicy: 'preserve-upload' | 'agent-editable' | null
  readonly blockedReason: string | null
}

export function defaultUploadPolicyOf(policy: AutomationPolicyContent): RepositoryUploadPolicy {
  return policy.requirement.upload
}

function normalizedTarget(path: string): string {
  const parsed = repoRelativePathSchema.safeParse(path)
  if (!parsed.success)
    throw new ValidationError('upload-target-invalid', `bad target path: ${path}`)
  return parsed.data
}

/** 纯判定（preview 与 launch 共用）；不落库、不产生 fileId。 */
export async function previewUploadDispositions(input: {
  readonly uploads: readonly UploadPlanRequestEntry[]
  readonly policy: RepositoryUploadPolicy
  readonly baseline: BaselineFileReader
}): Promise<UploadDisposition[]> {
  const { uploads, policy, baseline } = input
  const out: UploadDisposition[] = []
  const seenTargets = new Set<string>()
  const blocked = (path: string, reason: string): UploadDisposition => ({
    repositoryTargetPath: path,
    disposition: 'blocked',
    effectiveCollisionMode: null,
    effectiveContentPolicy: null,
    blockedReason: reason,
  })

  if (uploads.length > policy.maxFiles) {
    throw new ValidationError('upload-plan-too-many-files', `more than ${policy.maxFiles} uploads`)
  }
  const totalBytes = uploads.reduce((sum, u) => sum + u.bytes, 0)
  if (totalBytes > policy.maxTotalBytes) {
    throw new ValidationError(
      'upload-plan-total-bytes-exceeded',
      `${totalBytes} bytes exceeds the policy budget of ${policy.maxTotalBytes}`,
    )
  }

  const targets = uploads.map((u) => {
    try {
      return normalizedTarget(u.repositoryTargetPath)
    } catch {
      return u.repositoryTargetPath
    }
  })

  for (const [index, upload] of uploads.entries()) {
    let target: string
    try {
      target = normalizedTarget(upload.repositoryTargetPath)
    } catch {
      out.push(blocked(upload.repositoryTargetPath, 'target-path-invalid'))
      continue
    }
    if (isPlatformWorkspacePath(target) || target === '.git' || target.startsWith('.git/')) {
      out.push(blocked(target, 'target-path-protected'))
      continue
    }
    if (seenTargets.has(target)) {
      out.push(blocked(target, 'target-path-duplicate'))
      continue
    }
    const prefixConflict = targets.some(
      (other, otherIndex) =>
        otherIndex !== index && (other.startsWith(`${target}/`) || target.startsWith(`${other}/`)),
    )
    if (prefixConflict) {
      out.push(blocked(target, 'target-path-prefix-conflict'))
      continue
    }
    if (
      policy.allowedTargetPrefixes.length > 0 &&
      !policy.allowedTargetPrefixes.some((p) => target === p || target.startsWith(`${p}/`))
    ) {
      out.push(blocked(target, 'target-path-outside-allowed-prefixes'))
      continue
    }
    if (upload.bytes > policy.maxFileBytes) {
      out.push(blocked(target, 'file-exceeds-policy-max-bytes'))
      continue
    }
    const collisionMode = upload.collisionMode ?? policy.defaultCollisionMode
    if (!policy.allowedCollisionModes.includes(collisionMode)) {
      out.push(blocked(target, `collision-mode-not-allowed:${collisionMode}`))
      continue
    }
    const contentPolicy = upload.contentPolicy ?? policy.defaultContentPolicy
    if (!policy.allowedContentPolicies.includes(contentPolicy)) {
      out.push(blocked(target, `content-policy-not-allowed:${contentPolicy}`))
      continue
    }
    if (upload.fileMode === 'executable' && !policy.allowExecutableFileMode) {
      out.push(blocked(target, 'executable-file-mode-not-allowed'))
      continue
    }
    seenTargets.add(target)

    const stat = await baseline.stat(target)
    if (stat === 'directory') {
      out.push(blocked(target, 'target-is-directory'))
      continue
    }
    if (stat === 'unsupported') {
      out.push(blocked(target, 'target-unsupported-entry'))
      continue
    }
    if (collisionMode === 'create-only') {
      if (stat === 'missing') {
        out.push({
          repositoryTargetPath: target,
          disposition: 'create',
          effectiveCollisionMode: collisionMode,
          effectiveContentPolicy: contentPolicy,
          blockedReason: null,
        })
        continue
      }
      const effectiveMode = upload.fileMode ?? 'regular'
      if (stat.sha256 === upload.sha256 && stat.mode === effectiveMode) {
        out.push({
          repositoryTargetPath: target,
          disposition: 'already-present',
          effectiveCollisionMode: collisionMode,
          effectiveContentPolicy: contentPolicy,
          blockedReason: null,
        })
        continue
      }
      out.push(blocked(target, 'target-exists-with-different-content'))
      continue
    }
    // replace-existing
    if (stat === 'missing') {
      out.push(blocked(target, 'replace-target-missing'))
      continue
    }
    const effectiveMode = upload.fileMode ?? stat.mode
    if (stat.sha256 === upload.sha256 && stat.mode === effectiveMode) {
      out.push({
        repositoryTargetPath: target,
        disposition: 'already-present',
        effectiveCollisionMode: collisionMode,
        effectiveContentPolicy: contentPolicy,
        blockedReason: null,
      })
      continue
    }
    out.push({
      repositoryTargetPath: target,
      disposition: 'replace',
      effectiveCollisionMode: collisionMode,
      effectiveContentPolicy: contentPolicy,
      blockedReason: null,
    })
  }
  return out
}

export interface BuiltUploadPlan {
  readonly planId: string
  readonly planDigest: string
  readonly entries: readonly ResolvedPlanEntry[]
}

/** launch 事务内落库的 immutable plan（infrastructure/sqliteUploadPlanStore 消费）。 */
export interface PersistUploadPlanInput {
  readonly planId: string
  readonly missionId: string
  readonly missionRevision: number
  readonly repositoryId: string
  readonly baselineSnapshotRef: string
  readonly baselineSha: string
  readonly planDigest: string
  readonly entries: readonly ResolvedPlanEntry[]
  readonly createdAt: number
}

/**
 * launch 侧：判定 + 冻结为 immutable plan（任一 blocked ⇒ typed 抛，零落库）。
 * fileId 稳定取自 uploadRef（bundle 与 plan 的 lineage 键）。
 */
export async function resolveUploadPlanEntries(input: {
  readonly uploads: readonly UploadPlanRequestEntry[]
  readonly policy: RepositoryUploadPolicy
  readonly baseline: BaselineFileReader
}): Promise<{
  readonly entries: ResolvedPlanEntry[]
  readonly planDigest: (baseline: {
    snapshotRef: string
    headSha: string
    repositoryRef: string
  }) => string
  readonly planId: string
}> {
  const dispositions = await previewUploadDispositions(input)
  const firstBlocked = dispositions.find((d) => d.disposition === 'blocked')
  if (firstBlocked !== undefined) {
    throw new ValidationError(
      'upload-plan-blocked',
      `${firstBlocked.repositoryTargetPath}: ${firstBlocked.blockedReason}`,
      { dispositions },
    )
  }
  const entries: ResolvedPlanEntry[] = []
  for (const [ordinal, upload] of input.uploads.entries()) {
    const disposition = dispositions[ordinal]!
    const target = disposition.repositoryTargetPath
    const stat = await input.baseline.stat(target)
    const targetFileMode: 'regular' | 'executable' =
      upload.fileMode ??
      (disposition.effectiveCollisionMode === 'replace-existing' && typeof stat === 'object'
        ? stat.mode
        : 'regular')
    const expectedTarget: ResolvedPlanEntry['expectedTarget'] =
      disposition.disposition === 'create'
        ? { kind: 'absent' }
        : disposition.disposition === 'already-present'
          ? {
              kind: 'already-present',
              sha256: (stat as BaselineFileStat).sha256,
              fileMode: (stat as BaselineFileStat).mode,
            }
          : {
              kind: 'exact-file',
              sha256: (stat as BaselineFileStat).sha256,
              fileMode: (stat as BaselineFileStat).mode,
            }
    entries.push({
      ordinal,
      fileId: upload.uploadRef,
      uploadBlobRef: upload.sha256,
      uploadSha256: upload.sha256,
      repositoryTargetPath: target,
      contentPolicy: disposition.effectiveContentPolicy ?? 'preserve-upload',
      targetFileMode,
      expectedTarget,
    })
  }
  const planId = ulid()
  return {
    planId,
    entries,
    planDigest: (baseline) =>
      canonicalDigest({
        repositoryRef: baseline.repositoryRef,
        baselineSnapshotRef: baseline.snapshotRef,
        baselineSha: baseline.headSha,
        entries,
      }),
  }
}
