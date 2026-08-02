// RFC-248 T35 —— 展平后仓库组布局的树形展示。**公共组件**：组编辑器的实时
// 预览、组列表的展开行、任务详情的布局块共用同一份渲染，避免三处各画一棵树
// 然后慢慢长歪。
//
// 输入是后端 `/api/repo-groups/:id/layout` 返回的 `PlannedRepo[]`——**已经展平
// 过**（组套组已递归、只读已取并集、挂载路径已是相对任务根的最终值）。本组件
// 只负责把这个扁平数组按挂载路径的父子关系还原成树，不做任何布局语义计算。
//
// 为什么按挂载路径重建树而不是让后端给树：展平结果本来就是**平的**（同一个
// 仓可能经不同组链进来两次、挂在毫不相干的两个位置），树只是给人看的一种投影。
// 后端返回平数组、前端投影，两边都不用维护第二种表示。

import { useTranslation } from 'react-i18next'
import type { PlannedRepo } from '@agent-workflow/shared'
import { StatusChip } from '@/components/StatusChip'

export interface RepoLayoutTreeProps {
  repos: readonly PlannedRepo[]
  /** 测试锚点前缀；同页出现多棵树时用它区分。 */
  testidPrefix?: string
  /** 紧凑模式：省掉来源链与 URL，只留挂载路径 + 标记（任务详情用）。 */
  compact?: boolean
}

interface TreeNode {
  repo: PlannedRepo
  children: TreeNode[]
}

/**
 * 按挂载路径的**路径段前缀**关系建树。
 *
 * 用「最长的、真正是自己祖先的挂载路径」作父节点——不能只看第一段：
 * `vendor/sdk` 与 `vendor/sdk/ext` 是父子，而 `vendor/sdkx` 不是
 * （段边界，`startsWith` 会误判）。挂根成员（`''`）是所有人的兜底父节点。
 */
export function buildLayoutTree(repos: readonly PlannedRepo[]): TreeNode[] {
  const isUnder = (parent: string, child: string): boolean =>
    parent === '' ? child !== '' : child.startsWith(`${parent}/`)

  // 浅到深处理，保证父节点先于子节点建好。
  const sorted = [...repos].sort(
    (a, b) => a.mountPath.split('/').length - b.mountPath.split('/').length,
  )
  const nodes = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  for (const repo of sorted) {
    const node: TreeNode = { repo, children: [] }
    let parentKey: string | null = null
    for (const candidate of nodes.keys()) {
      if (!isUnder(candidate, repo.mountPath)) continue
      if (parentKey === null || candidate.length > parentKey.length) parentKey = candidate
    }
    if (parentKey === null) roots.push(node)
    else nodes.get(parentKey)!.children.push(node)
    // 同一挂载路径不可能出现两次（`assertMountPathSet` 在服务端保证），所以
    // 直接用它当键是安全的。
    nodes.set(repo.mountPath, node)
  }
  return roots
}

function Row({
  node,
  depth,
  testidPrefix,
  compact,
}: {
  node: TreeNode
  depth: number
  testidPrefix: string
  compact: boolean
}) {
  const { t } = useTranslation()
  const { repo } = node
  const label = repo.mountPath === '' ? t('repoGroups.layout.rootMount') : repo.mountPath
  return (
    <>
      <li
        className="repo-layout-tree__row"
        style={{ paddingInlineStart: `${depth * 16}px` }}
        data-testid={`${testidPrefix}-row-${repo.mountPath === '' ? '.' : repo.mountPath}`}
      >
        <code className="repo-layout-tree__mount">{label}</code>
        {repo.ref !== '' && (
          <span className="repo-layout-tree__ref">
            {' @ '}
            <code>{repo.ref}</code>
          </span>
        )}
        {repo.subdir !== '' && (
          <StatusChip kind="neutral" size="sm">
            {t('repoGroups.layout.subdirChip', { subdir: repo.subdir })}
          </StatusChip>
        )}
        {repo.readonly && (
          <StatusChip kind="neutral" size="sm" data-testid={`${testidPrefix}-readonly`}>
            {t('repoGroups.layout.readonlyChip')}
          </StatusChip>
        )}
        {!compact && (
          <span className="repo-layout-tree__url data-table__muted">{repo.repoUrlRedacted}</span>
        )}
        {!compact && repo.viaGroups.length > 0 && (
          <span className="repo-layout-tree__via data-table__muted">
            {t('repoGroups.layout.via', { chain: repo.viaGroups.map((g) => g.name).join(' › ') })}
          </span>
        )}
      </li>
      {node.children.map((c) => (
        <Row
          key={c.repo.mountPath}
          node={c}
          depth={depth + 1}
          testidPrefix={testidPrefix}
          compact={compact}
        />
      ))}
    </>
  )
}

export function RepoLayoutTree({ repos, testidPrefix, compact }: RepoLayoutTreeProps) {
  const prefix = testidPrefix ?? 'repo-layout-tree'
  // RFC-214 Lock B：空态**不由本组件自造**。它是纯投影组件（入参就是一个已经
  // 加载好的数组），空与不空由**持有 query 的调用方**经 `QueryState.emptyText`
  // 表达——那才是这套设计系统里表达「查询为空」的唯一原语。这里渲染一棵空
  // `<ul>`，DOM 锚点仍在，调用方的空态盖在外面。
  if (repos.length === 0) return <ul className="repo-layout-tree" data-testid={prefix} />
  return (
    <ul className="repo-layout-tree" data-testid={prefix}>
      {buildLayoutTree(repos).map((n) => (
        <Row
          key={n.repo.mountPath}
          node={n}
          depth={0}
          testidPrefix={prefix}
          compact={compact === true}
        />
      ))}
    </ul>
  )
}
