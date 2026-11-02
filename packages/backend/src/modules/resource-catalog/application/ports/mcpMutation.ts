// RFC-401 A2 —— MCP 的唯一写入参与者合同（design §9.3）。
//
// 普通 CRUD、Intent 与资源包都经它写 MCP：配置校验、类型不可变、stale、语义 no-op、运行时测试会话的失效意图与名称冲突
// 只有一份实现，错误以普通编辑现行行为为准。场景只保留自己的规则：Intent 的 owner-only 与 OAuth 回填（模型改写时省略的
// `oauth` 沿用库里的值），资源包的已选基线。

import type { CreateMcp, Mcp } from '@agent-workflow/shared'

export interface McpPatch {
  readonly type?: Mcp['type']
  readonly description?: string
  readonly enabled?: boolean
  /** 提交的配置整份替换库里的配置。 */
  readonly config?: unknown
}

export interface McpCreateMutation {
  readonly id: string
  readonly ownerUserId: string
  readonly input: CreateMcp
}

export interface McpUpdateMutation {
  readonly id: string
  readonly expectedConfigHash: string
  /** 场景规则，在 fence 之前对当前行执行。 */
  readonly guard?: (current: Mcp) => void
  /** 由场景按当前行生成 patch。 */
  readonly patch: (current: Mcp) => McpPatch
  /** 本次写入的 updatedAt；语义 no-op 也会取一次（RFC-201 的因果时钟观测）。 */
  readonly nextUpdatedAt?: (current: Mcp) => number | Promise<number>
}

/** 绑定在调用方事务上的 MCP 写入；全部 SQL 在该事务上执行。 */
export interface McpMutationParticipant {
  create(input: McpCreateMutation): Promise<Mcp>
  update(input: McpUpdateMutation): Promise<Mcp>
}
