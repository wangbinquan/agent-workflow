// RFC-239 (design gate 2nd-round P1-3 / 3rd-round P1-N4) — ONE canonical repo
// label per task repo, shared by the text diff's `# === Repo: <label> ===`
// markers and the structural diff's `label/` id prefixes, so the frontend can
// join the two sides by exact label equality.
//
// Before this, the two sides disagreed on the fallback (structural:
// `basename(repoPath)`, text: full `repoPath`) and a label containing CR/LF
// could break the single-line marker regex. Sanitization happens BEFORE
// uniquing: two labels that only differ by stripped characters (`ab` vs
// `a\nb`) would otherwise collapse into the same string and cross-join files
// between repos.

// -----------------------------------------------------------------------------
// RFC-248 — 后继方案：规范 key **就是挂载路径**（`task_repos.mount_path`），
// 根仓为空串。下面的 `canonicalRepoLabels`（RFC-239 的 basename + `-2` 后缀）
// 会在 RFC-248 T29 把五个调用点迁完后**删除**——`mount_path` 列到 PR-2 才存在，
// 所以本 PR 只做纯新增，不制造「两套都在用」的过渡态。
//
// 为什么换：嵌套布局下 basename 彻底丢失方位——agent 拿到 `utils-2` 不知道该
// 去哪个目录。挂载路径与它在磁盘上看到的完全一致，`cd <key>` 就到位。
//
// 为什么新方案不 sanitize：挂载路径在**建组期**已过 `normalizeMountPath`
// ——拒绝绝对路径 / `.` / `..` / CR / LF / 反斜杠，并在集合级保证唯一。再
// sanitize 一次只会把 `apps/web` 毁成 `apps-web`，反而制造歧义；唯一性由挂载
// 路径本身保证，不需要 uniquing。
// -----------------------------------------------------------------------------

import { basename } from 'node:path'
import { repoKeyWire } from '@agent-workflow/shared'

/** RFC-248 —— 一个仓在 key 计算里需要的最小视图。 */
export interface RepoForKey {
  /** `task_repos.mount_path`；'' = 挂在根。 */
  mountPath: string
}

/**
 * RFC-248 —— 规范 key，与输入等长同序。**对完整 repo 列表**计算（不要先过滤
 * 再算），这样文本 diff 与结构化 diff 即使各自的 usable 过滤不同，也会给同一个
 * 仓同一个 key。
 */
export function canonicalRepoKeys(repos: readonly RepoForKey[]): string[] {
  return repos.map((r) => r.mountPath)
}

/**
 * RFC-248 —— 线上/展示形态。根仓的 key 是空串，空串没法出现在单行的
 * `# === Repo: X ===` 标记里，所以线上写 `.`；`normalizeMountPath` 拒绝 `.`
 * 段，故它不可能与真实挂载路径冲突。
 */
export function canonicalRepoKeysWire(repos: readonly RepoForKey[]): string[] {
  return repos.map((r) => repoKeyWire(r.mountPath))
}

export interface RepoForLabel {
  worktreeDirName?: string | null
  repoPath: string
}

/** Strip characters that break the diff marker line or path-prefix parsing:
 *  CR/LF (marker is single-line) and `/` (labels prefix repo-relative paths as
 *  `label/…` — a slash would shift the split point). */
function sanitizeLabel(raw: string): string {
  return raw.replace(/[\r\n/\\]+/g, '-').trim()
}

/** A label made only of replacement dashes/whitespace carries no identity. */
function hasSubstance(label: string): boolean {
  return /[^\s-]/.test(label)
}

/**
 * Canonical labels for a task's repos, index-aligned with the input. Compute
 * over the FULL repo list (not a filtered subset) so both consumers hand the
 * same repo the same label even when their usable-filters differ.
 */
export function canonicalRepoLabels(repos: readonly RepoForLabel[]): string[] {
  const labels: string[] = []
  const used = new Map<string, number>()
  for (const repo of repos) {
    const raw = repo.worktreeDirName ?? ''
    let label = sanitizeLabel(raw)
    if (!hasSubstance(label)) label = sanitizeLabel(basename(repo.repoPath))
    if (!hasSubstance(label)) label = 'repo'
    const n = used.get(label) ?? 0
    used.set(label, n + 1)
    // Post-sanitization uniquing: creation-time `-2/-3` dedup only guarantees
    // uniqueness BEFORE stripping, so collisions can reappear here.
    if (n > 0) label = `${label}-${n + 1}`
    labels.push(label)
  }
  return labels
}
