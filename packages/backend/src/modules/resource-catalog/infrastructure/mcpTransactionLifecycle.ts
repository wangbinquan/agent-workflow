// RFC-359 W4-D16 —— MCP 目录写事务里的运行时测试生命周期：一份实现，两个 provider 共用（此前 PG 单独一份，
// SQLite 由 bootstrap 注入 legacy 的同步函数）。只写持久意图，不开嵌套事务；daemon 清理仍是唯一的进程 / 文件系统所有者。

import type { McpTransactionLifecycle } from './mcpRepository'
import {
  deletePreparedMcpRuntimeTests,
  transitionMcpRuntimeTests,
} from './mcpRuntimeTestTransitions'

export function createMcpTransactionLifecycle(): McpTransactionLifecycle {
  const lifecycle: McpTransactionLifecycle = {
    transitionMutation: (transaction, input) => transitionMcpRuntimeTests(transaction, input),
    deletePrepared: (transaction, mcpId) => deletePreparedMcpRuntimeTests(transaction, mcpId),
  }
  return Object.freeze(lifecycle)
}
