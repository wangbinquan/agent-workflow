// RFC-310 PR-4 T47 —— workspace validator。RFC-496：校验逻辑迁入 application/workspaceValidator.ts（只经工作区效果端口
// 读文件）；这里只留“调用方没给实现时选本机实现”的两个包装，远端树操作照旧优先、交给 application 的同名函数。

import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import {
  businessTreeSnapshot as selectedBusinessTreeSnapshot,
  validateWorkspaceOutcome as validateSelectedWorkspaceOutcome,
  type WorkspaceValidationInput,
  type WorkspaceValidationOutcome,
} from '../application/workspaceValidator'
import { selectedAutomationWorkspaceEffects } from './automationWorkspaceEffects'

// RFC-496 design §8：taskImageWorkspace 归 RFC-370 余项、逐个避让，照旧从这里取；它改取 application 后删去。
export {
  reviveWorkspaceValidationInput,
  type SerializedWorkspaceValidationInput,
} from '../application/workspaceValidator'

export async function businessTreeSnapshot(
  root: string,
  factory?: AutomationWorkspaceEffectsFactory,
): Promise<Map<string, string>> {
  return selectedBusinessTreeSnapshot(
    root,
    factory?.treeOperations === undefined ? selectedAutomationWorkspaceEffects(factory) : factory,
  )
}

export async function validateWorkspaceOutcome(
  input: WorkspaceValidationInput,
  factory?: AutomationWorkspaceEffectsFactory,
): Promise<WorkspaceValidationOutcome> {
  return validateSelectedWorkspaceOutcome(
    input,
    factory?.treeOperations === undefined ? selectedAutomationWorkspaceEffects(factory) : factory,
  )
}
