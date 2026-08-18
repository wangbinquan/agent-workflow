// RFC-310 PR-6 T64/T66 —— pipeline facts 投影与两次 head fence 判定。
//
// 锁：①只有明确 pass 折算通过——unknown/unavailable/canceled/skipped 一律
// 不通过且计入 failing；缺 run 的 required key 进 missing（语义分家：missing
// 走 trigger-if-missing、failing 走 rerun/repair）；queued/running 两个 set
// 都不进（还没有结论），由 anyRunning 兜；②completeness='partial' ⇒
// requiredGatesAllPass 恒 false；③fence 判定优先级按可达性：head-moved >
// target-moved > expected-head-mismatch > provider-head-mismatch（h1≠h2 必
// 蕴含至少一读≠expected，窗口漂移必须先报）；partial 跳过 providerHead 对拍。

import { describe, expect, test } from 'bun:test'

import {
  judgePipelineFence,
  projectPipelineCells,
} from '../src/modules/development-automation/domain/pipelineFacts'
import type { PipelineEvidenceManifestV1 } from '../src/modules/development-automation/domain/pipelineManifest'

const H = 'a'.repeat(40)
const T = 'b'.repeat(40)
const H2 = 'c'.repeat(40)

function gate(
  overrides: Partial<PipelineEvidenceManifestV1['gates'][number]> & { gateKey: string },
): PipelineEvidenceManifestV1['gates'][number] {
  return {
    required: true,
    status: 'pass',
    runRef: `run-${overrides.gateKey}`,
    attempt: 1,
    finishedAt: null,
    retryability: 'safe',
    failureCategories: [],
    evidenceFileIds: [],
    ...overrides,
  }
}

function manifest(
  gates: PipelineEvidenceManifestV1['gates'],
  completeness: 'complete' | 'partial' = 'complete',
): PipelineEvidenceManifestV1 {
  return {
    schemaVersion: 1,
    bundleId: 'bundle-1',
    providerKey: 'ci-mock',
    headSha: H,
    targetSha: T,
    completeness,
    gates,
    files: [],
    totals: { files: 0, bytes: 0 },
    redaction: 'complete',
    manifestDigest: 'd'.repeat(64),
  }
}

const value = (cells: Record<string, { state: string; value?: unknown }>, id: string): unknown =>
  cells[id]!.state === 'known' ? (cells[id] as { value: unknown }).value : undefined

