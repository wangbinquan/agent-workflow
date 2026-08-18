// RFC-310 T3 —— typed predicate AST（design.md §4.2）。
//
// 配置只能表达 schema 已登记的 closed predicate：没有 JS/CEL/JQ/正则执行器、
// 没有 `${expression}`。fact id 的 closed catalog 属 PR-1 T10；本文件先锁
// AST 形状与预算（深度/节点数），publish 校验超预算即拒，evaluator 永远
// 不会收到未经预算检查的树。

import { z } from 'zod'

export const PREDICATE_MAX_DEPTH = 8
export const PREDICATE_MAX_NODES = 64

const factId = z.string().min(1).max(200)

export type FactPredicate =
  | { readonly kind: 'enum-equals'; readonly fact: string; readonly value: string }
  | { readonly kind: 'enum-in'; readonly fact: string; readonly values: readonly string[] }
  | { readonly kind: 'set-contains-any'; readonly fact: string; readonly values: readonly string[] }
  | { readonly kind: 'set-contains-all'; readonly fact: string; readonly values: readonly string[] }
  | {
      readonly kind: 'number-compare'
      readonly fact: string
      readonly op: 'eq' | 'lt' | 'lte' | 'gt' | 'gte'
      readonly value: number
    }
  | { readonly kind: 'boolean-is'; readonly fact: string; readonly value: boolean }
  | { readonly kind: 'path-class-any'; readonly values: readonly string[] }
  | { readonly kind: 'all'; readonly predicates: readonly FactPredicate[] }
  | { readonly kind: 'any'; readonly predicates: readonly FactPredicate[] }
  | { readonly kind: 'not'; readonly predicate: FactPredicate }

export const factPredicateSchema: z.ZodType<FactPredicate> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('enum-equals'), fact: factId, value: z.string().min(1) }).strict(),
    z
      .object({
        kind: z.literal('enum-in'),
        fact: factId,
        values: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('set-contains-any'),
        fact: factId,
        values: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('set-contains-all'),
        fact: factId,
        values: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('number-compare'),
        fact: factId,
        op: z.enum(['eq', 'lt', 'lte', 'gt', 'gte']),
        value: z.number().finite(),
      })
      .strict(),
    z.object({ kind: z.literal('boolean-is'), fact: factId, value: z.boolean() }).strict(),
    z
      .object({ kind: z.literal('path-class-any'), values: z.array(z.string().min(1)).min(1) })
      .strict(),
    z.object({ kind: z.literal('all'), predicates: z.array(factPredicateSchema).min(1) }).strict(),
    z.object({ kind: z.literal('any'), predicates: z.array(factPredicateSchema).min(1) }).strict(),
    z.object({ kind: z.literal('not'), predicate: factPredicateSchema }).strict(),
  ]),
) as z.ZodType<FactPredicate>

export interface PredicateBudgetViolation {
  readonly code: 'max-depth-exceeded' | 'max-nodes-exceeded'
  readonly limit: number
  readonly observed: number
}

/** publish 时的预算检查；违规返回清单（空 = 合法）。 */
export function checkPredicateBudget(root: FactPredicate): PredicateBudgetViolation[] {
  let nodes = 0
  let maxDepth = 0
  const visit = (p: FactPredicate, depth: number): void => {
    nodes += 1
    if (depth > maxDepth) maxDepth = depth
    if (p.kind === 'all' || p.kind === 'any') {
      for (const child of p.predicates) visit(child, depth + 1)
    } else if (p.kind === 'not') {
      visit(p.predicate, depth + 1)
    }
  }
  visit(root, 1)
  const violations: PredicateBudgetViolation[] = []
  if (maxDepth > PREDICATE_MAX_DEPTH) {
    violations.push({ code: 'max-depth-exceeded', limit: PREDICATE_MAX_DEPTH, observed: maxDepth })
  }
  if (nodes > PREDICATE_MAX_NODES) {
    violations.push({ code: 'max-nodes-exceeded', limit: PREDICATE_MAX_NODES, observed: nodes })
  }
  return violations
}
