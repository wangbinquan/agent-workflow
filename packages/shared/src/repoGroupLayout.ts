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
  MAX_FLAT_NODES,
  MAX_FLAT_REPOS,
  MAX_GROUP_DEPTH,
  MAX_GROUP_NODES,
  type MountPathError,
  type PlannedDirectoryNode,
  type PlannedRepo,
  type RepoGroupNodeInput,
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
  // Unicode 归一化到 NFC：macOS 的 APFS/HFS+ 会把文件名归一化，`é`（U+00E9）与
  // `é`（U+0065 U+0301）在磁盘上是**同一个目录**。不归一化的话两个"不同"的挂载
  // 点会在 macOS 上撞成一个，而重复检查（精确字符串比较）放它们过去。
  raw = raw.normalize('NFC')
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new RepoGroupLayoutError('mount-path-absolute', `mount path must be relative: ${raw}`, {
      mountPath: raw,
    })
  }
  // CR / LF / U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR 全都会打断单行的
  // `# === Repo: X ===` 标记（JS 的 `^`/`$` 在多行模式下认 U+2028/U+2029）；反斜杠
  // 会被当成 gitignore 的转义符；其余 C0/C1 控制字符在路径里没有正当用途，且会让
  // 日志与 UI 显示错乱。一律拒绝。
  const badCharIndex = [...raw].findIndex((ch) => {
    const cp = ch.codePointAt(0) ?? 0
    return (
      ch === '\\' ||
      cp === 0x2028 || // LINE SEPARATOR
      cp === 0x2029 || // PARAGRAPH SEPARATOR
      cp <= 0x1f || // C0（含 CR / LF / NUL）
      (cp >= 0x7f && cp <= 0x9f) // DEL + C1
    )
  })
  if (badCharIndex >= 0) {
    throw new RepoGroupLayoutError(
      'mount-path-unsafe-char',
      `mount path may not contain line terminators, control characters or backslash: ${JSON.stringify(raw)}`,
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
  // D12 的上传目录是任务根下的保留名。允许成员挂到它上面的话，上传物会直接落进
  // 那个成员仓的工作树、进它的审计 diff 与自动提交。
  if (segments[0] === UPLOAD_INPUTS_DIR) {
    throw new RepoGroupLayoutError(
      'mount-path-unsafe-char',
      `'${UPLOAD_INPUTS_DIR}' is reserved for uploaded inputs and cannot be a mount path root`,
      { mountPath: raw },
    )
  }
  return segments.join('/')
}

/** RFC-249 canonical name. Kept as an alias so RFC-248 consumers migrate safely. */
export const normalizeRepoNodePath = normalizeMountPath

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
  // 大小写**不敏感**地查重。macOS 默认是 case-insensitive 文件系统：两个成员
  // 挂 `Vendor` 与 `vendor` 会在磁盘上撞成同一个目录，而精确比较放它们过去，
  // 于是第二个 `git worktree add` 撞 `already exists` 或直接覆盖第一个。
  // 组定义存在 DB 里、可以在 Linux 建而在 macOS 跑，所以**两个平台都拒**——
  // 只在 macOS 上拒会让同一个组"在这台机器上能跑、在那台机器上不能跑"。
  const seen = new Map<string, string>()
  for (const p of mountPaths) {
    const folded = p.toLowerCase()
    const prior = seen.get(folded)
    if (prior !== undefined) {
      throw new RepoGroupLayoutError(
        'mount-path-duplicate',
        prior === p
          ? `duplicate mount path: ${p}`
          : `mount paths collide case-insensitively (macOS filesystems are case-insensitive): '${prior}' vs '${p}'`,
        { mountPath: p, collidesWith: prior },
      )
    }
    seen.set(folded, p)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 包含关系（design §1.3）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `child` 是否严格落在 `parent` 之内。
 *
 * 两条都不能省：
 * - 按**路径段边界**匹配——`a/bc` 不属于 `a/b`（纯 startsWith 会算错）。
 * - **大小写折叠**比较——macOS 的 APFS/HFS+ 默认 case-insensitive，磁盘上
 *   `Vendor/` 与 `vendor/sdk` 是真嵌套。若这里区分大小写，`exclusionPlanFor`
 *   会把它们当兄弟、不给 `Vendor` 写排除规则，于是 `git add -A` 把内层仓当
 *   gitlink 提交上去（proposal E2）。`assertMountPathSet` 只折叠比较**完全
 *   相等**，挡不住这种「折叠后才成立的祖先关系」。
 */
export function isUnder(parent: string, child: string): boolean {
  const p = parent.toLowerCase()
  const c = child.toLowerCase()
  if (p === c) return false
  if (p === '') return true // 挂根的仓包含其余一切
  return c.startsWith(`${p}/`)
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

export function parentNodePath(path: string): string | null {
  const normalized = normalizeRepoNodePath(path)
  if (normalized === '') return null
  const slash = normalized.lastIndexOf('/')
  return slash < 0 ? '' : normalized.slice(0, slash)
}

export function nodeName(path: string): string {
  const normalized = normalizeRepoNodePath(path)
  if (normalized === '') return ''
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/** RFC-249 D15: stable segment-wise, case-insensitive tree order. */
export function compareRepoNodePath(left: string, right: string): number {
  const a = left.split('/')
  const b = right.split('/')
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const rawA = a[i]!
    const rawB = b[i]!
    const foldedA = rawA.toLocaleLowerCase('en-US')
    const foldedB = rawB.toLocaleLowerCase('en-US')
    if (foldedA < foldedB) return -1
    if (foldedA > foldedB) return 1
    if (rawA < rawB) return -1
    if (rawA > rawB) return 1
  }
  return a.length - b.length
}

export function joinNodePath(parent: string, name: string): string {
  const parentPath = normalizeRepoNodePath(parent)
  const segment = normalizeRepoNodePath(name)
  if (segment === '' || segment.includes('/')) {
    throw new RepoGroupLayoutError(
      'mount-path-unsafe-char',
      `directory name must be one non-empty path segment: ${JSON.stringify(name)}`,
      { nodePath: parent, name },
    )
  }
  return parentPath === '' ? segment : `${parentPath}/${segment}`
}

/** Normalize and verify that an explicit node set is a closed directory tree. */
export function validateRepoGroupNodes<A>(
  nodes: ReadonlyArray<{ path: string; attachment: A | null }>,
): Array<{ path: string; attachment: A | null }> {
  if (nodes.length > MAX_GROUP_NODES) {
    throw new RepoGroupLayoutError(
      'repo-group-node-limit',
      `repo group definition exceeds ${MAX_GROUP_NODES} directory nodes`,
      { limit: MAX_GROUP_NODES, actual: nodes.length, phase: 'definition' },
    )
  }
  const normalized = nodes.map((node) => ({
    path: normalizeRepoNodePath(node.path),
    attachment: node.attachment,
  }))
  const roots = normalized.filter((node) => node.path === '').length
  if (roots === 0) {
    throw new RepoGroupLayoutError('repo-group-root-missing', 'repo group root node is required')
  }
  if (roots > 1) {
    throw new RepoGroupLayoutError(
      'repo-group-multiple-roots',
      `repo group must contain exactly one root node (found ${roots})`,
      { count: roots },
    )
  }
  const byFolded = new Map<string, string>()
  for (const node of normalized) {
    const folded = node.path.toLowerCase()
    const prior = byFolded.get(folded)
    if (prior !== undefined) {
      throw new RepoGroupLayoutError(
        'mount-path-duplicate',
        prior === node.path
          ? `duplicate directory node: ${node.path === '' ? '<root>' : node.path}`
          : `directory nodes collide case-insensitively: '${prior}' vs '${node.path}'`,
        { nodePath: node.path, collidesWith: prior },
      )
    }
    byFolded.set(folded, node.path)
  }
  for (const node of normalized) {
    const parent = parentNodePath(node.path)
    if (parent === null) continue
    if (!byFolded.has(parent.toLowerCase())) {
      throw new RepoGroupLayoutError(
        'repo-group-parent-missing',
        `directory node '${node.path}' is missing its explicit parent '${parent || '<root>'}'`,
        { nodePath: node.path, parentPath: parent },
      )
    }
  }
  return normalized.slice().sort((left, right) => compareRepoNodePath(left.path, right.path))
}

function rewriteSubtree(
  nodes: readonly RepoGroupNodeInput[],
  path: string,
  nextPath: string,
): RepoGroupNodeInput[] {
  const source = normalizeRepoNodePath(path)
  const target = normalizeRepoNodePath(nextPath)
  const next = nodes.map((node) => {
    const current = normalizeRepoNodePath(node.path)
    if (current !== source && !isUnder(source, current)) return node
    const suffix = current === source ? '' : current.slice(source.length + 1)
    return { ...node, path: suffix === '' ? target : joinMountPath(target, suffix) }
  })
  return validateRepoGroupNodes(next) as RepoGroupNodeInput[]
}

export function renameNodeSubtree(
  nodes: readonly RepoGroupNodeInput[],
  path: string,
  nextName: string,
): RepoGroupNodeInput[] {
  const source = normalizeRepoNodePath(path)
  const parent = parentNodePath(source)
  if (parent === null) {
    throw new RepoGroupLayoutError('mount-path-traversal', 'the root node cannot be renamed')
  }
  return rewriteSubtree(nodes, source, joinNodePath(parent, nextName))
}

export function moveNodeSubtree(
  nodes: readonly RepoGroupNodeInput[],
  path: string,
  nextParent: string,
): RepoGroupNodeInput[] {
  const source = normalizeRepoNodePath(path)
  const parent = normalizeRepoNodePath(nextParent)
  if (source === '') {
    throw new RepoGroupLayoutError('mount-path-traversal', 'the root node cannot be moved')
  }
  if (source === parent || isUnder(source, parent)) {
    throw new RepoGroupLayoutError(
      'mount-path-traversal',
      `directory '${source}' cannot be moved into itself or its descendant '${parent}'`,
      { nodePath: source, parentPath: parent },
    )
  }
  if (
    !nodes.some((node) => normalizeRepoNodePath(node.path).toLowerCase() === parent.toLowerCase())
  ) {
    throw new RepoGroupLayoutError(
      'repo-group-parent-missing',
      `target directory '${parent || '<root>'}' does not exist`,
      { nodePath: source, parentPath: parent },
    )
  }
  return rewriteSubtree(nodes, source, joinNodePath(parent, nodeName(source)))
}

export function deleteNodeSubtree(
  nodes: readonly RepoGroupNodeInput[],
  path: string,
): RepoGroupNodeInput[] {
  const source = normalizeRepoNodePath(path)
  if (source === '') {
    throw new RepoGroupLayoutError('mount-path-traversal', 'the root node cannot be deleted')
  }
  return validateRepoGroupNodes(
    nodes.filter((node) => {
      const current = normalizeRepoNodePath(node.path)
      return current !== source && !isUnder(source, current)
    }),
  ) as RepoGroupNodeInput[]
}

export function attachAtNode(
  nodes: readonly RepoGroupNodeInput[],
  path: string,
  attachment: RepoGroupNodeInput['attachment'],
): RepoGroupNodeInput[] {
  const target = normalizeRepoNodePath(path)
  let found = false
  const next = nodes.map((node) => {
    if (normalizeRepoNodePath(node.path).toLowerCase() !== target.toLowerCase()) return node
    found = true
    return { ...node, attachment }
  })
  if (!found) {
    throw new RepoGroupLayoutError('repo-group-member-not-found', `node '${target}' not found`, {
      nodePath: target,
    })
  }
  return next
}

export function detachAtNode(
  nodes: readonly RepoGroupNodeInput[],
  path: string,
): RepoGroupNodeInput[] {
  return attachAtNode(nodes, path, null)
}

/** Derive a compact, safe directory segment from a Git URL/path. */
export function repoNodeNameFromUrl(repoUrl: string): string {
  const withoutQuery = repoUrl
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
  const tail = withoutQuery.slice(
    Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf(':')) + 1,
  )
  const decoded = (() => {
    try {
      return decodeURIComponent(tail)
    } catch {
      return tail
    }
  })()
  const safe = decoded
    .replace(/\.git$/i, '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return safe === '' || safe === '.' || safe === '..' ? 'repo' : safe
}

export function allocateRepoNodePath(
  parent: string,
  repoUrl: string,
  occupiedPaths: readonly string[],
): string {
  const root = normalizeRepoNodePath(parent)
  const base = repoNodeNameFromUrl(repoUrl)
  const occupied = new Set(occupiedPaths.map((path) => normalizeRepoNodePath(path).toLowerCase()))
  let suffix = 1
  let candidate = joinNodePath(root, base)
  while (occupied.has(candidate.toLowerCase())) {
    suffix += 1
    candidate = joinNodePath(root, `${base}-${suffix}`)
  }
  return candidate
}

// ─────────────────────────────────────────────────────────────────────────────
// 展平（design §1.1）
// ─────────────────────────────────────────────────────────────────────────────

export type FlattenableAttachment =
  | {
      kind: 'repo'
      cachedRepoId: string
      repoUrlRedacted: string
      ref: string
      subdir: string
      readonly: boolean
    }
  | { kind: 'group'; childGroupId: string; readonly: boolean }

export interface FlattenableNode {
  path: string
  attachment: FlattenableAttachment | null
}

/** RFC-248 compatibility shape. Production v2 groups populate `nodes`, not members. */
export type FlattenableMember =
  | (Extract<FlattenableAttachment, { kind: 'repo' }> & { mountPath: string })
  | (Extract<FlattenableAttachment, { kind: 'group' }> & { mountPath: string })

/** 展平所需的最小组视图——注入式，便于后端用 DB 行、测试用内存图。 */
export interface FlattenableGroup {
  id: string
  name: string
  nodes?: ReadonlyArray<FlattenableNode>
  members?: ReadonlyArray<FlattenableMember>
}

export interface FlattenResult {
  repos: PlannedRepo[]
  nodes: PlannedDirectoryNode[]
  /** 实际达到的最大组嵌套深度（0 = 没有内层组）。 */
  maxDepth: number
}

/** Convert an RFC-248 member list into explicit attachment nodes + ancestor closure. */
export function legacyMembersToNodes(members: readonly FlattenableMember[]): FlattenableNode[] {
  const byPath = new Map<string, FlattenableNode>()
  const ensure = (path: string): FlattenableNode => {
    const normalized = normalizeRepoNodePath(path)
    const folded = normalized.toLowerCase()
    const existing = byPath.get(folded)
    if (existing !== undefined) return existing
    const parent = parentNodePath(normalized)
    if (parent !== null) ensure(parent)
    const created: FlattenableNode = { path: normalized, attachment: null }
    byPath.set(folded, created)
    return created
  }
  ensure('')
  for (const member of members) {
    const node = ensure(member.mountPath)
    if (node.attachment !== null) {
      throw new RepoGroupLayoutError(
        'mount-path-duplicate',
        `duplicate mount path: ${member.mountPath || '<root>'}`,
        { mountPath: member.mountPath },
      )
    }
    node.attachment =
      member.kind === 'repo'
        ? {
            kind: 'repo',
            cachedRepoId: member.cachedRepoId,
            repoUrlRedacted: member.repoUrlRedacted,
            ref: member.ref,
            subdir: member.subdir,
            readonly: member.readonly,
          }
        : {
            kind: 'group',
            childGroupId: member.childGroupId,
            readonly: member.readonly,
          }
  }
  return [...byPath.values()]
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
  const nodeByPath = new Map<string, PlannedDirectoryNode>()
  const repoOriginByPath = new Map<
    string,
    { legacy: boolean; viaGroups: Array<{ id: string; name: string }> }
  >()
  let maxDepth = 0
  // 只在「追加了一个真实 repo」时计预算是不够的：走 group 边不产出 repo，于是
  // 一个**零产出**的菱形图可以在深度 5 下展开出 32^5 ≈ 3400 万次同步递归而永远
  // 撞不到 MAX_FLAT_REPOS，把 daemon 的事件循环整个卡死。空叶子组是可达状态
  // ——`force=1` 删仓会把成员摘光。故另设一份**遍历预算**，每访问一个节点就扣。
  let expansions = 0
  const MAX_EXPANSIONS = MAX_FLAT_REPOS * (MAX_GROUP_DEPTH + 1) * 4

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
    expansions++
    if (expansions > MAX_EXPANSIONS) {
      throw new RepoGroupLayoutError(
        'repo-group-too-many-repos',
        `repo group expansion exceeded ${MAX_EXPANSIONS} nodes (cyclic-looking or pathologically wide nesting)`,
        { expansions },
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
    const legacy = group.nodes === undefined
    const rawNodes = group.nodes ?? legacyMembersToNodes(group.members ?? [])
    const groupNodes = validateRepoGroupNodes(rawNodes)

    for (const node of groupNodes) {
      const mount = joinMountPath(prefix, node.path)
      const folded = mount.toLowerCase()
      const origin = {
        groupId: group.id,
        groupName: group.name,
        viaGroups: nextChain.map((entry) => ({ ...entry })),
      }
      const plannedNode = nodeByPath.get(folded)
      if (plannedNode === undefined) {
        nodeByPath.set(folded, { path: mount, origins: [origin] })
        if (nodeByPath.size > MAX_FLAT_NODES) {
          throw new RepoGroupLayoutError(
            legacy ? 'repo-group-too-many-repos' : 'repo-group-node-limit',
            `flattened repo group exceeds ${MAX_FLAT_NODES} directory nodes`,
            { limit: MAX_FLAT_NODES, actual: nodeByPath.size, phase: 'flatten' },
          )
        }
      } else if (
        !plannedNode.origins.some(
          (item) =>
            item.groupId === origin.groupId &&
            item.viaGroups.map((entry) => entry.id).join('/') ===
              origin.viaGroups.map((entry) => entry.id).join('/'),
        )
      ) {
        plannedNode.origins.push(origin)
      }

      const attachment = node.attachment
      if (attachment === null) continue
      const ro = inheritedReadonly || attachment.readonly
      if (attachment.kind === 'repo') {
        const prior = repoOriginByPath.get(folded)
        if (prior !== undefined) {
          const detail = {
            nodePath: mount,
            firstViaGroups: prior.viaGroups,
            secondViaGroups: nextChain,
          }
          if (legacy || prior.legacy) {
            throw new RepoGroupLayoutError(
              'mount-path-duplicate',
              `duplicate mount path: ${mount || '<root>'}`,
              detail,
            )
          }
          throw new RepoGroupLayoutError(
            'repo-group-attachment-conflict',
            `multiple repositories attach to directory '${mount || '<root>'}'`,
            detail,
          )
        }
        repoOriginByPath.set(folded, { legacy, viaGroups: nextChain })
        repos.push({
          cachedRepoId: attachment.cachedRepoId,
          repoUrlRedacted: attachment.repoUrlRedacted,
          ref: attachment.ref,
          subdir: attachment.subdir,
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
        walk(attachment.childGroupId, mount, ro, depth + 1, nextChain)
      }
    }
  }

  walk(rootId, '', false, 0, [])
  return { repos, nodes: [...nodeByPath.values()], maxDepth }
}

/**
 * 物化顺序：挂载深度升序（外层必须先于内层建，因为内层要落进外层的工作树）。
 * 同深度保持展平序（= 用户在组里排的顺序），让 `repo_index` 稳定可预期。
 */
export function orderForMaterialize<T extends { mountPath: string }>(planned: readonly T[]): T[] {
  return planned
    .slice()
    .sort(
      (a, b) =>
        mountDepth(a.mountPath) - mountDepth(b.mountPath) ||
        compareRepoNodePath(a.mountPath, b.mountPath),
    )
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
