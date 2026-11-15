// RFC-310 PR-4 T47 —— 受保护 roots 快照。RFC-496：快照逻辑迁入 application/protectedSnapshot.ts（只经工作区效果端口
// 读文件）；这里只留“调用方没给实现时选本机实现”的包装，远端树操作照旧优先、交给 application 的同名函数。

import type { AutomationWorkspaceEffectsFactory } from '../application/ports/automationWorkspaceEffects'
import {
  snapshotProtectedRoots as snapshotSelectedProtectedRoots,
  type ProtectedRootSnapshot,
  type readProtectedRootSnapshot,
} from '../application/protectedSnapshot'
import { selectedAutomationWorkspaceEffects } from './automationWorkspaceEffects'

// RFC-496 design §8：taskImageWorkspace 归 RFC-370 余项、逐个避让，照旧从这里取；它改取 application 后删去。
export { serializeProtectedRootSnapshot } from '../application/protectedSnapshot'

export async function snapshotProtectedRoots(
  roots: Record<string, string>,
  opts: Parameters<typeof readProtectedRootSnapshot>[1] = {},
  factory?: AutomationWorkspaceEffectsFactory,
): Promise<ProtectedRootSnapshot> {
  return snapshotSelectedProtectedRoots(
    roots,
    opts,
    factory?.treeOperations === undefined ? selectedAutomationWorkspaceEffects(factory) : factory,
  )
}
