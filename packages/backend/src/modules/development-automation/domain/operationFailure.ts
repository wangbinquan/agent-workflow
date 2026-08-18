// RFC-310 T28 —— closed failure taxonomy（design.md §4.8）。
//
// 所有 program/adapter/task/source-control/effect 失败必须先映射为本 closed
// receipt，规则只读这些 typed 字段决定 retry/refresh/block/handoff——provider
// 或 Agent 的自由错误文字永远不进决策面。

import { z } from 'zod'

export const OPERATION_FAILURE_CATEGORIES = [
  'transient',
  'stale-input',
  'configuration',
  'permission',
  'invalid-user-input',
  'business-failure',
  'contract-violation',
] as const

export type OperationFailureCategory = (typeof OPERATION_FAILURE_CATEGORIES)[number]

export const RETRYABILITY = ['same-input', 'after-refresh', 'after-configuration', 'never'] as const
export type Retryability = (typeof RETRYABILITY)[number]

export const operationFailureReceiptSchema = z
  .object({
    category: z.enum(OPERATION_FAILURE_CATEGORIES),
    code: z.string().min(1).max(120),
    retryability: z.enum(RETRYABILITY),
    attemptOrdinal: z.number().int().nonnegative(),
    remediation: z.string().min(1).max(200),
    evidenceRef: z.string().min(1).nullable(),
  })
  .strict()

export type OperationFailureReceipt = z.infer<typeof operationFailureReceiptSchema>

/** category → 默认 retryability（policy 只能在此语义内收紧，不能把 never 变可重试）。 */
export const DEFAULT_RETRYABILITY: Readonly<Record<OperationFailureCategory, Retryability>> = {
  transient: 'same-input',
  'stale-input': 'after-refresh',
  configuration: 'after-configuration',
  permission: 'after-configuration',
  'invalid-user-input': 'never',
  'business-failure': 'never',
  'contract-violation': 'never',
}

export interface BackoffPolicy {
  readonly baseMs: number
  readonly factor: number
  readonly maxMs: number
  readonly maxAttempts: number
}

export const DEFAULT_TRANSIENT_BACKOFF: BackoffPolicy = {
  baseMs: 30_000,
  factor: 2,
  maxMs: 30 * 60_000,
  maxAttempts: 8,
}

/** durable backoff：确定性（无抖动——重启后按 ordinal 重算得到同一 deadline）。 */
export function backoffDelayMs(policy: BackoffPolicy, attemptOrdinal: number): number | null {
  if (attemptOrdinal >= policy.maxAttempts) return null
  const raw = policy.baseMs * policy.factor ** attemptOrdinal
  return Math.min(raw, policy.maxMs)
}
