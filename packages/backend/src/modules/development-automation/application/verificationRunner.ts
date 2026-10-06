import { sha256Hex } from '@/util/hash'
import type { VerificationProfileContent } from '../domain/verificationProfile'
import type {
  VerificationCommandEffects,
  VerificationRunReceipt,
  VerificationStep,
  VerificationStepResult,
} from './ports/verificationCommandEffects'

async function runStep(
  effects: VerificationCommandEffects,
  workspacePath: string,
  step: VerificationStep,
): Promise<VerificationStepResult> {
  const started = Date.now()
  const resolved = await effects.resolveProgram({
    programRef: step.programRef,
    argsRef: step.argsRef,
    workspaceRef: workspacePath,
  })
  if (resolved === null) {
    return {
      stepId: step.stepId,
      ok: false,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      outputTailRef: null,
      evidenceFiles: [],
    }
  }

  const { exitCode, timedOut, outputTailRef } = await effects.execute({
    program: resolved,
    workspaceRef: workspacePath,
    step,
  })

  const evidenceFiles: VerificationStepResult['evidenceFiles'][number][] = []
  for (const selector of step.evidenceSelectors) {
    if (selector.kind === 'file-glob') {
      evidenceFiles.push(
        ...(await effects.collectFiles({ workspaceRef: workspacePath, pattern: selector.value })),
      )
    }
    // stdout-tail selector：outputTailRef 已覆盖（value 只影响展示截取，首版
    // 统一 64KB cap——更小的 tail 由读侧裁剪）。
  }

  const ok = !timedOut && step.successExitCodes.includes(exitCode)
  return {
    stepId: step.stepId,
    ok,
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    outputTailRef,
    evidenceFiles,
  }
}

/**
 * 逐 step 串行执行（maxParallel 首版按 1 处理——verification 的确定性优先，
 * 并行化随后续批次）；stopPolicy=first-failure 时首个失败即停。
 */
export async function runVerificationProfileWithEffects(
  effects: VerificationCommandEffects,
  input: { readonly workspacePath: string; readonly profile: VerificationProfileContent },
): Promise<VerificationRunReceipt> {
  const steps: VerificationStepResult[] = []
  for (const step of input.profile.steps) {
    const result = await runStep(effects, input.workspacePath, step)
    steps.push(result)
    if (!result.ok && input.profile.stopPolicy === 'first-failure') break
  }
  const ok = steps.length === input.profile.steps.length && steps.every((s) => s.ok)
  const receiptDigest = sha256Hex(
    JSON.stringify(
      steps.map((s) => ({
        stepId: s.stepId,
        ok: s.ok,
        exitCode: s.exitCode,
        timedOut: s.timedOut,
        outputTailRef: s.outputTailRef,
        evidenceFiles: s.evidenceFiles,
      })),
    ),
  )
  return { ok, stopPolicy: input.profile.stopPolicy, steps, receiptDigest }
}
