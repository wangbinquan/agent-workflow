// RFC-310 T58 余项 —— verification 结果的 catalog fact 投影。
//
// 此前 verification 只往 `__delivery.verifiedProfiles` 这类内部 cells 里写，规则
// 谓词读不到（`__` 前缀的 cell 不进 catalog、也不进 prompt 摘要）。后果是
// `verification.repair` 这条能力**存在却永远排不上**：无论跑挂了什么，发布链一律
// 以 typed block `verification-failed:<profile>` 收场，组织连「失败就派修复」这条
// 最基本的规则都写不出来。
//
// 投影口径与 pipeline 那组保持一致（同为「平台自采的门禁结果」）：
//   - `allRequiredPassed`：**policy 要求的**每个 profile 都 passed 才为 true。没跑完
//     的算 false——「还没跑」不是「通过了」，这条在 pipeline 那边同样是硬边界。
//   - `failedProfileRefs`：只收 failed，不含未跑的。要区分「跑挂了」与「还没跑」，
//     前者进这个集合，后者体现在 `allRequiredPassed=false` 而集合为空。
//   - `lastOutcome`：一个 profile 都没结果时是 `not-run`；有任一 failed 是 `failed`；
//     否则 `passed`。注意它描述的是**已有结果**的整体成色，与 required 无关——
//     required 的覆盖度由 `allRequiredPassed` 表达，两者不要混。

import type { FactCell } from './factCell'
import type { FactCellValue } from './facts'

export type VerifiedProfileState = 'passed' | 'failed'

function known(value: FactCellValue, sourceRevision: string): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision }
}

export function projectVerificationCells(
  verified: Readonly<Record<string, VerifiedProfileState>>,
  requiredProfileRefs: readonly string[],
  sourceRevision: string,
): Record<string, FactCell<FactCellValue>> {
  const failed = Object.entries(verified)
    .filter(([, state]) => state === 'failed')
    .map(([ref]) => ref)
    .sort()
  const anyResult = Object.keys(verified).length > 0
  const allRequiredPassed =
    requiredProfileRefs.length > 0 && requiredProfileRefs.every((ref) => verified[ref] === 'passed')
  return {
    'verification.lastOutcome': known(
      !anyResult ? 'not-run' : failed.length > 0 ? 'failed' : 'passed',
      sourceRevision,
    ),
    'verification.allRequiredPassed': known(allRequiredPassed, sourceRevision),
    'verification.failedProfileRefs': known(failed, sourceRevision),
  }
}