describe('rfc310 pr6 T66 — pipeline facts projection', () => {
  test('pass/fail/missing/running matrix, partial veto, category union, internal cells', () => {
    // 全 pass + complete → allPass。
    const allPass = projectPipelineCells(
      manifest([gate({ gateKey: 'unit' }), gate({ gateKey: 'lint' })]),
      ['unit', 'lint'],
      'rev-1',
    )
    expect(value(allPass, 'pipeline.requiredGatesAllPass')).toBe(true)
    expect(value(allPass, 'pipeline.failingRequiredGateKeys')).toEqual([])
    expect(value(allPass, 'pipeline.missingRequiredGateKeys')).toEqual([])
    expect(value(allPass, 'pipeline.anyRunning')).toBe(false)
    expect(value(allPass, 'pipeline.completeness')).toBe('complete')
    expect(value(allPass, '__pipeline.bundleRef')).toBe('bundle-1')
    expect(value(allPass, '__pipeline.headSha')).toBe(H)
    expect(value(allPass, '__pipeline.targetSha')).toBe(T)
    expect(value(allPass, '__pipeline.manifestDigest')).toBe('d'.repeat(64))
    expect(allPass['pipeline.requiredGatesAllPass']).toMatchObject({ sourceRevision: 'rev-1' })

    // partial ⇒ 全 pass 也不放行（provider 无 head 绑定绝不判 pass）。
    const partial = projectPipelineCells(
      manifest([gate({ gateKey: 'unit' })], 'partial'),
      ['unit'],
      'rev-1',
    )
    expect(value(partial, 'pipeline.requiredGatesAllPass')).toBe(false)
    expect(value(partial, 'pipeline.completeness')).toBe('partial')

    // 非 pass 终态（fail/canceled/unknown/unavailable/skipped）→ failing；
    // 缺 run → missing；queued/running → 两 set 都不进 + anyRunning。
    const mixed = projectPipelineCells(
      manifest([
        gate({ gateKey: 'unit', status: 'fail', failureCategories: ['unit-test', 'compile'] }),
        gate({ gateKey: 'lint', status: 'canceled' }),
        gate({ gateKey: 'sast', status: 'unknown' }),
        gate({ gateKey: 'dast', status: 'unavailable' }),
        gate({ gateKey: 'docs', status: 'skipped' }),
        gate({
          gateKey: 'e2e',
          status: 'running',
          failureCategories: ['infrastructure-transient'],
        }),
        gate({ gateKey: 'extra-optional', status: 'queued', required: false }),
      ]),
      ['unit', 'lint', 'sast', 'dast', 'docs', 'e2e', 'ghost'],
      'rev-2',
    )
    expect(value(mixed, 'pipeline.requiredGatesAllPass')).toBe(false)
    expect(value(mixed, 'pipeline.failingRequiredGateKeys')).toEqual([
      'dast',
      'docs',
      'lint',
      'sast',
      'unit',
    ])
    expect(value(mixed, 'pipeline.missingRequiredGateKeys')).toEqual(['ghost'])
    // categories：required gate 并集、字典序去重（含 running gate 的转述）。
    expect(value(mixed, 'pipeline.failureCategories')).toEqual([
      'compile',
      'infrastructure-transient',
      'unit-test',
    ])
    expect(value(mixed, 'pipeline.anyRunning')).toBe(true)

    // policy required 集是权威：manifest 标 required=false 的 gate 只要在
    // policy required 集里就参与判定。
    const authority = projectPipelineCells(
      manifest([gate({ gateKey: 'unit', required: false, status: 'fail' })]),
      ['unit'],
      'rev-3',
    )
    expect(value(authority, 'pipeline.failingRequiredGateKeys')).toEqual(['unit'])
  })
})

describe('rfc310 pr6 T64 — two-phase head fence', () => {
  const base = {
    h1: H,
    t1: T,
    h2: H,
    t2: T,
    providerHeadSha: H,
    expectedHeadSha: H,
    completeness: 'complete' as const,
  }

  test('verdict matrix and reachable priority order', () => {
    expect(judgePipelineFence(base)).toEqual({ ok: true })
    // 采集窗口内 head 漂移（h1≠h2）最先报——即使两读都≠expected。
    expect(judgePipelineFence({ ...base, h1: H2, expectedHeadSha: 'f'.repeat(40) })).toEqual({
      ok: false,
      code: 'head-moved',
    })
    expect(judgePipelineFence({ ...base, t2: H2 })).toEqual({ ok: false, code: 'target-moved' })
    // 双读一致但不是要采的头。
    expect(judgePipelineFence({ ...base, expectedHeadSha: H2 })).toEqual({
      ok: false,
      code: 'expected-head-mismatch',
    })
    // provider 报的头与期望不符（complete 才检查）。
    expect(judgePipelineFence({ ...base, providerHeadSha: H2 })).toEqual({
      ok: false,
      code: 'provider-head-mismatch',
    })
    // partial：providerHead 无绑定语义，跳过该对拍；其余照常。
    expect(judgePipelineFence({ ...base, providerHeadSha: H2, completeness: 'partial' })).toEqual({
      ok: true,
    })
    expect(judgePipelineFence({ ...base, h1: H2, h2: H2, completeness: 'partial' })).toEqual({
      ok: false,
      code: 'expected-head-mismatch',
    })
  })
})
