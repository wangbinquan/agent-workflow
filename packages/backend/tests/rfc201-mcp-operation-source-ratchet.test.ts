// RFC-201 T10.1 — production callsite ratchet: MCP mutations/probe/ACL must
// stay on the stable-id coordinator and raw probe I/O must not regain name-only
// dedup below the exact-operation boundary.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '..', 'src')
const route = readFileSync(resolve(SRC, 'routes/mcps.ts'), 'utf8')
const aggregate = readFileSync(
  resolve(SRC, 'modules/resource-catalog/application/mcps/mcpApplication.ts'),
  'utf8',
)
const diagnostics = readFileSync(
  resolve(SRC, 'modules/resource-catalog/application/mcps/diagnosticsOperations.ts'),
  'utf8',
)
// RFC-448: the three probe endpoints' orchestration moved from the route into the
// resource-catalog probe use cases, and the raw probe into resource-catalog infrastructure;
// the ratchet follows the code.
const probeOperations = readFileSync(
  resolve(SRC, 'modules/resource-catalog/application/mcps/probeOperations.ts'),
  'utf8',
)
const rawProbe = readFileSync(
  resolve(SRC, 'modules/resource-catalog/infrastructure/mcpProbe.ts'),
  'utf8',
)

describe('RFC-201 MCP production callsite ratchet', () => {
  test('PUT/delete/rename/probe and generic ACL all use the stable-id coordinator', () => {
    // RFC-364: seven diagnostic operations moved to the real application owner;
    // the three remaining probe route locks and all aggregate locks remain.
    expect(probeOperations.match(/coordinator\.runExclusive/g)?.length).toBe(3)
    // The route itself no longer holds the coordinator; it delegates to the use cases.
    expect(route).not.toContain('mcpOperationCoordinator')
    expect(route).toContain('module.probes.probe(')
    expect(diagnostics.match(/coordinator\.runExclusive/g)?.length).toBe(7)
    expect(diagnostics.match(/const fresh = await visible\(request, resolved.id\)/g)?.length).toBe(
      2,
    )
    expect(aggregate.match(/coordinator\.runExclusive/g)?.length).toBe(3)
    expect(probeOperations).toContain('runDeduplicatedOperation')
    // RFC-349: the transport now consumes closed query/identity ports. Keep
    // the stable-id recheck without reintroducing the retired DbClient-shaped
    // ACL callback.
    expect(probeOperations).toContain(
      'const current = await queries.get(authority, { id: resolved.id })',
    )
    expect(probeOperations).toContain('const identity = await aclIdentity.load(resolved.id)')
    expect(probeOperations).not.toContain('loadById: (_db')
    // RFC-285 B5：路由的 stale 产出收编 staleConflictError helper——锁 helper 在场（比旧字面量锁更强：码+resource 字段单源）。
    expect(probeOperations).toContain("staleConflictError('mcp'")
    expect(probeOperations).toContain("'resource-operation-superseded'")
  })

  test('raw transport layer has no mutable-name Promise map', () => {
    expect(rawProbe).not.toMatch(/new Map<[^>]*Promise<ProbeResult>/)
    expect(rawProbe).not.toContain('inflight.get(mcp.name)')
  })
})
