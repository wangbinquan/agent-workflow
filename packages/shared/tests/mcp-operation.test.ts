// RFC-201 T10.1 — exact MCP operation-revision projection/hash golden lock.

import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Mcp } from '../src/schemas/mcp'
import { McpOperationResourceSchema } from '../src/schemas/mcp'
import {
  mcpOperationConfigHashWith,
  projectMcpOperationConfigV1,
  serializeMcpOperationConfigV1,
} from '../src/mcp-operation'

function fixture(): Mcp {
  return {
    id: '01MCP',
    name: 'postgres',
    description: 'production database',
    ownerUserId: 'u1',
    visibility: 'private',
    aclRevision: 4,
    type: 'local',
    config: { command: ['uvx', 'postgres-mcp'], env: { Z: '2', A: '1' }, timeoutMs: 30_000 },
    enabled: true,
    schemaVersion: 1,
    createdAt: 100,
    updatedAt: 200,
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

describe('RFC-201 MCP exact operation revision', () => {
  test('projector explicitly locks every persisted MCP row field', () => {
    expect(Object.keys(projectMcpOperationConfigV1(fixture())).sort()).toEqual(
      [
        'id',
        'name',
        'description',
        'ownerUserId',
        'visibility',
        'aclRevision',
        'type',
        'config',
        'enabled',
        'schemaVersion',
        'createdAt',
        'updatedAt',
      ].sort(),
    )
  })

  test('canonicalizes nested config keys and domain-separates the hash', () => {
    const a = fixture()
    const b = { ...a, config: { ...a.config, env: { A: '1', Z: '2' } } } as Mcp
    expect(serializeMcpOperationConfigV1(a)).toBe(serializeMcpOperationConfigV1(b))
    expect(mcpOperationConfigHashWith(a, sha256)).toBe(
      '4eae45284e2eae6e04e421a50ba2462a1ca50ba9b1c720353aae1f535da4bf0e',
    )
    expect(mcpOperationConfigHashWith(a, sha256)).toBe(mcpOperationConfigHashWith(b, sha256))
  })

  test('every mutable row dimension changes the revision', () => {
    const base = fixture()
    const baseHash = mcpOperationConfigHashWith(base, sha256)
    const variants: Mcp[] = [
      { ...base, name: 'postgres-2' },
      { ...base, description: 'changed' },
      { ...base, ownerUserId: 'u2' },
      { ...base, visibility: 'public' },
      { ...base, aclRevision: 5 },
      { ...base, config: { command: ['other'] } },
      { ...base, enabled: false },
      { ...base, schemaVersion: 2 },
      { ...base, updatedAt: 201 },
    ]
    for (const variant of variants) {
      expect(mcpOperationConfigHashWith(variant, sha256)).not.toBe(baseHash)
    }
  })

  test('wire schema accepts the full resource plus its derived hash', () => {
    const mcp = fixture()
    const operationConfigHash = mcpOperationConfigHashWith(mcp, sha256)
    expect(McpOperationResourceSchema.parse({ ...mcp, operationConfigHash })).toEqual({
      ...mcp,
      operationConfigHash,
    })
  })
})
