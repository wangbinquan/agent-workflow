// RFC-310 PR-0 T5 —— 检测/回退 probe 的快照对拍核心（测试专用，不进生产）。
//
// 2026-08-18 用户裁决：数字员工首版不引入 OS 沙箱/只读 Git view；no-Git 由
// 「提示词禁止 + 前后快照事后校验 + 违规整树回退」强制。本 helper 是「事后校验」
// 的最小可行实现：对 Git metadata 目录与受保护 roots 做内容寻址快照，退出后逐项
// 对拍，任何 added/removed/modified 都是 boundary violation。
// PR-4（T43）会把同一口径搬进生产 profile；probe 先在这里证明零漏报可行。

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface ProtectedRootSnapshot {
  /** root 标签（如 'git-meta'、'evidence'）→ 相对路径 → 内容 sha256（目录项记 '<dir>'，symlink 记 '<link>:目标'）。 */
  readonly entries: ReadonlyMap<string, ReadonlyMap<string, string>>
  readonly digest: string
}

export interface SnapshotViolation {
  readonly root: string
  readonly path: string
  readonly kind: 'added' | 'removed' | 'modified'
}

function walk(
  absRoot: string,
  rel: string,
  out: Map<string, string>,
  skipPrefixes: readonly string[],
): void {
  if (rel !== '' && skipPrefixes.some((p) => rel === p || rel.startsWith(`${p}/`))) return
  const abs = rel === '' ? absRoot : join(absRoot, rel)
  const st = statSync(abs, { throwIfNoEntry: false })
  if (!st) return
  if (st.isSymbolicLink()) {
    out.set(rel, `<link>:${readFileSync(abs, 'utf8')}`)
    return
  }
  if (st.isDirectory()) {
    if (rel !== '') out.set(`${rel}/`, '<dir>')
    for (const name of readdirSync(abs).sort()) {
      walk(absRoot, rel === '' ? name : `${rel}/${name}`, out, skipPrefixes)
    }
    return
  }
  if (st.isFile()) {
    out.set(rel, createHash('sha256').update(readFileSync(abs)).digest('hex'))
  }
}

/** 对若干受保护 roots（label → 绝对路径）做稳定快照。root 不存在时记为空集（出现即 added）。 */
export function snapshotProtectedRoots(
  roots: Record<string, string>,
  opts: { readonly skipPrefixes?: readonly string[] } = {},
): ProtectedRootSnapshot {
  const skipPrefixes = opts.skipPrefixes ?? []
  const entries = new Map<string, Map<string, string>>()
  for (const label of Object.keys(roots).sort()) {
    const files = new Map<string, string>()
    walk(roots[label]!, '', files, skipPrefixes)
    entries.set(label, files)
  }
  const h = createHash('sha256')
  for (const [label, files] of entries) {
    h.update(`root:${label}\n`)
    for (const [rel, digest] of [...files.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      h.update(`${rel}${digest}\n`)
    }
  }
  return { entries, digest: h.digest('hex') }
}

/** 前后快照逐项对拍；空数组 = 无违规。 */
export function diffProtectedRoots(
  before: ProtectedRootSnapshot,
  after: ProtectedRootSnapshot,
): SnapshotViolation[] {
  const violations: SnapshotViolation[] = []
  const labels = new Set([...before.entries.keys(), ...after.entries.keys()])
  for (const root of [...labels].sort()) {
    const b = before.entries.get(root) ?? new Map<string, string>()
    const a = after.entries.get(root) ?? new Map<string, string>()
    for (const [rel, digest] of b) {
      const now = a.get(rel)
      if (now === undefined) violations.push({ root, path: rel, kind: 'removed' })
      else if (now !== digest) violations.push({ root, path: rel, kind: 'modified' })
    }
    for (const rel of a.keys()) {
      if (!b.has(rel)) violations.push({ root, path: rel, kind: 'added' })
    }
  }
  return violations
}
