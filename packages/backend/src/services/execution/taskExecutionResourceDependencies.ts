// RFC-345 T4a / RFC-359 W4-D27 —— 注入 Resource Catalog 的策略束。
//
// 合一后快照适配器自己取行映射器、可见性判据与本 context 的两个判定（`assertNotBuiltin`、`isSkillInjectableThisBoot`），
// 所以策略束里只剩真正来自外部的策略：runtime 的托管注入同名冲突判定、执行层的插件禁用错误码与 shared 的调用目标选择。
// RFC-467：原先只为 RFC-349 行为神谕（`legacyTaskExecutionInjectionResolver`）留着的三个行映射器随神谕迁入用例树而删除。
// task-execution 消费方仍只拿到具名 public participant 与冻结快照。

import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '@/services/runtime/injectionIdentity'
import { PLUGIN_DISABLED_ERROR_CODE } from '@/services/execution/resourcePolicy'
import { pickCallTarget } from '@agent-workflow/shared'

export const taskExecutionResourceDependencies = Object.freeze({
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
  pluginDisabledErrorCode: PLUGIN_DISABLED_ERROR_CODE,
  pickCallTarget,
})
