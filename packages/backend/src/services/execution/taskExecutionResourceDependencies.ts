// RFC-345 T4a / RFC-359 W4-D27 —— 注入 Resource Catalog 的策略束。
//
// 合一后**快照适配器自己**取行映射器与可见性判据（同一 bounded context 内的 `*Persistence`
// 映射器 + `canViewResourceForTx`），所以策略束里只剩真正来自外部的策略。下面三个行映射器留在
// 这里只为一个消费者：`legacyTaskExecutionInjectionResolver.ts`（RFC-349 的行为神谕，生产不走它）
// ——它在 task-execution 里，直接 import 对方 infrastructure 会新增跨 context 内部边，所以照旧经
// 这条 services 层的装配边注入。该文件退役时这三行一并删。
// task-execution 消费方仍只拿到具名 public participant 与冻结快照。

import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { mcpFromPersistenceRow as rowToMcp } from '@/modules/resource-catalog/infrastructure/mcpPersistence'
import { pluginFromPersistenceRow as rowToPlugin } from '@/modules/resource-catalog/infrastructure/pluginPersistence'
import { assertNotBuiltin } from '@/services/systemResources'
import { isSkillInjectableThisBoot } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { skillFilesRel } from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import {
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
} from '@/services/runtime/injectionIdentity'
import { PLUGIN_DISABLED_ERROR_CODE } from '@/services/execution/resourcePolicy'
import { pickCallTarget } from '@/services/execution/callRefTarget'

export const taskExecutionResourceDependencies = Object.freeze({
  rowToAgent,
  rowToMcp,
  rowToPlugin,
  assertNotBuiltin,
  isSkillInjectableThisBoot,
  skillFilesRel,
  findManagedInjectionNameConflict,
  formatManagedInjectionNameConflict,
  pluginDisabledErrorCode: PLUGIN_DISABLED_ERROR_CODE,
  pickCallTarget,
})
