// RFC-345 T4a / RFC-359 W4-D27 —— 注入 Resource Catalog 的策略束。
//
// 合一后快照适配器自己取行映射器、可见性判据与本 context 的两个判定（`assertNotBuiltin`、`isSkillInjectableThisBoot`），
// 所以策略束里只剩真正来自外部的策略：runtime 的托管注入同名冲突判定与 shared 的调用目标选择。
// RFC-477：停用资源策略迁进 resource-catalog 后插件禁用错误码就是它自己的，快照适配器直接取定义处，这一格退出策略束。
// RFC-467：原先只为 RFC-349 行为神谕（`legacyTaskExecutionInjectionResolver`）留着的三个行映射器随神谕迁入用例树而删除。
// task-execution 消费方仍只拿到具名 public participant 与冻结快照。
// RFC-492：运行时驱动一族迁入 runtime-management 的 infrastructure，本策略束随之从 `services/execution/` 迁到 bootstrap——它把
// 运行时与 shared 的函数拼成 resource-catalog 的端口，是装配；运行时的两个判定经 runtime-management 的 composition 取。

import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '@/modules/runtime-management/composition/runtimeDrivers'
import { pickCallTarget } from '@agent-workflow/shared'

export const taskExecutionResourceDependencies = Object.freeze({
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
  pickCallTarget,
})
