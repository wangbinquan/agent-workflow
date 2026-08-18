// RFC-310 PR-4 T47 —— workspace validator（design.md §7.5 步骤 5-7）。
//
//   5. Git metadata/evidence/protected roots 前后快照对拍（protectedSnapshot）；
//   6. 业务树 escape 面（新 symlink/hardlink）与预算；
//   7. outcome 与真实 overlay 一致性——changed 必须相对 action baseline 有
//      非空、允许路径内的真实 delta；no-change/needs-information/blocked 必须
//      clean。changedPaths 由平台自己对树计算，**绝不信 Agent 自报**（§7.6.6）。
//
// 违规分级（§7.7 分类表）：boundary（禁区写入——same-session 禁止、整树废弃）
// 与 semantic（outcome 与现场不符——可给 structured feedback 同会话重试）。
// 业务树路径全部由本文件 walk 以 `/` 构造（repo-relative by construction），
// 前缀判断用普通串联而非模板字面量。

import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PLATFORM_WORKSPACE_DIR } from '@agent-workflow/shared'
import { sha256Hex } from '@/util/hash'
import type { CapabilityWorkspaceMode } from '../domain/capabilityDefinition'
import {
  diffProtectedRoots,
  snapshotProtectedRoots,
  type ProtectedRootSnapshot,
  type SnapshotViolation,
} from './protectedSnapshot'

/**
 * 业务树快照：rel path → `f:<r|x>:<sha256>` 或 `l:<target>`。排除 `.git` 与
 * `.agent-workflow`（evidence/platform 归 protected roots 对拍面）。目录本身
 * 不记：空目录增删不构成业务改动。
 */
export function businessTreeSnapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (rel: string): void => {
    const abs = rel === '' ? root : join(root, rel)
    const st = lstatSync(abs, { throwIfNoEntry: false })
    if (!st) return
    if (st.isSymbolicLink()) {
      out.set(rel, `l:${readlinkSync(abs)}`)
      return
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) {
        const childRel = rel === '' ? name : `${rel}/${name}`
        if (childRel === '.git' || childRel === PLATFORM_WORKSPACE_DIR) continue
        walk(childRel)
      }
      return
    }
    if (st.isFile()) {
      const mode = (st.mode & 0o111) !== 0 ? 'x' : 'r'
      out.set(rel, `f:${mode}:${sha256Hex(readFileSync(abs))}`)
    }
  }
  walk('')
  return out
}

export type BoundaryViolationCode =
  | 'protected-root-write'
  | 'symlink-created'
  | 'hardlink-created'
  | 'read-only-workspace-write'
  | 'write-outside-allowlist'
  | 'preserve-upload-modified'
  | 'upload-target-removed'
  | 'upload-mode-changed'
  | 'budget-exceeded'

export type WorkspaceValidationOutcome =
  | { readonly ok: true; readonly kind: 'clean' }
  | { readonly ok: true; readonly kind: 'changed'; readonly changedPaths: readonly string[] }
  | {
      readonly ok: false
      readonly kind: 'boundary'
      readonly code: BoundaryViolationCode
      readonly paths: readonly string[]
      readonly detail: string
    }
  | {
      readonly ok: false
      readonly kind: 'semantic'
      readonly code: 'outcome-workspace-mismatch'
      readonly detail: string
    }

export interface WorkspaceValidationInput {
  readonly workspacePath: string
  /** launch 前平台拍的 protected 快照（git-meta/evidence/额外 roots）。 */
  readonly preProtected: ProtectedRootSnapshot
  /** 与 pre 拍摄相同的 label→绝对路径映射（重拍 after 用）。 */
  readonly protectedRoots: Record<string, string>
  readonly protectedSkipPrefixes?: readonly string[]
  /** materialize 完成时拍的业务树快照（= action baseline 的现场形态）。 */
  readonly preBusinessTree: ReadonlyMap<string, string>
  readonly outcome: 'changed' | 'no-change' | 'needs-information' | 'blocked'
  readonly workspaceMode: CapabilityWorkspaceMode
  /** 非空 = 只允许这些 repo-relative 前缀内的改动（inspector 解析产物）。 */
  readonly writablePrefixes: readonly string[]
  /** preserve-upload 落点：不许改/删。 */
  readonly preservePaths: readonly string[]
  /** agent-editable 落点：可改内容，不许删除/改 mode。 */
  readonly editablePaths: readonly string[]
  readonly budget: { readonly maxChangedFiles: number; readonly maxTotalBytes: number }
}

function within(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => rel === p || rel.startsWith(p + '/'))
}

function boundary(
  code: BoundaryViolationCode,
  paths: readonly string[],
  detail: string,
): WorkspaceValidationOutcome {
  return { ok: false, kind: 'boundary', code, paths: [...paths].sort(), detail }
}

