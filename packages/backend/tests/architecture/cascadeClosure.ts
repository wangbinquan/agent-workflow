// RFC-317 R8 / findings.md CC-01 —— FK 级联的**传递闭包**。
//
// 为什么需要它：仓内所有「这张表会不会随删库一起消失」的对账守卫都只走**一跳**
// ——`if (target !== 'tasks' && target !== 'node_runs') continue`。于是任何跨两跳
// 才够到根的表都被判为「够不着、不用管」，而 SQLite 的 `ON DELETE CASCADE` 是
// **传递**的：删 tasks 会带走 doc_versions，带走 doc_versions 又会带走
// review_comments。`review_comments` 正是这么被归档静默删除的——目录里没有、库里
// 也没有、还不报错。
//
// 这里做一次不动点展开，把「从 roots 出发沿 cascade 边可达的全部表」算出来，
// 供归档对账、任务删除对账与将来任何保留期清理复用。单一实现，避免各写各的一跳。

import { getTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core'
import { is } from 'drizzle-orm'

export interface CascadeEdge {
  /** 持有外键的表（会被删的一方）。 */
  readonly child: string
  /** 被引用的表（删它会带走 child）。 */
  readonly parent: string
}

/** 整个 schema 里全部 `ON DELETE CASCADE` 边。 */
export function cascadeEdges(schema: Record<string, unknown>): CascadeEdge[] {
  const edges: CascadeEdge[] = []
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue
    const config = getTableConfig(value)
    for (const fk of config.foreignKeys) {
      const reference = fk.reference()
      if (fk.onDelete !== 'cascade') continue
      edges.push({ child: config.name, parent: getTableConfig(reference.foreignTable).name })
    }
  }
  return edges
}

/**
 * 纯图算法：从 `roots` 出发、沿给定 cascade 边可达的表集合（**含 roots 自身**）。
 *
 * 与 drizzle 反射分开，是为了让「一跳 vs 闭包」的差异能用一份**手写边集**做
 * fixture 证明，而不必往真 schema 里塞故意的违规表（仓规：变异 fixture 不进
 * 共享工作树）。
 */
export function closureOverEdges(
  edges: readonly CascadeEdge[],
  roots: readonly string[],
): Set<string> {
  const reachable = new Set<string>(roots)
  let grew = true
  while (grew) {
    grew = false
    for (const edge of edges) {
      if (reachable.has(edge.parent) && !reachable.has(edge.child)) {
        reachable.add(edge.child)
        grew = true
      }
    }
  }
  return reachable
}

/**
 * 从 `roots` 出发、沿 cascade 边可达的表集合（**含 roots 自身**）。
 *
 * 不动点展开而不是单跳：新表挂到任何一张已可达的表上，都会自动进入结果，
 * 不需要谁记得来改这里。
 */
export function cascadeClosure(
  schema: Record<string, unknown>,
  roots: readonly string[],
): Set<string> {
  return closureOverEdges(cascadeEdges(schema), roots)
}
