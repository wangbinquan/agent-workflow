// RFC-310 PR-6 T63 —— pipeline-gate 执行适配（integration 所有）。
//
// requirementSourceAdapter 的 pipeline 半：把「已发布 pipeline-gate adapter
// binding + 一次操作」落成 runner 子进程调用，envelope/失败映射 closed 结果。
// 本文件只负责采集到 sink + 转述 envelope 事实；safe import、平台 manifest
// 生成与 digest 全在消费侧（development-automation 的 evidence importer）——
// adapter 自报的 file/digest 不作数。跨模块不 import：消费侧以结构同形的
// 窄函数依赖接住返回值（rfc294 preflight 禁止反向内部 import）。
//
// 成对约束的运行时半边：operations 未声明的操作在此拒绝（configuration）——
// 没有声明的 trigger/rerun 不会因为 executable 实际支持就变得可达（§3.3）。

import type { DevelopmentAdapterContent } from '@/modules/integration/domain/developmentAdapterDefinition'
import {
  runPipelineCollect,
  runPipelineRerun,
  runPipelineTrigger,
  type AdapterFailureReceipt,
  type pipelineCollectEnvelopeSchema,
  type pipelineRerunEnvelopeSchema,
  type pipelineTriggerEnvelopeSchema,
} from './developmentAdapterRunner'
import type { z } from 'zod'

export type PipelineEvidenceOutcome<T> =
  | { readonly ok: true; readonly envelope: T }
  | { readonly ok: false; readonly failure: AdapterFailureReceipt }

export interface PipelineEvidenceExecution {
  collect(input: {
    readonly adapterBindingRef: string
    readonly headSha: string
    readonly targetSha: string
    readonly gateKeys: readonly string[]
    readonly sinkPath: string
  }): Promise<
    PipelineEvidenceOutcome<z.infer<typeof pipelineCollectEnvelopeSchema>> & {
      readonly outputBudget?: {
        readonly maxFiles: number
        readonly maxFileBytes: number
        readonly maxTotalBytes: number
      }
    }
  >
  trigger(input: {
    readonly adapterBindingRef: string
    readonly headSha: string
    readonly gateKeys: readonly string[]
    readonly idempotencyKey: string
    readonly sinkPath: string
  }): Promise<PipelineEvidenceOutcome<z.infer<typeof pipelineTriggerEnvelopeSchema>>>
  rerun(input: {
    readonly adapterBindingRef: string
    readonly runRef: string
    readonly gateKey: string
    readonly headSha: string
    readonly idempotencyKey: string
    readonly sinkPath: string
  }): Promise<PipelineEvidenceOutcome<z.infer<typeof pipelineRerunEnvelopeSchema>>>
}

export interface PipelineEvidenceAdapterDeps {
  /** `id@revision` → 已发布 adapter 内容；未发布/不存在 → null。 */
  readonly resolveBinding: (adapterBindingRef: string) => DevelopmentAdapterContent | null
  /** 测试/装配注入的额外子进程 env（如 mock 上游 URL）；不含 daemon 环境。 */
  readonly extraEnv?: Record<string, string>
}

function fail(
  category: AdapterFailureReceipt['category'],
  code: string,
  retryability: AdapterFailureReceipt['retryability'],
  remediation: string,
): { ok: false; failure: AdapterFailureReceipt } {
  return {
    ok: false,
    failure: { category, code, retryability, attemptOrdinal: 0, remediation, evidenceRef: null },
  }
}

function resolveFor(
  deps: PipelineEvidenceAdapterDeps,
  adapterBindingRef: string,
  operation: 'collect' | 'trigger' | 'rerun',
):
  | { readonly ok: true; readonly content: DevelopmentAdapterContent }
  | { readonly ok: false; readonly failure: AdapterFailureReceipt } {
  const content = deps.resolveBinding(adapterBindingRef)
  if (content === null) {
    return fail(
      'configuration',
      'adapter-binding-unresolved',
      'after-configuration',
      `no published adapter content for ${adapterBindingRef}`,
    )
  }
  if (content.purpose !== 'pipeline-gate') {
    return fail(
      'configuration',
      'adapter-purpose-mismatch',
      'after-configuration',
      `adapter purpose is ${content.purpose}, expected pipeline-gate`,
    )
  }
  if (!content.operations.includes(operation)) {
    return fail(
      'configuration',
      'operation-not-declared',
      'after-configuration',
      `adapter does not declare operation ${operation}`,
    )
  }
  return { ok: true, content }
}

export function createPipelineEvidenceAdapter(
  deps: PipelineEvidenceAdapterDeps,
): PipelineEvidenceExecution {
  return {
    async collect(input) {
      const resolved = resolveFor(deps, input.adapterBindingRef, 'collect')
      if (!resolved.ok) return resolved
      const run = await runPipelineCollect({
        adapterContent: resolved.content,
        operation: {
          kind: 'pipeline.collect',
          headSha: input.headSha,
          targetSha: input.targetSha,
          gateKeysCsv: input.gateKeys.join(','),
        },
        stagedRoot: input.sinkPath,
        extraEnv: deps.extraEnv,
      })
      if (!run.ok) return run
      return { ok: true, envelope: run.envelope, outputBudget: resolved.content.outputBudget }
    },

    async trigger(input) {
      const resolved = resolveFor(deps, input.adapterBindingRef, 'trigger')
      if (!resolved.ok) return resolved
      return await runPipelineTrigger({
        adapterContent: resolved.content,
        operation: {
          kind: 'pipeline.trigger',
          headSha: input.headSha,
          gateKeysCsv: input.gateKeys.join(','),
          idempotencyKey: input.idempotencyKey,
        },
        stagedRoot: input.sinkPath,
        extraEnv: deps.extraEnv,
      })
    },

    async rerun(input) {
      const resolved = resolveFor(deps, input.adapterBindingRef, 'rerun')
      if (!resolved.ok) return resolved
      return await runPipelineRerun({
        adapterContent: resolved.content,
        operation: {
          kind: 'pipeline.rerun',
          runRef: input.runRef,
          gateKey: input.gateKey,
          headSha: input.headSha,
          idempotencyKey: input.idempotencyKey,
        },
        stagedRoot: input.sinkPath,
        extraEnv: deps.extraEnv,
      })
    },
  }
}
