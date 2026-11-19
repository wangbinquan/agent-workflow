// RFC-508（RFC-294 S10 第十五步）—— 流水线证据端口的选定实现：每个操作先分配一份暂存、核对它属于该工厂的命名空间，再带着暂存引用
// 调用选定的执行面；collect 失败时先关闭暂存再返回失败，成功时把暂存连同清理函数交给调用方；trigger 与 rerun 在 finally 里关闭暂存。
// 三个暂存工厂在创建时逐个核对。

import type { PipelineStagingFactories } from './ports/evidenceStaging'
import type {
  PipelineEvidencePort,
  SelectedPipelineEvidenceRunnerPort,
} from './ports/reconcilerPorts'
import { assertEvidenceStagingFactory, assertEvidenceStagingLease } from './evidenceStaging'

export function createSelectedPipelineEvidence(
  runner: SelectedPipelineEvidenceRunnerPort,
  staging: PipelineStagingFactories,
): PipelineEvidencePort {
  type RunnerFailure = Extract<
    Awaited<ReturnType<typeof runner.collect>>,
    { readonly ok: false }
  >['failure']
  const failed = (failure: RunnerFailure) => ({ ok: false as const, failure })
  for (const factory of [staging.collect, staging.trigger, staging.rerun])
    assertEvidenceStagingFactory(factory)
  return {
    async collect(input) {
      const allocation = staging.collect.create()
      const parent = 'then' in allocation ? await allocation : allocation
      assertEvidenceStagingLease(parent, staging.collect.namespace)
      const out = await runner.collect({ ...input, staging: parent.reference })
      if (!out.ok) {
        const closed = parent.close()
        if (closed !== undefined) await closed
        return failed(out.failure)
      }
      return {
        ok: true,
        envelope: out.envelope,
        staging: parent,
        outputBudget: out.outputBudget,
        cleanup: () => parent.close(),
      }
    },
    async trigger(input) {
      const allocation = staging.trigger.create()
      const parent = 'then' in allocation ? await allocation : allocation
      assertEvidenceStagingLease(parent, staging.trigger.namespace)
      try {
        const out = await runner.trigger({ ...input, staging: parent.reference })
        if (!out.ok) return failed(out.failure)
        return {
          ok: true,
          runRef: out.envelope.runRef,
          providerReceiptRef: out.envelope.providerReceiptRef,
          adopted: out.envelope.adopted,
        }
      } finally {
        const closed = parent.close()
        if (closed !== undefined) await closed
      }
    },
    async rerun(input) {
      const allocation = staging.rerun.create()
      const parent = 'then' in allocation ? await allocation : allocation
      assertEvidenceStagingLease(parent, staging.rerun.namespace)
      try {
        const out = await runner.rerun({ ...input, staging: parent.reference })
        if (!out.ok) return failed(out.failure)
        return {
          ok: true,
          runRef: out.envelope.runRef,
          attempt: out.envelope.attempt,
          providerReceiptRef: out.envelope.providerReceiptRef,
        }
      } finally {
        const closed = parent.close()
        if (closed !== undefined) await closed
      }
    },
  }
}
