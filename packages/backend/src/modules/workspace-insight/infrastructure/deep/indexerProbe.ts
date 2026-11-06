// RFC-083 PR-E — SCIP indexer discovery: `<bin> --version` on PATH (or a settings override), exactly like the
// daemon already finds `opencode` / `git`. RFC-453: split from the indexer registry (`domain/deep/indexers.ts`).

import { spawnVersionProbe } from '@/util/process'
import {
  isWindowsBatchShim,
  resolveIndexerBin,
  type DeepIndexerOverrides,
  type IndexerProbe,
  type IndexerSpec,
} from '../../domain/deep/indexers'

/** Probe `<bin> --version` (mirrors probeOpencode). Absent binary → available
 *  false, never throws. */
export async function probeIndexer(
  spec: IndexerSpec,
  overrides?: DeepIndexerOverrides,
): Promise<IndexerProbe> {
  const bin = resolveIndexerBin(spec, overrides)
  const resolved = Bun.which(bin)
  if (resolved !== null && isWindowsBatchShim(resolved)) {
    // Distinguishable on purpose: the operator has the tool, and the fix is to
    // point the override at the real executable next to the shim.
    return { available: false, bin, version: null, reason: 'shim-not-executable' }
  }
  try {
    // RFC-284 T17（审计 N21）：原实现无 deadline——HTTP 请求路径上一个等输入的
    // wrapper 可挂死结构化 diff（scriptRun impl-gate 3.4 修过的同款坑）。收编
    // spawnVersionProbe 探针形态（10s 上限 + 组杀 + exit 先行有界读）。
    const r = await spawnVersionProbe([bin, '--version'], { timeoutMs: 10_000 })
    if (r.timedOut || r.exitCode !== 0)
      return { available: false, bin, version: null, reason: 'version-probe-failed' }
    return { available: true, bin, version: r.stdout.trim().split('\n')[0] ?? null }
  } catch {
    return { available: false, bin, version: null, reason: 'not-found' }
  }
}
