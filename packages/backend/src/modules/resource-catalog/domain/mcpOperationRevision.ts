// RFC-455：自 `services/mcpOperationRevision.ts` 迁入；intent 的清单经 resource-catalog `public/queries` 取。
import { createHash } from 'node:crypto'
import {
  mcpOperationConfigHashWith,
  type Mcp,
  type McpOperationResource,
} from '@agent-workflow/shared'

export function mcpOperationConfigHashOf(mcp: Mcp): string {
  return mcpOperationConfigHashWith(mcp, (canonical) =>
    createHash('sha256').update(canonical, 'utf8').digest('hex'),
  )
}

export function withMcpOperationConfigHash(mcp: Mcp): McpOperationResource {
  return { ...mcp, operationConfigHash: mcpOperationConfigHashOf(mcp) }
}
