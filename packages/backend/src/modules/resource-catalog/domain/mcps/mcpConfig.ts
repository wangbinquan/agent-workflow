// RFC-401 A2 —— MCP 配置按类型校验：唯一的 MCP 写入参与者调用（此前在普通编辑的 application 里）。
import { McpLocalConfigSchema, McpRemoteConfigSchema, type Mcp } from '@agent-workflow/shared'
import { ValidationError } from '@/util/errors'

export function validateMcpConfigForType(type: Mcp['type'], config: unknown): Mcp['config'] {
  const parsed = (type === 'local' ? McpLocalConfigSchema : McpRemoteConfigSchema).safeParse(config)
  if (!parsed.success) {
    throw new ValidationError('mcp-config-invalid', `mcp ${type} config is invalid`, {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}
