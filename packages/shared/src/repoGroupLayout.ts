// RFC-248 — 仓库组的**纯**布局代数：挂载路径规范化、递归展平、包含关系、
// 排除计划、分支序号。零 DB / 零 fs 依赖，前端布局预览与后端物化共用同一份，
// 两边不可能算出不同的布局。
//
// 术语（design §1）：
//   mountPath  相对任务根（cwd）的路径；'' = 挂在根（cwd 本身就是那个仓的
//              worktree）。至多一个成员可以是 ''（D2）。
//   container  某个挂载点的最长严格前缀。'' 是所有其它挂载点的容器。
//   排除计划    仓 P 要写进自己 .gitignore 的路径 = P 的**直接**子挂载点
//              （相对 P）。只排直接子就够——更深的已经在被排掉的子树里。

import {
  MAX_FLAT_REPOS,
  MAX_GROUP_DEPTH,
  type MountPathError,
  type PlannedRepo,
  type RepoGroupStructureError,
} from './schemas/repoGroup'

/** 上传输入的固定落点（D12）。有仓挂根时要连带写进它的排除规则。 */
export const UPLOAD_INPUTS_DIR = '.agent-workflow-inputs'

export class RepoGroupLayoutError extends Error {
  constructor(
    readonly code: MountPathError | RepoGroupStructureError,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'RepoGroupLayoutError'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 挂载路径（design §1.2）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 规范化一个**单个组内**声明的挂载路径。空串合法（= 挂根）。
 *
 * 刻意**不**校验「一个挂载点是另一个的前缀」——那正是嵌套，是本 RFC 的目的。
 * 重复与多根是集合级约束，在 `assertMountPathSet` 里查。
 */
export function normalizeMountPath(raw: string): string {
  if (raw === '') return ''
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new RepoGroupLayoutError('mount-path-absolute', `mount path must be relative: ${raw}`, {
      mountPath: raw,
    })
  }
  if (/[\r\n\\]/.test(raw)) {
    throw new RepoGroupLayoutError(
      'mount-path-unsafe-char',
      `mount path may not contain CR / LF / backslash: ${JSON.stringify(raw)}`,
      { mountPath: raw },
    )
  }
  const segments = raw.split('/').filter((s) => s !== '')
  for (const s of segments) {
    if (s === '.' || s === '..') {
      throw new RepoGroupLayoutError(
        'mount-path-traversal',
        `mount path may not contain '.' or '..' segments: ${raw}`,
        { mountPath: raw },
      )
    }
  }
  // 折叠后不可能为空：非空且不以 '/' 开头的串必然至少有一个非空段（全是斜杠
  // 的串会先在上面被 mount-path-absolute 挡掉）。曾经有过一个
  // `mount-path-empty` 分支，实测不可达，已删。
  return segments.join('/')
}

/** 内层组的成员挂载点 = 外层给该组的挂点 + 成员自己的挂点。 */
export function joinMountPath(prefix: string, own: string): string {
  const ownNorm = normalizeMountPath(own)
  if (ownNorm === '') return prefix
  if (prefix === '') return ownNorm
  return `${prefix}/${ownNorm}`
}

/**
 * 集合级约束：至多一个根、不得重复。
 *
 * 根计数**先于**重复检查——两个成员都挂根时两条都成立，但「至多一个成员可以
 * 挂在根」对用户更可操作（`duplicate mount path: <root>` 读起来像是路径写重了）。
 */
export function assertMountPathSet(mountPaths: readonly string[]): void {
  const roots = mountPaths.filter((p) => p === '').length
  if (roots > 1) {
    throw new RepoGroupLayoutError(
      'mount-path-multiple-roots',
      `at most one member may mount at the root (found ${roots})`,
      { roots },
    )
  }
  const seen = new Set<string>()
  for (const p of mountPaths) {
    if (seen.has(p)) {
      throw new RepoGroupLayoutError('mount-path-duplicate', `duplicate mount path: ${p}`, {
        mountPath: p,
      })
    }
    seen.add(p)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 包含关系（design §1.3）
// ─────────────────────────────────────────────────────────────────────────────

/** `child` 是否严格落在 `parent` 之内（按**路径段边界**匹配，`a/bc` 不属于 `a/b`）。 */
export function isUnder(parent: string, child: string): boolean {
  if (parent === child) return false
  if (parent === '') return true // 挂根的仓包含其余一切
  return child.startsWith(`${parent}/`)
}

/** `p` 的容器 = 挂载路径集合里 `p` 的**最长**严格前缀；没有则 null。 */
export function containerOf(p: string, all: readonly string[]): string | null {
  let best: string | null = null
  for (const cand of all) {
    if (!isUnder(cand, p)) continue
    if (best === null || cand.length > best.length) best = cand
  }
  return best
}

/** 直接子节点 = 以 `p` 为容器的那些挂载点。 */
export function directChildren(p: string, all: readonly string[]): string[] {
  return all.filter((c) => containerOf(c, all) === p)
}

/**
 * 仓 P 的排除清单——写进它 `.gitignore` 的路径，均相对 P 自己的工作树根。
 *
 * `includeUploadDir` 只在「多仓任务 ∧ P 挂根」时为 true（D12：上传物落在 cwd
 * 根下的固定目录，不属于任何仓，但若有仓挂根就落在它工作树里了）。
 */
export function exclusionPlanFor(
  p: string,
  all: readonly string[],
  opts: { includeUploadDir?: boolean } = {},
): string[] {
  const rels = directChildren(p, all).map((c) => (p === '' ? c : c.slice(p.length + 1)))
  if (opts.includeUploadDir === true && p === '') rels.push(UPLOAD_INPUTS_DIR)
  return rels.sort()
}

/** 挂载深度（段数）。根为 0。物化按它升序、回收按它降序（design §4.2 / §4.3）。 */
export function mountDepth(p: string): number {
  return p === '' ? 0 : p.split('/').length
}

// ─────────────────────────────────────────────────────────────────────────────
// 展平（design §1.1）
// ─────────────────────────────────────────────────────────────────────────────

/** 展平所需的最小组视图——注入式，便于前端用已加载的列表、后端用 DB 行。 */
export interface FlattenableGroup {
  id: string
  name: string
  members: ReadonlyArray<FlattenableMember>
}
export type FlattenableMember =
  | {
      kind: 'repo'
      cachedRepoId: string
      repoUrlRedacted: string
      ref: string
      subdir: string
      mountPath: string
      readonly: boolean
    }
  | { kind: 'group'; childGroupId: string; mountPath: string; readonly: boolean }

export interface FlattenResult {
  repos: PlannedRepo[]
  /** 实际达到的最大组嵌套深度（0 = 没有内层组）。 */
  maxDepth: number
}

/**
 * 递归展平一个组。
 *
 * 环检测用**当前递归链**（`chain`）而不是全局 visited 集：同一个内层组被两个
 * 不同的外层成员各引用一次是**合法**的（会展平两次、落到两个不同挂载点），
 * 只有出现在自己的祖先链里才是环。
 *
 * 只读取并集（D20）：外层标只读 ⇒ 内层全部只读；外层不标则听内层成员自己的。
 */
export function flattenRepoGroup(
  rootId: string,
  load: (id: string) => FlattenableGroup | undefined,
): FlattenResult {
  const repos: PlannedRepo[] = []
  let maxDepth = 0

  const walk = (
    groupId: string,
    prefix: string,
    inheritedReadonly: boolean,
    depth: number,
    chain: ReadonlyArray<{ id: string; name: string }>,
  ): void => {
    if (depth > MAX_GROUP_DEPTH) {
      throw new RepoGroupLayoutError(
        'repo-group-depth-exceeded',
        `repo group nesting exceeds ${MAX_GROUP_DEPTH} levels`,
        { chain: chain.map((c) => c.id) },
      )
    }
    if (chain.some((c) => c.id === groupId)) {
      throw new RepoGroupLayoutError(
        'repo-group-cycle',
        `repo group cycle: ${[...chain.map((c) => c.id), groupId].join(' → ')}`,
        { cycle: [...chain.map((c) => c.id), groupId] },
      )
    }
    const group = load(groupId)
    if (group === undefined) {
      throw new RepoGroupLayoutError(
        'repo-group-member-not-found',
        `repo group '${groupId}' not found`,
        { groupId },
      )
    }
    if (depth > maxDepth) maxDepth = depth
    const nextChain = [...chain, { id: group.id, name: group.name }]

    for (const m of group.members) {
      const mount = joinMountPath(prefix, m.mountPath)
      const ro = inheritedReadonly || m.readonly
      if (m.kind === 'repo') {
        repos.push({
          cachedRepoId: m.cachedRepoId,
          repoUrlRedacted: m.repoUrlRedacted,
          ref: m.ref,
          subdir: m.subdir,
          mountPath: mount,
          readonly: ro,
          viaGroups: nextChain.map((c) => ({ id: c.id, name: c.name })),
        })
        if (repos.length > MAX_FLAT_REPOS) {
          throw new RepoGroupLayoutError(
            'repo-group-too-many-repos',
            `flattened repo group exceeds ${MAX_FLAT_REPOS} repos`,
            { count: repos.length },
          )
        }
      } else {
        walk(m.childGroupId, mount, ro, depth + 1, nextChain)
      }
    }
  }

  walk(rootId, '', false, 0, [])
  assertMountPathSet(repos.map((r) => r.mountPath))
  return { repos, maxDepth }
}

/**
 * 物化顺序：挂载深度升序（外层必须先于内层建，因为内层要落进外层的工作树）。
 * 同深度保持展平序（= 用户在组里排的顺序），让 `repo_index` 稳定可预期。
 */
export function orderForMaterialize<T extends { mountPath: string }>(planned: readonly T[]): T[] {
  return planned
    .map((p, i) => ({ p, i }))
    .sort((a, b) => mountDepth(a.p.mountPath) - mountDepth(b.p.mountPath) || a.i - b.i)
    .map((x) => x.p)
}

// ─────────────────────────────────────────────────────────────────────────────
// 分支序号（D14 / design §3.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 同一个源仓在展平结果里出现多次时，第 1 次用 `agent-workflow/{taskId}`，
 * 第 n 次用 `…-{n}`。不加序号会直接撞
 * `fatal: '<branch>' is already checked out`。
 *
 * `workingBranch`（RFC-075）被指定时同理加后缀——同一条工作分支同样不能在两个
 * worktree 里同时 checkout。
 */
export function assignBranchNames(
  planned: ReadonlyArray<{ cachedRepoId: string }>,
  taskId: string,
  workingBranch?: string,
): string[] {
  const seen = new Map<string, number>()
  const base = workingBranch !== undefined && workingBranch !== '' ? workingBranch : null
  return planned.map((p) => {
    const n = (seen.get(p.cachedRepoId) ?? 0) + 1
    seen.set(p.cachedRepoId, n)
    const stem = base ?? `agent-workflow/${taskId}`
    return n === 1 ? stem : `${stem}-${n}`
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 仓 key（D15 / design §6.1）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 线上/展示形态：根仓的 key 是空串，空串在 `# === Repo: X ===` 标记里没法表达，
 * 所以线上写 `.`。`normalizeMountPath` 拒绝 `.` 段，故 `.` 不可能与真实挂载
 * 路径冲突。
 */
export function repoKeyWire(mountPath: string): string {
  return mountPath === '' ? '.' : mountPath
}

export function parseRepoKeyWire(wire: string): string {
  return wire === '.' ? '' : wire
}

/**
 * 把一个「带仓前缀的完整路径」拆成 `[仓 key, 仓内相对路径]`。
 *
 * 按**已知 key 集合**做最长前缀匹配，不是猜。根 key（`''`）永远最后兜底。
 * 这样做无歧义是有**构造性**保证的：容器仓不可能产出落在某个挂载点前缀下的
 * 路径——挂载点在启动期已被证明不存在于容器仓（`git worktree add` 到已存在
 * 非空目录直接 fatal ⇒ `repo-group-mount-occupied`），之后又被 `.gitignore`
 * 预置 commit 排除。见 design §6.3。
 */
export function splitRepoPrefix(
  fullPath: string,
  keys: readonly string[],
): [repoKey: string, relPath: string] {
  const ordered = [...keys].filter((k) => k !== '').sort((a, b) => b.length - a.length)
  for (const k of ordered) {
    if (fullPath === k) return [k, '']
    if (fullPath.startsWith(`${k}/`)) return [k, fullPath.slice(k.length + 1)]
  }
  return ['', fullPath]
}
