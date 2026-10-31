import {
  IsoWorkspaceBlockedError,
  MergeAgentChildUnreapedError,
} from '@/platform/workspace/local/isolation'
import { processTreeOwnershipStatus } from '@/util/process'
import { describeEffectError } from '../domain/effectErrorDescription'

export function describeIsoFailure(code: string, error: unknown): string {
  const lines = [code]
  try {
    if (error instanceof IsoWorkspaceBlockedError) {
      const d = error.detail
      lines.push(`  无法回收残留的隔离工作树（已尝试 ${d.generationsTried} 代）`)
      lines.push(`  残留: ${d.residualPath}`)
      lines.push(`  最后错误: ${d.lastError}`)
    } else {
      lines.push(`  ${describeEffectError(error)}`)
    }
  } catch {
    lines.length = 1
    lines.push('  unavailable error description')
  }
  const ownership = processTreeOwnershipStatus()
  lines.push(
    ownership.available
      ? '  进程树归属: 可用（杀树走 Job Object 原子终止）'
      : `  进程树归属: 不可用（${ownership.reason}）—— 杀树降级为 taskkill 枚举，后代可能逃逸并继续持有工作树句柄`,
  )
  return lines.join('\n')
}

export function mergeAgentChildUnreapedError(): Error {
  return new MergeAgentChildUnreapedError()
}
