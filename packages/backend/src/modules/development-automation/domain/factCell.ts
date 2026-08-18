// RFC-310 T3 —— FactCell 四态（design.md §4.1）。
//
// 每个可被规则读取的 leaf 都必须显式声明可用性，而不是用 null 同时表示
// 「没有」「不适用」「没采到」「过期」。predicate 只对 known/not-applicable
// 求 true/false；unknown/stale 产生 indeterminate（evaluator 停在 fixed
// guard，先 collect，绝不让 provider outage 改变动作优先级）。

import { z } from 'zod'

export function factCellSchema<T extends z.ZodTypeAny>(value: T) {
  return z.discriminatedUnion('state', [
    z
      .object({
        state: z.literal('known'),
        value,
        sourceRevision: z.string().min(1),
      })
      .strict(),
    z
      .object({
        state: z.literal('not-applicable'),
        reason: z.string().min(1),
      })
      .strict(),
    z
      .object({
        state: z.literal('unknown'),
        reason: z.string().min(1),
        collectable: z.boolean(),
      })
      .strict(),
    z
      .object({
        state: z.literal('stale'),
        previousRevision: z.string().min(1),
        collectable: z.boolean(),
      })
      .strict(),
  ])
}

export type FactCell<T> =
  | { readonly state: 'known'; readonly value: T; readonly sourceRevision: string }
  | { readonly state: 'not-applicable'; readonly reason: string }
  | { readonly state: 'unknown'; readonly reason: string; readonly collectable: boolean }
  | { readonly state: 'stale'; readonly previousRevision: string; readonly collectable: boolean }

/** predicate 三值语义：unknown/stale ⇒ indeterminate（不是 false）。 */
export type TriState = true | false | 'indeterminate'

export function evaluateCell<T>(
  cell: FactCell<T>,
  predicate: (value: T | null) => boolean,
): TriState {
  switch (cell.state) {
    case 'known':
      return predicate(cell.value)
    case 'not-applicable':
      return predicate(null)
    case 'unknown':
    case 'stale':
      return 'indeterminate'
  }
}
