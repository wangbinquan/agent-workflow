// RFC-310 PR-4 T47 —— 受保护 roots 快照对拍（PR-0 probe 口径的生产化）。
//
// 2026-08-18 裁决：no-Git 无 OS 阻断，由「前后快照事后校验 + 违规整树回退」
// 强制。本文件与 tests/helpers/rfc310MetaSnapshot.ts（PR-0 probe，测试专用）
// **口径逐字一致**：目录项记 '<dir>'、symlink 记 '<link>:目标'、文件记内容
// sha256、任何 added/removed/modified 即 boundary violation。一致性由
// rfc310-pr4-workspace-validator 测试同树对拍两实现的 digest 锁定——probe
// 文件本身锁 PR-0 判据不动，生产实现不得悄悄偏航。
// hash 走 util/hash 单步 idiom（RFC-284 T7 文本锁：本 context 的 createHash
// 合法集不因此再增文件）。

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { sha256Hex } from '@/util/hash'

export interface ProtectedRootSnapshot {
  /** root 标签（如 'git-meta'、'evidence'）→ 相对路径 → 内容摘要。 */
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
  // rel/skipPrefixes 都是本文件 walk 以 '/' 构造的快照键（非 host path），
  // 前缀判断用普通串联（rfc254 posix-path-prefix 棘轮只认模板字面量形态）。
  if (rel !== '' && skipPrefixes.some((p) => rel === p || rel.startsWith(p + '/'))) return
  const abs = rel === '' ? absRoot : join(absRoot, rel)
  const st = statSync(abs, { throwIfNoEntry: false })
  if (!st) return
  if (st.isSymbolicLink()) {
    out.set(rel, `<link>:${readFileSync(abs, 'utf8')}`)
    return
  }
  if (st.isDirectory()) {
    if (rel !== '') out.set(rel + '/', '<dir>')
    for (const name of readdirSync(abs).sort()) {
      walk(absRoot, rel === '' ? name : `${rel}/${name}`, out, skipPrefixes)
    }
    return
  }
  if (st.isFile()) {
    out.set(rel, sha256Hex(readFileSync(abs)))
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
  const parts: string[] = []
  for (const [label, files] of entries) {
    parts.push(`root:${label}\n`)
    for (const [rel, digest] of [...files.entries()].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      // rel 与 digest 之间的 \x01 分隔字节（probe 同款）：没有它，
      // `a.txt`+hash 与 `a.tx`+`t...` 的拼接会产生同串歧义。
      parts.push(`${rel}\x01${digest}\n`)
    }
  }
  return { entries, digest: sha256Hex(parts.join('')) }
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
