// MCP-row projection shared by the natural OpenCode and Claude playgrounds.
// It validates transport syntax and keeps secret-bearing values in memory until
// the runtime adapter writes its ordinary per-turn config.

import { mkdir } from 'node:fs/promises'
import type { Mcp } from '@agent-workflow/shared'
import type { McpTestExecutionMaterial } from './types'

const SAFE_RUNTIME_KEY = /^[a-z0-9][a-z0-9_-]{0,127}$/

function frozenRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') Object.freeze(child)
  }
  return Object.freeze(value)
}

export interface PrepareMcpTestExecutionMaterialInput {
  mcp: Mcp
  root: string
}

export async function prepareMcpTestExecutionMaterial(
  input: PrepareMcpTestExecutionMaterialInput,
): Promise<McpTestExecutionMaterial> {
  if (!input.mcp.enabled || !SAFE_RUNTIME_KEY.test(input.mcp.name) || input.mcp.id.length === 0) {
    throw new Error('mcp-test-invalid-resource')
  }
  await mkdir(input.root, { recursive: true, mode: 0o700 })

  if (input.mcp.type === 'remote') {
    const endpoint = new URL(input.mcp.config.url)
    if (
      (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
      endpoint.username !== '' ||
      endpoint.password !== ''
    ) {
      throw new Error('mcp-test-invalid-remote-url')
    }
    return Object.freeze({
      codec: 'mcp-test-execution-material-v1',
      mcpId: input.mcp.id,
      runtimeKey: input.mcp.name,
      type: 'remote',
      opencodeEntry: frozenRecord({
        type: 'remote',
        enabled: true,
        url: input.mcp.config.url,
        ...(input.mcp.config.headers === undefined
          ? {}
          : { headers: { ...input.mcp.config.headers } }),
        ...(input.mcp.config.oauth === undefined ? {} : { oauth: input.mcp.config.oauth }),
        ...(input.mcp.config.timeoutMs === undefined
          ? {}
          : { timeout: input.mcp.config.timeoutMs }),
      }),
      claudeEntry: frozenRecord({
        type: 'http',
        url: input.mcp.config.url,
        ...(input.mcp.config.headers === undefined
          ? {}
          : { headers: { ...input.mcp.config.headers } }),
      }),
      root: input.root,
    })
  }

  const command = input.mcp.config.command
  if (command.length === 0 || command.some((part) => part.length === 0 || part.includes('\0'))) {
    throw new Error('mcp-test-invalid-local-command')
  }
  const authoredEnv = { ...(input.mcp.config.env ?? {}) }
  return Object.freeze({
    codec: 'mcp-test-execution-material-v1',
    mcpId: input.mcp.id,
    runtimeKey: input.mcp.name,
    type: 'local',
    opencodeEntry: frozenRecord({
      type: 'local',
      enabled: true,
      command: [...command],
      ...(Object.keys(authoredEnv).length === 0 ? {} : { environment: authoredEnv }),
      ...(input.mcp.config.timeoutMs === undefined ? {} : { timeout: input.mcp.config.timeoutMs }),
    }),
    claudeEntry: frozenRecord({
      command: command[0],
      args: command.slice(1),
      ...(Object.keys(authoredEnv).length === 0 ? {} : { env: authoredEnv }),
    }),
    root: input.root,
  })
}