export function validateWorkspaceOutcome(
  input: WorkspaceValidationInput,
): WorkspaceValidationOutcome {
  // 5) protected roots 对拍（必须最先跑：一旦违规现场即不可信，后续不看）。
  const after = snapshotProtectedRoots(input.protectedRoots, {
    skipPrefixes: input.protectedSkipPrefixes,
  })
  const protectedViolations: SnapshotViolation[] = diffProtectedRoots(input.preProtected, after)
  if (protectedViolations.length > 0) {
    return boundary(
      'protected-root-write',
      protectedViolations.map((v) => `${v.root}:${v.path}`),
      protectedViolations
        .slice(0, 5)
        .map((v) => `${v.kind} ${v.root}/${v.path}`)
        .join('; '),
    )
  }

  // 业务树 delta（平台独立计算）。
  const post = businessTreeSnapshot(input.workspacePath)
  const changed: string[] = []
  const removed: string[] = []
  for (const [rel, sig] of input.preBusinessTree) {
    const now = post.get(rel)
    if (now === undefined) removed.push(rel)
    else if (now !== sig) changed.push(rel)
  }
  const added: string[] = []
  for (const rel of post.keys()) {
    if (!input.preBusinessTree.has(rel)) added.push(rel)
  }
  const delta = [...changed, ...removed, ...added].sort()

  // 6) escape 面：新增/变更的 symlink 与 hardlink。
  const newSymlinks = [...added, ...changed].filter((rel) => post.get(rel)?.startsWith('l:'))
  if (newSymlinks.length > 0) {
    return boundary('symlink-created', newSymlinks, 'symlink introduced into the business tree')
  }
  const hardlinks = [...added, ...changed].filter((rel) => {
    const st = lstatSync(join(input.workspacePath, rel), { throwIfNoEntry: false })
    return st !== undefined && st.isFile() && st.nlink > 1
  })
  if (hardlinks.length > 0) {
    return boundary('hardlink-created', hardlinks, 'hardlinked file introduced (escape vector)')
  }

  // 7a) read-only/none：任何业务变化即 boundary（§7.5 语义示例末条）。
  if ((input.workspaceMode === 'read-only' || input.workspaceMode === 'none') && delta.length > 0) {
    return boundary('read-only-workspace-write', delta, 'read-only capability wrote business files')
  }

  // 7b) 上传落点合同：preserve 不可动；editable 不可删/不可改 mode。
  const preserveTouched = delta.filter((rel) => within(rel, input.preservePaths))
  if (preserveTouched.length > 0) {
    return boundary('preserve-upload-modified', preserveTouched, 'preserve-upload target touched')
  }
  const editableRemoved = removed.filter((rel) => within(rel, input.editablePaths))
  if (editableRemoved.length > 0) {
    return boundary('upload-target-removed', editableRemoved, 'agent-editable target deleted')
  }
  const editableModeChanged = changed.filter((rel) => {
    if (!within(rel, input.editablePaths)) return false
    const before = input.preBusinessTree.get(rel)
    const now = post.get(rel)
    return (
      before !== undefined &&
      now !== undefined &&
      before.startsWith('f:') &&
      now.startsWith('f:') &&
      before.slice(0, 4) !== now.slice(0, 4)
    )
  })
  if (editableModeChanged.length > 0) {
    return boundary('upload-mode-changed', editableModeChanged, 'agent-editable file mode changed')
  }

  // 7c) 写允许集：声明了 writablePrefixes 时，改动必须落在 prefix 或 editable 内。
  if (input.writablePrefixes.length > 0) {
    const outside = delta.filter(
      (rel) => !within(rel, input.writablePrefixes) && !within(rel, input.editablePaths),
    )
    if (outside.length > 0) {
      return boundary('write-outside-allowlist', outside, 'write outside the allowed path classes')
    }
  }

  // 6b) 预算（在归类之后：预算违规是明确的 boundary，不给「格式对了就算」）。
  if (delta.length > input.budget.maxChangedFiles) {
    return boundary(
      'budget-exceeded',
      delta.slice(0, 10),
      `${delta.length} changed paths exceed the ${input.budget.maxChangedFiles} file budget`,
    )
  }
  let totalBytes = 0
  for (const rel of [...added, ...changed]) {
    const st = statSync(join(input.workspacePath, rel), { throwIfNoEntry: false })
    if (st?.isFile()) totalBytes += st.size
  }
  if (totalBytes > input.budget.maxTotalBytes) {
    return boundary(
      'budget-exceeded',
      delta.slice(0, 10),
      `${totalBytes} changed bytes exceed the ${input.budget.maxTotalBytes} byte budget`,
    )
  }

  // 7d) outcome ↔ 现场一致性（write-mode 下的错报是 semantic，可反馈重试）。
  if (input.outcome === 'changed' && delta.length === 0) {
    return {
      ok: false,
      kind: 'semantic',
      code: 'outcome-workspace-mismatch',
      detail: "outcome 'changed' but the workspace is clean relative to the action baseline",
    }
  }
  if (input.outcome !== 'changed' && delta.length > 0) {
    return {
      ok: false,
      kind: 'semantic',
      code: 'outcome-workspace-mismatch',
      detail: `outcome '${input.outcome}' but ${delta.length} business path(s) differ from the action baseline`,
    }
  }
  return delta.length === 0
    ? { ok: true, kind: 'clean' }
    : { ok: true, kind: 'changed', changedPaths: delta }
}
