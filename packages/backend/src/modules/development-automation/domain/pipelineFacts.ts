// RFC-310 PR-6 T64/T66 —— pipeline evidence 的两个纯判定面。
//
// ①projectPipelineCells：manifest → catalog 六 leaf + `__pipeline.*` 内部
// cells。判定固定（§2.4/§6.3）：只有明确 `pass` 折算通过（gateCountsAsPass），
// `unknown/unavailable/canceled/skipped` 一律不通过；completeness='partial'
// 时 requiredGatesAllPass 恒 false（provider 给不出 head 绑定的采集绝不放行
// readiness）。missing 与 failing 语义分家——missing=required gate 在 manifest
// 里没有 run（走 trigger-if-missing），failing=有 run 但没过（走 rerun/repair）。
// ②judgePipelineFence：两次 head fence（§6.2）——H1=H2=providerHead=expected
// 且 T1=T2，否则 typed code 丢弃快照重采。
//
// 两者都不做业务决策：分类只是 fact，rerun/repair/block 由 policy 决定。

import type { FactCell } from './factCell'
import type { FactCellValue } from './facts'
import { gateCountsAsPass, type PipelineEvidenceManifestV1 } from './pipelineManifest'

function known(value: FactCellValue, sourceRevision: string): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision }
}

/**
 * manifest → pipeline facts cells。requiredGateKeys 来自 policy.pipeline.gates
 * （required=true 的 gateKey 集）——manifest 自带的 required 标记只是 adapter
 * 的转述，policy 才是 required 集的权威（两者不一致时以 policy 为准）。
 */
export function projectPipelineCells(
  manifest: PipelineEvidenceManifestV1,
  requiredGateKeys: readonly string[],
  sourceRevision: string,
): Record<string, FactCell<FactCellValue>> {
  const byKey = new Map(manifest.gates.map((gate) => [gate.gateKey, gate]))
  const missing: string[] = []
  const failing: string[] = []
  const categories = new Set<string>()
  let allPass = manifest.completeness === 'complete'
  for (const key of requiredGateKeys) {
    const gate = byKey.get(key)
    if (gate === undefined) {
      missing.push(key)
      allPass = false
      continue
    }
    for (const category of gate.failureCategories) categories.add(category)
    if (gateCountsAsPass(gate.status)) continue
    allPass = false
    // queued/running 是「还没有结论」，既非 missing 也非 failing（deadline
    // 语义由 anyRunning + policy wait 兜）；其余非 pass 终态都算 failing。
    if (gate.status !== 'queued' && gate.status !== 'running') failing.push(key)
  }
  const anyRunning = manifest.gates.some(
    (gate) => gate.status === 'queued' || gate.status === 'running',
  )
  const sorted = (xs: string[]): string[] => [...new Set(xs)].sort()
  return {
    'pipeline.completeness': known(manifest.completeness, sourceRevision),
    'pipeline.requiredGatesAllPass': known(allPass, sourceRevision),
    'pipeline.failingRequiredGateKeys': known(sorted(failing), sourceRevision),
    'pipeline.failureCategories': known([...categories].sort(), sourceRevision),
    'pipeline.missingRequiredGateKeys': known(sorted(missing), sourceRevision),
    'pipeline.anyRunning': known(anyRunning, sourceRevision),
    '__pipeline.bundleRef': known(manifest.bundleId, sourceRevision),
    '__pipeline.headSha': known(manifest.headSha, sourceRevision),
    '__pipeline.targetSha': known(manifest.targetSha, sourceRevision),
    '__pipeline.manifestDigest': known(manifest.manifestDigest, sourceRevision),
  }
}

export type PipelineFenceVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly code:
        | 'expected-head-mismatch'
        | 'provider-head-mismatch'
        | 'head-moved'
        | 'target-moved'
    }

/**
 * 两次 head fence（§6.2）：采集前后各读一次 code-host head/target，要求
 * H1=H2=providerHead=expectedHead 且 T1=T2；任何一条不成立都丢弃快照重采。
 * completeness='partial'（provider 无 head 绑定）时跳过 providerHead 对拍——
 * partial 的兜底在 facts 面（requiredGatesAllPass 恒 false），fence 只保证
 * code-host 侧没漂。判定优先级（测试锁定，按可达性排序——h1≠h2 必蕴含
 * 「至少一读≠expected」，故窗口内漂移必须先于 expected 对拍报出，否则
 * head-moved 永不可达）：head-moved > target-moved > expected-head-mismatch >
 * provider-head-mismatch。
 */
export function judgePipelineFence(input: {
  readonly h1: string
  readonly t1: string
  readonly h2: string
  readonly t2: string
  readonly providerHeadSha: string
  readonly expectedHeadSha: string
  readonly completeness: 'complete' | 'partial'
}): PipelineFenceVerdict {
  if (input.h1 !== input.h2) return { ok: false, code: 'head-moved' }
  if (input.t1 !== input.t2) return { ok: false, code: 'target-moved' }
  if (input.h1 !== input.expectedHeadSha) {
    return { ok: false, code: 'expected-head-mismatch' }
  }
  if (input.completeness === 'complete' && input.providerHeadSha !== input.expectedHeadSha) {
    return { ok: false, code: 'provider-head-mismatch' }
  }
  return { ok: true }
}
