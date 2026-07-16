// RFC-201 T10.1 — production callsite ratchet: MCP mutations/probe/ACL must
// stay on the stable-id coordinator and raw probe I/O must not regain name-only
// dedup below the exact-operation boundary.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')
const route = readFileSync(resolve(SRC, 'routes/mcps.ts'), 'utf8')
const rawProbe = readFileSync(resolve(SRC, 'services/mcpProbe.ts'), 'utf8')

describe('RFC-201 MCP production callsite ratchet', () => {
  test('PUT/delete/rename/probe and generic ACL all use the stable-id coordinator', () => {
    expect(route.match(/mcpOperationCoordinator\.runExclusive/g)?.length).toBeGreaterThanOrEqual(5)
    expect(route).toContain('runDeduplicatedOperation')
    expect(route).toContain('loadById: (db, resourceId) => getMcpById(db, resourceId)')
    expect(route).toContain("'resource-operation-stale'")
    expect(route).toContain("'resource-operation-superseded'")
  })

  test('raw transport layer has no mutable-name Promise map', () => {
    expect(rawProbe).not.toMatch(/new Map<[^>]*Promise<ProbeResult>/)
    expect(rawProbe).not.toContain('inflight.get(mcp.name)')
  })
})
